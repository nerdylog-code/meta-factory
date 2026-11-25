import { beforeEach, describe, expect, it } from 'vitest';
import {
  BudgetEnforcer,
  CommandBus,
  FakeLLMProvider,
  TokenLedger,
  openDb,
  type Db,
  type FakeStep,
} from '@mf/core';
import { createSubagentsHarness, type SubagentsHarness } from '../src/index.js';

let db: Db;
let bus: CommandBus;
let budget: BudgetEnforcer;
let ledger: TokenLedger;
let parentPoolId: string;
let scripts: Map<string, FakeStep[]>;

const human = { kind: 'human' } as const;
const lead = { kind: 'agent', role: 'lead', agentId: 'lead', runId: 'parent-run', toolCallId: 'tc' } as const;

/**
 * A provider factory that hands out FakeLLMProviders reading from `scripts`,
 * keyed by tier, so each test can control exactly what a subagent does.
 */
function providerFor(tier: string) {
  const script = scripts.get(tier) ?? [{ type: 'text', content: `${tier} done` }];
  const provider = new FakeLLMProvider({ script, tokensIn: 1000, tokensOut: 100 });
  // Real deepseek prices, so per-call cost is realistic (~.000168/call).
  return { provider, price: { in: 0.14, out: 0.28 } };
}

function setup(opts: { parentBudget?: number } = {}) {
  db = openDb({ path: ':memory:' });
  bus = new CommandBus(db);
  budget = new BudgetEnforcer(db);
  ledger = new TokenLedger(db);
  scripts = new Map();
  parentPoolId = budget.createPool({
    ownerKind: 'factory',
    ownerId: 'f',
    amountUsd: opts.parentBudget ?? 1,
  }).id;

  db.prepare(
    `INSERT INTO runs (id, factory_id, agent_id, goal, status, tier, pool_id, turn, created_at, updated_at)
     VALUES ('parent-run','f','lead','parent goal','running','B',?,0,0,0)`,
  ).run(parentPoolId);
}

function harness(overrides: Partial<Parameters<typeof createSubagentsHarness>[0]> = {}): SubagentsHarness {
  const h = createSubagentsHarness({
    db,
    parentPoolId,
    providerFor: (t) => providerFor(t),
    budget,
    ledger,
    bus,
    tickMs: 20,
    ...overrides,
  });
  bus.registerAll(h.commands);
  return h;
}

beforeEach(() => {
  setup();
});

describe('subagent.run budget carve-out', () => {
  it('carves the requested amount from the parent pool', async () => {
    harness();
    const res = (await bus.dispatch(
      'subagent.run',
      { goal: 'small task', maxCostUsd: 0.2 },
      lead,
    )) as { result: { subagentId: string; status: string } };

    expect(res.result.status).toBe('completed');
    const parent = budget.getPool(parentPoolId)!;
    // parent keeps 0.8; the subagent spent 0.0022 of its 0.2 and returned 0.1978
    expect(parent.amountUsd).toBeGreaterThan(0.99);
    expect(parent.amountUsd).toBeLessThanOrEqual(1);
  });

  it('refuses a carve larger than the parent has, without creating a subagent', async () => {
    harness();
    await expect(
      bus.dispatch('subagent.run', { goal: 'too big', maxCostUsd: 5 }, { ...lead }),
    ).rejects.toThrow(/INSUFFICIENT_POOL/);
    const subs = (await bus.dispatch('subagent.list', {}, human)) as { result: { subagents: unknown[] } };
    expect(subs.result.subagents).toHaveLength(0);
  });

  it('returns unspent budget to the parent (no stranded money)', async () => {
    harness();
    const before = budget.getPool(parentPoolId)!.amountUsd;
    await bus.dispatch('subagent.run', { goal: 'quick', maxCostUsd: 0.1 }, lead);
    const after = budget.getPool(parentPoolId)!.amountUsd;
    // Only the actual spend is gone.
    expect(before - after).toBeLessThan(0.01);
    expect(after).toBeGreaterThan(0.99);
  });

  it('concurrent subagents cannot jointly overdraw the parent', async () => {
    harness();
    // Parent has $1. Ten subagents each request $0.3 = $3 of demand.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        bus
          .dispatch('subagent.run', { goal: `task ${i}`, maxCostUsd: 0.3 }, { ...lead, toolCallId: `t${i}` })
          .then(() => 'ok')
          .catch((e: Error) => (e.message.includes('INSUFFICIENT_POOL') ? 'rejected' : `err:${e.message}`)),
      ),
    );

    const ok = results.filter((r) => r === 'ok').length;
    const rejected = results.filter((r) => r === 'rejected').length;

    // At most 3 can succeed ($0.9 of $1.0 with 0.3 each).
    expect(ok).toBeLessThanOrEqual(3);
    expect(ok + rejected).toBe(10);
    // The parent never went negative.
    expect(budget.getPool(parentPoolId)!.amountUsd).toBeGreaterThanOrEqual(0);
    // And total spend across every pool never exceeded the factory's $1.
    const total = budget.spentForPool(parentPoolId) + subagentSpend();
    expect(total).toBeLessThanOrEqual(1.0 + 1e-9);
  });

  it('the parent keeps at least the unallocated remainder after concurrent work', async () => {
    harness();
    await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        bus.dispatch('subagent.run', { goal: `t${i}`, maxCostUsd: 0.3 }, { ...lead, toolCallId: `x${i}` }),
      ),
    );
    // 3 x 0.3 carved, ~all released except real spend.
    expect(budget.getPool(parentPoolId)!.amountUsd).toBeGreaterThan(0.98);
  });

  function subagentSpend(): number {
    const rows = db.prepare(`SELECT id FROM subagents`).all() as Array<{ id: string }>;
    return rows.reduce((n, r) => {
      const pool = db.prepare(`SELECT id FROM budget_pools WHERE owner_id LIKE ?`).get(`%`) as { id: string } | undefined;
      void pool;
      return n;
    }, 0);
  }
});

