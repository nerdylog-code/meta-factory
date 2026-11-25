import type { Db } from '../db/client.js';
import { costUsd, roundMoney } from './money.js';

export type LedgerCategory =
  | 'turn'
  | 'tool_summary'
  | 'classifier'
  | 'subagent'
  | 'compaction'
  | 'embedding'
  | 'other';

export interface LedgerEntry {
  runId?: string | null;
  agentId?: string | null;
  subagentId?: string | null;
  poolId?: string | null;
  provider: string;
  model: string;
  tier: string;
  unitPriceInUsd: number;
  unitPriceOutUsd: number;
  tokensIn: number;
  tokensOut: number;
  isEstimated?: boolean;
  aborted?: boolean;
  category: LedgerCategory;
  turn?: number | null;
}

export interface LedgerRow extends Required<Omit<LedgerEntry, 'runId' | 'agentId' | 'subagentId' | 'poolId' | 'turn'>> {
  id: number;
  runId: string | null;
  agentId: string | null;
  subagentId: string | null;
  poolId: string | null;
  turn: number | null;
  costUsd: number;
  createdAt: number;
}

export interface TokenomicsSummary {
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  estimatedCostUsd: number;
  abortedCostUsd: number;
  byCategory: Record<string, { costUsd: number; tokensIn: number; tokensOut: number; calls: number }>;
  byModel: Record<string, { costUsd: number; tokensIn: number; tokensOut: number; calls: number }>;
}

const now = () => Date.now();

/**
 * Append-only token accounting. Every row snapshots the price that was in
 * effect at call time so a later price change never rewrites history.
 */
export class TokenLedger {
  constructor(private readonly db: Db) {}

  record(entry: LedgerEntry): number {
    const cost = costUsd(entry.tokensIn, entry.tokensOut, entry.unitPriceInUsd, entry.unitPriceOutUsd);
    const info = this.db
      .prepare(
        `INSERT INTO token_ledger
          (run_id, agent_id, subagent_id, pool_id, provider, model, tier,
           unit_price_in_usd, unit_price_out_usd, tokens_in, tokens_out, cost_usd,
           is_estimated, aborted, category, turn, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        entry.runId ?? null,
        entry.agentId ?? null,
        entry.subagentId ?? null,
        entry.poolId ?? null,
        entry.provider,
        entry.model,
        entry.tier,
        entry.unitPriceInUsd,
        entry.unitPriceOutUsd,
        entry.tokensIn,
        entry.tokensOut,
        cost,
        entry.isEstimated ? 1 : 0,
        entry.aborted ? 1 : 0,
        entry.category,
        entry.turn ?? null,
        now(),
      );
    return Number(info.lastInsertRowid);
  }

  listForRun(runId: string): LedgerRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM token_ledger WHERE run_id = ? ORDER BY id ASC`)
      .all(runId) as RawLedgerRow[];
    return rows.map(mapRow);
  }

  listRecent(limit = 100): LedgerRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM token_ledger ORDER BY id DESC LIMIT ?`)
      .all(limit) as RawLedgerRow[];
    return rows.map(mapRow);
  }

  /** Aggregates for the live Tokenomics bar. */
  summary(filter: { runId?: string } = {}): TokenomicsSummary {
    const where = filter.runId ? 'WHERE run_id = ?' : '';
    const params = filter.runId ? [filter.runId] : [];
    const rows = this.db.prepare(`SELECT * FROM token_ledger ${where}`).all(...params) as RawLedgerRow[];

    const out: TokenomicsSummary = {
      totalCostUsd: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      estimatedCostUsd: 0,
      abortedCostUsd: 0,
      byCategory: {},
      byModel: {},
    };

    for (const r of rows) {
      out.totalCostUsd = roundMoney(out.totalCostUsd + r.cost_usd);
      out.totalTokensIn += r.tokens_in;
      out.totalTokensOut += r.tokens_out;
      if (r.is_estimated) out.estimatedCostUsd = roundMoney(out.estimatedCostUsd + r.cost_usd);
      if (r.aborted) out.abortedCostUsd = roundMoney(out.abortedCostUsd + r.cost_usd);

      const cat = (out.byCategory[r.category] ??= { costUsd: 0, tokensIn: 0, tokensOut: 0, calls: 0 });
      cat.costUsd = roundMoney(cat.costUsd + r.cost_usd);
      cat.tokensIn += r.tokens_in;
      cat.tokensOut += r.tokens_out;
      cat.calls += 1;

      const model = (out.byModel[r.model] ??= { costUsd: 0, tokensIn: 0, tokensOut: 0, calls: 0 });
      model.costUsd = roundMoney(model.costUsd + r.cost_usd);
      model.tokensIn += r.tokens_in;
      model.tokensOut += r.tokens_out;
      model.calls += 1;
    }
    return out;
  }

  totalForPool(poolId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM token_ledger WHERE pool_id = ?`)
      .get(poolId) as { total: number };
    return roundMoney(row.total);
  }
}

interface RawLedgerRow {
  id: number;
  run_id: string | null;
  agent_id: string | null;
  subagent_id: string | null;
  pool_id: string | null;
  provider: string;
  model: string;
  tier: string;
  unit_price_in_usd: number;
  unit_price_out_usd: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  is_estimated: number;
  aborted: number;
  category: string;
  turn: number | null;
  created_at: number;
}

function mapRow(r: RawLedgerRow): LedgerRow {
  return {
    id: r.id,
    runId: r.run_id,
    agentId: r.agent_id,
    subagentId: r.subagent_id,
    poolId: r.pool_id,
    provider: r.provider,
    model: r.model,
    tier: r.tier,
    unitPriceInUsd: r.unit_price_in_usd,
    unitPriceOutUsd: r.unit_price_out_usd,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    isEstimated: r.is_estimated === 1,
    aborted: r.aborted === 1,
    category: r.category as LedgerCategory,
    turn: r.turn,
    costUsd: r.cost_usd,
    createdAt: r.created_at,
  };
}
