import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CommandBus } from '../src/bus/command-bus.js';
import { BudgetEnforcer } from '../src/budget/enforcer.js';
import { TokenLedger } from '../src/budget/ledger.js';
import { openDb } from '../src/db/client.js';
import { FakeLLMProvider, type FakeStep } from '../src/llm/fake.js';
import { DurableRunner } from '../src/runner/durable-runner.js';
import { ToolSummarizer, oneLine } from '../src/runner/tool-summary.js';
import type { CommandDefinition } from '../src/types.js';

const noopTool = (name: string): CommandDefinition<z.ZodObject<Record<string, never>>> => ({
  name,
  description: name,
  inputSchema: z.object({}),
  allowedActors: ['human', 'lead'],
  idempotent: true,
  execute: () => ({ ok: name }),
});

function harness(summaryScript: Array<{ type: 'text'; content: string }>) {
  const db = openDb({ path: ':memory:' });
  const ledger = new TokenLedger(db);
  const budget = new BudgetEnforcer(db);
  const bus = new CommandBus(db);
  bus.registerAll([noopTool('tool.a'), noopTool('tool.b')]);
  const summaryProvider = new FakeLLMProvider({
    script: summaryScript,
    providerName: 'cheap',
    model: 'ministral-3b-latest',
    tokensIn: 120,
    tokensOut: 12,
  });
  const summarizer = new ToolSummarizer({
    db,
    ledger,
    provider: summaryProvider,
    price: { in: 0.04, out: 0.04 },
    every: 2,
  });
  const pool = budget.createPool({ ownerKind: 'run', ownerId: 'r', amountUsd: 1 });

  const runner = (mainScript: FakeStep[]) => {
    const provider = new FakeLLMProvider({ script: mainScript, tokensIn: 100, tokensOut: 10 });
    return new DurableRunner({ db, bus, ledger, budget, provider, price: { in: 1, out: 1 }, summarizer });
  };
  return { db, ledger, bus, pool, summarizer, summaryProvider, runner };
}

const start = (poolId: string) => ({
  factoryId: 'f',
  goal: 'do two things',
  tier: 'B' as const,
  poolId,
  systemPrompt: 'sys',
  maxTurns: 5,
});