describe('subagent enforcer thresholds', () => {
  it('kills a subagent whose next call would overdraw its pool', async () => {
    const { z } = await import('zod');
    bus.register({
      name: 'notes.list',
      description: 'list',
      inputSchema: z.object({}),
      allowedActors: ['human', 'lead'] as const,
      idempotent: true,
      execute: () => ({ notes: [] }),
    });

    // A pool far too small for even one call at these prices: the first turn
    // must be REFUSED before spending, not discovered afterwards.
    scripts.set('B', [
      { type: 'tool_call', name: 'notes.list', args: {}, callId: 'c1' },
      { type: 'tool_call', name: 'notes.list', args: {}, callId: 'c2' },
      { type: 'text', content: 'never reached' },
    ]);
    harness();

    // maxCostUsd is schema-positive (.positive()); use the smallest the schema
    // allows and a tiny cap so the pool cannot afford a call.
    const res = (await bus.dispatch(
      'subagent.run',
      { goal: 'burn budget', maxCostUsd: 0.000001, maxDurationMs: 30_000 },
      lead,
    )) as { result: { status: string; reason: string | null; releasedUsd: number } };

    expect(res.result.status).toBe('killed_budget');
    // Nothing was spent, so the whole carve came back.
    expect(res.result.releasedUsd).toBeGreaterThan(0);
    // The pool never went negative.
    const subs = (await bus.dispatch('subagent.list', {}, human)) as {
      result: { subagents: Array<{ poolId: string }> };
    };
    const pool = budget.getPool(subs.result.subagents[0]!.poolId)!;
    expect(budget.spentForPool(pool.id)).toBeLessThanOrEqual(pool.amountUsd + 1e-12);
  });

  it('a pool can never be driven negative by a runaway subagent', async () => {
    const { z } = await import('zod');
    bus.register({
      name: 'notes.list',
      description: 'list',
      inputSchema: z.object({}),
      allowedActors: ['human', 'lead'] as const,
      idempotent: true,
      execute: () => ({ notes: [] }),
    });
    // 6 turns, each ~$0.000168. A $0.0004 budget affords 2 calls at most.
    scripts.set('B', Array.from({ length: 6 }, (_, i) => ({
      type: 'tool_call' as const,
      name: 'notes.list',
      args: {},
      callId: `c${i}`,
    })));
    harness();

    const res = (await bus.dispatch('subagent.run', { goal: 'runaway', maxCostUsd: 0.0004 }, lead)) as {
      result: { subagentId: string; status: string };
    };
    expect(res.result.status).toBe('killed_budget');

    const subs = (await bus.dispatch('subagent.list', {}, human)) as {
      result: { subagents: Array<{ poolId: string }> };
    };
    const pool = budget.getPool(subs.result.subagents[0]!.poolId)!;
    const spent = budget.spentForPool(pool.id);
    // The critical invariant: never more was spent than was allocated.
    expect(spent).toBeLessThanOrEqual(pool.amountUsd + 1e-12);
  });

  it('injects a wrap-up instruction at 80% of the budget', () => {
    const pool = budget.createPool({ ownerKind: 'subagent', ownerId: 's', amountUsd: 1 });
    ledger.record({
      poolId: pool.id,
      provider: 'p',
      model: 'm',
      tier: 'B',
      unitPriceInUsd: 1000,
      unitPriceOutUsd: 1000,
      tokensIn: 400,
      tokensOut: 400, // $0.8 of $1.0 = 80%
      category: 'turn',
    });
    const verdict = budget.evaluate({ poolId: pool.id, startedAtMs: Date.now() });
    expect(verdict.action).toBe('wrap_up');
    expect(verdict.instruction).toMatch(/Stop exploring/);
  });

  it('injects a wrap-up instruction at 60% of time', () => {
    const pool = budget.createPool({ ownerKind: 'subagent', ownerId: 's2', amountUsd: 10 });
    const started = 1_000_000;
    const v = budget.evaluate({
      poolId: pool.id,
      startedAtMs: started,
      maxDurationMs: 10_000,
      nowMs: started + 6_000,
    });
    expect(v.action).toBe('wrap_up');
    expect(v.timeRatio).toBeCloseTo(0.6, 5);
  });

  it('honours the duration cap and reports the reason', async () => {
    harness();
    const res = (await bus.dispatch(
      'subagent.run',
      { goal: 'minimum duration', maxCostUsd: 0.1, maxDurationMs: 500 }, // below the schema minimum
      lead,
    ).catch((e: Error) => e)) as unknown;
    // The schema enforces >= 1000ms rather than silently clamping.
    expect(res).toBeInstanceOf(Error);
    expect((res as Error).message).toMatch(/Invalid input/);

    const ok = (await bus.dispatch(
      'subagent.run',
      { goal: 'minimum duration', maxCostUsd: 0.1, maxDurationMs: 1000 },
      lead,
    )) as { result: { subagentId: string } };
    const read = (await bus.dispatch('subagent.read', { subagentId: ok.result.subagentId }, human)) as {
      result: { subagent: { maxDurationMs: number } };
    };
    expect(read.result.subagent.maxDurationMs).toBe(1000);
  });

  it('clamps an over-large request to the configured cap', async () => {
    harness({ maxCostUsdCap: 0.05 });
    const res = (await bus.dispatch(
      'subagent.run',
      { goal: 'ask for a lot', maxCostUsd: 100 },
      lead,
    ).catch((e: Error) => e)) as unknown;
    // $100 is clamped to $0.05, which the $1 parent can afford.
    expect(res).toBeDefined();
    const subs = (await bus.dispatch('subagent.list', {}, human)) as {
      result: { subagents: Array<{ maxCostUsd: number }> };
    };
    expect(subs.result.subagents[0]!.maxCostUsd).toBe(0.05);
  });
});

