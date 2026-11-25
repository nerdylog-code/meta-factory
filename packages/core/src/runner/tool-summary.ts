import type { Db } from '../db/client.js';
import { roundMoney } from '../budget/money.js';
import type { TokenLedger } from '../budget/ledger.js';
import type { LlmProvider } from '../llm/types.js';
import type { Tier } from '../types.js';

export interface ToolSummaryRecord {
  runId: string;
  batchStart: number;
  batchEnd: number;
  summary: string;
  toolNames: string[];
  model: string;
  costUsd: number;
}

export const DEFAULT_TOOL_SUMMARY_PROMPT = `You compress agent tool activity into ONE short line for a human supervisor.
Rules:
- At most 140 characters.
- Plain past tense, no markdown, no bullet points, no preamble.
- Say what happened, not that something happened: "Read config.yaml, wrote index.ts, ran tests (2 failed)".
- If a tool failed, say so plainly.`;

export interface ToolSummaryOptions {
  ledger: TokenLedger;
  db: Db;
  /** Model used for summaries. Should be the cheapest available tier. */
  provider: LlmProvider;
  tier?: Tier;
  price: { in: number; out: number };
  /** Summarize every N tool calls. */
  every: number;
  /** Category written to the ledger. */
  category?: 'tool_summary';
  prompt?: string;
  maxOutputTokens?: number;
}

export interface ToolActivity {
  seq: number;
  name: string;
  status: string;
  input?: unknown;
  result?: unknown;
  error?: string;
}

/**
 * Turns batches of tool calls into one-line human-readable summaries.
 *
 * Two properties that matter:
 * - The cost of summarizing is recorded in the ledger with its own category, so
 *   Tokenomics can show the price of observability separately from the price of
 *   work.
 * - Failure to summarize NEVER fails the run. A summary is a courtesy to the
 *   human; the event log is the source of truth. On error we return null and
 *   leave a row behind only if the call actually cost something.
 */
export class ToolSummarizer {
  private readonly opts: {
    tier: Tier;
    category: 'tool_summary';
    prompt: string;
    maxOutputTokens: number;
    every: number;
    price: { in: number; out: number };
    db: Db;
    ledger: TokenLedger;
    provider: LlmProvider;
  };

  constructor(opts: ToolSummaryOptions) {
    if (opts.every < 1) throw new Error('ToolSummarizer.every must be >= 1');
    this.opts = {
      tier: opts.tier ?? 'D',
      category: opts.category ?? 'tool_summary',
      prompt: opts.prompt ?? DEFAULT_TOOL_SUMMARY_PROMPT,
      maxOutputTokens: opts.maxOutputTokens ?? 96,
      every: opts.every,
      price: opts.price,
      db: opts.db,
      ledger: opts.ledger,
      provider: opts.provider,
    };
  }

  get batchSize(): number {
    return this.opts.every;
  }

  /** Last summarized seq for a run, so a resume does not re-summarize history. */
  lastSummarizedSeq(runId: string): number {
    const row = this.opts.db
      .prepare(`SELECT COALESCE(MAX(batch_end), 0) AS last FROM tool_summaries WHERE run_id = ?`)
      .get(runId) as { last: number };
    return row.last;
  }

  listForRun(runId: string): ToolSummaryRecord[] {
    const rows = this.opts.db
      .prepare(`SELECT * FROM tool_summaries WHERE run_id = ? ORDER BY batch_end ASC`)
      .all(runId) as RawSummary[];
    return rows.map((r) => ({
      runId: r.run_id,
      batchStart: r.batch_start,
      batchEnd: r.batch_end,
      summary: r.summary,
      toolNames: JSON.parse(r.tool_names) as string[],
      model: r.model,
      costUsd: r.cost_usd,
    }));
  }

  /**
   * Summarizes `activity` if it contains a full batch beyond the last one
   * already summarized. Returns the new record, or null when nothing to do.
   */
  async maybeSummarize(runId: string, activity: ToolActivity[]): Promise<ToolSummaryRecord | null> {
    const last = this.lastSummarizedSeq(runId);
    const pending = activity.filter((a) => a.seq > last);
    if (pending.length < this.opts.every) return null;

    const batch = pending.slice(0, this.opts.every);
    const batchEnd = batch[batch.length - 1]!.seq;
    const batchStart = pending[0]!.seq;

    const lines = batch.map((a) => {
      const args = a.input === undefined ? '' : JSON.stringify(a.input).slice(0, 160);
      const out =
        a.status === 'ok'
          ? JSON.stringify(a.result ?? null).slice(0, 200)
          : `${a.status}${a.error ? ': ' + a.error : ''}`;
      return `- ${a.name}(${args}) -> ${out}`;
    });

    let summary: string;
    let cost = 0;
    try {
      const res = await this.opts.provider.complete({
        tier: this.opts.tier,
        messages: [
          { role: 'system', content: this.opts.prompt },
          { role: 'user', content: `Summarize these ${batch.length} tool calls:\n${lines.join('\n')}` },
        ],
        maxOutputTokens: this.opts.maxOutputTokens,
        temperature: 0,
        category: 'tool_summary',
      });
      summary = oneLine(res.content);
      cost = roundMoney(
        (res.usage.tokensIn / 1_000_000) * this.opts.price.in + (res.usage.tokensOut / 1_000_000) * this.opts.price.out,
      );

      // The summary's own spend is part of the factory's spend.
      this.opts.ledger.record({
        runId,
        provider: res.provider,
        model: res.model,
        tier: this.opts.tier,
        unitPriceInUsd: this.opts.price.in,
        unitPriceOutUsd: this.opts.price.out,
        tokensIn: res.usage.tokensIn,
        tokensOut: res.usage.tokensOut,
        isEstimated: res.usage.estimated,
        aborted: res.aborted,
        category: this.opts.category,
      });
    } catch (err) {
      // Observability must never break the run.
      console.warn('[tool-summary] failed, continuing:', (err as Error).message);
      return null;
    }

    const toolNames = [...new Set(batch.map((b) => b.name))];
    this.opts.db
      .prepare(
        `INSERT INTO tool_summaries (run_id, batch_start, batch_end, summary, tool_names, model, cost_usd, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        runId,
        batchStart,
        batchEnd,
        summary,
        JSON.stringify(toolNames),
        this.opts.provider.model,
        cost,
        Date.now(),
      );

    return { runId, batchStart, batchEnd, summary, toolNames, model: this.opts.provider.model, costUsd: cost };
  }
}

/** Collapses newlines and clamps length so the UI never reflows. */
export function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '(no output)';
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

interface RawSummary {
  run_id: string;
  batch_start: number;
  batch_end: number;
  summary: string;
  tool_names: string;
  model: string;
  cost_usd: number;
}