describe('ToolSummarizer', () => {
  it('summarizes a full batch of N tool calls and stores it', async () => {
    const h = harness([{ type: 'text', content: 'Read config.yaml, wrote index.ts.' }]);
    const runner = h.runner([
      { type: 'tool_call', name: 'tool.a', args: {}, callId: 'c1' },
      { type: 'tool_call', name: 'tool.b', args: {}, callId: 'c2' },
      { type: 'text', content: 'done' },
    ]);

    const run = await runner.startRun(start(h.pool.id));

    const summaries = h.summarizer.listForRun(run.id);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.summary).toBe('Read config.yaml, wrote index.ts.');
    expect(summaries[0]!.toolNames).toEqual(['tool.a', 'tool.b']);
    expect(summaries[0]!.model).toBe('ministral-3b-latest');

    // The summary shows up in the event log so the UI can render it inline.
    const ev = runner.getEvents(run.id).find((e) => e.type === 'tool_summary')!;
    expect((ev.payload as { summary: string }).summary).toBe('Read config.yaml, wrote index.ts.');
  });

  it('records the summary cost in the ledger under category tool_summary', async () => {
    const h = harness([{ type: 'text', content: 'summary' }]);
    const runner = h.runner([
      { type: 'tool_call', name: 'tool.a', args: {}, callId: 'c1' },
      { type: 'tool_call', name: 'tool.b', args: {}, callId: 'c2' },
      { type: 'text', content: 'done' },
    ]);
    const run = await runner.startRun(start(h.pool.id));

    const rows = h.ledger.listForRun(run.id);
    const summaryRows = rows.filter((r) => r.category === 'tool_summary');
    expect(summaryRows).toHaveLength(1);
    // observed separately from the work it describes
    expect(summaryRows[0]!.costUsd).toBeGreaterThan(0);
    const turnRows = rows.filter((r) => r.category === 'turn');
    expect(turnRows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.category === 'tool_summary')).toHaveLength(1);
  });

  it('does not summarize an incomplete batch', async () => {
    const h = harness([{ type: 'text', content: 'never used' }]);
    const runner = h.runner([
      { type: 'tool_call', name: 'tool.a', args: {}, callId: 'c1' },
      { type: 'text', content: 'done' },
    ]);
    const run = await runner.startRun(start(h.pool.id));
    expect(h.summarizer.listForRun(run.id)).toHaveLength(0);
    // and the summarizer model was never called (no wasted spend)
    expect(h.summaryProvider.requests).toHaveLength(0);
  });

  it('does not re-summarize the same batch on resume (idempotent by seq)', async () => {
    const h = harness([
      { type: 'text', content: 'first summary' },
      { type: 'text', content: 'should not be used' },
    ]);
    const runner = h.runner([
      { type: 'tool_call', name: 'tool.a', args: {}, callId: 'c1' },
      { type: 'tool_call', name: 'tool.b', args: {}, callId: 'c2' },
      { type: 'text', content: 'done' },
    ]);
    const run = await runner.startRun(start(h.pool.id));
    expect(h.summarizer.listForRun(run.id)).toHaveLength(1);

    // Simulate a restart: a fresh summarizer over the same db. It must know
    // where the last summary ended, so history is not summarized twice.
    const again = new ToolSummarizer({
      db: h.db,
      ledger: h.ledger,
      provider: h.summaryProvider,
      price: { in: 0.04, out: 0.04 },
      every: 2,
    });
    const lastEnd = h.summarizer.listForRun(run.id)[0]!.batchEnd;
    expect(again.lastSummarizedSeq(run.id)).toBe(lastEnd);
    const activity = [
      { seq: lastEnd - 2, name: 'tool.a', status: 'ok' },
      { seq: lastEnd, name: 'tool.b', status: 'ok' },
    ];
    expect(await again.maybeSummarize(run.id, activity)).toBeNull();
    // and the provider was NOT called a second time
    expect(h.summaryProvider.requests).toHaveLength(1);
  });

  it('a summarizer failure never fails the run', async () => {
    const h = harness([]); // empty script -> provider throws when called
    const runner = h.runner([
      { type: 'tool_call', name: 'tool.a', args: {}, callId: 'c1' },
      { type: 'tool_call', name: 'tool.b', args: {}, callId: 'c2' },
      { type: 'text', content: 'done' },
    ]);
    const run = await runner.startRun(start(h.pool.id));

    // The run completes on its own merits...
    expect(run.status).toBe('completed');
    // ...and the tool work is still fully visible in the log...
    expect(runner.getEvents(run.id).filter((e) => e.type === 'tool_result')).toHaveLength(2);
    // ...while no partial/garbage summary was written.
    expect(h.summarizer.listForRun(run.id)).toHaveLength(0);
  });

  it('clamps a multi-line summary to a single line', async () => {
    const h = harness([{ type: 'text', content: 'line one\nline two\n\n  line three  ' }]);
    const runner = h.runner([
      { type: 'tool_call', name: 'tool.a', args: {}, callId: 'c1' },
      { type: 'tool_call', name: 'tool.b', args: {}, callId: 'c2' },
      { type: 'text', content: 'done' },
    ]);
    const run = await runner.startRun(start(h.pool.id));
    const summary = h.summarizer.listForRun(run.id)[0]!.summary;
    expect(summary).not.toContain('\n');
    expect(summary).toBe('line one line two line three');
  });
});

describe('oneLine', () => {
  it('collapses whitespace', () => {
    expect(oneLine('  a\n\n b \t c ')).toBe('a b c');
  });
  it('truncates with an ellipsis at the limit', () => {
    const out = oneLine('x'.repeat(300), 50);
    expect(out).toHaveLength(50);
    expect(out.endsWith('…')).toBe(true);
  });
  it('handles empty output explicitly instead of returning a blank string', () => {
    expect(oneLine('   ')).toBe('(no output)');
  });
});