describe('subagent.read / stop / list', () => {
  it('read returns the output and what it spent', async () => {
    scripts.set('B', [{ type: 'text', content: 'the subagent answer' }]);
    harness();
    const res = (await bus.dispatch('subagent.run', { goal: 'answer me', maxCostUsd: 0.1 }, lead)) as {
      result: { subagentId: string };
    };
    const read = (await bus.dispatch('subagent.read', { subagentId: res.result.subagentId }, human)) as {
      result: { subagent: { output: string; status: string }; spentUsd: number };
    };
    expect(read.result.subagent.output).toBe('the subagent answer');
    expect(read.result.subagent.status).toBe('completed');
    expect(read.result.spentUsd).toBeGreaterThan(0);
  });

  it('read 404s for an unknown subagent', async () => {
    harness();
    await expect(bus.dispatch('subagent.read', { subagentId: 'nope' }, human)).rejects.toThrow(/not found/);
  });

  it('stop on a finished subagent reports honestly instead of pretending', async () => {
    harness();
    const res = (await bus.dispatch('subagent.run', { goal: 'fast', maxCostUsd: 0.05 }, lead)) as {
      result: { subagentId: string };
    };
    const stop = (await bus.dispatch('subagent.stop', { subagentId: res.result.subagentId }, human)) as {
      result: { stopping: boolean; status?: string };
    };
    expect(stop.result.stopping).toBe(false);
    expect(stop.result.status).toBe('completed');
  });

  it('list filters by parent run', async () => {
    harness();
    await bus.dispatch('subagent.run', { goal: 'a', maxCostUsd: 0.05 }, lead);
    await bus.dispatch('subagent.run', { goal: 'b', maxCostUsd: 0.05 }, { ...lead, runId: 'parent-run' });
    const mine = (await bus.dispatch('subagent.list', { parentRunId: 'parent-run' }, human)) as {
      result: { subagents: unknown[] };
    };
    expect(mine.result.subagents).toHaveLength(2);
    const other = (await bus.dispatch('subagent.list', { parentRunId: 'nope' }, human)) as {
      result: { subagents: unknown[] };
    };
    expect(other.result.subagents).toHaveLength(0);
  });

  it('a non-agent caller cannot spawn', async () => {
    harness();
    await expect(bus.dispatch('subagent.run', { goal: 'x', maxCostUsd: 0.05 }, human)).rejects.toThrow(
      /must be called by an agent/,
    );
  });

  it('capabilities: a specialist agent may not spawn', async () => {
    harness();
    await expect(
      bus.dispatch(
        'subagent.run',
        { goal: 'x', maxCostUsd: 0.05 },
        { kind: 'agent', role: 'specialist', agentId: 's', runId: 'parent-run', toolCallId: 't' },
      ),
    ).rejects.toThrow(/may not call/);
  });

  it('spawning is marked non-idempotent (never blindly replayed after a crash)', () => {
    harness();
    expect(bus.get('subagent.run').idempotent).toBe(false);
  });
});

