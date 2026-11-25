import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.js';
import { BudgetEnforcer } from '../src/budget/enforcer.js';
import { TokenLedger } from '../src/budget/ledger.js';
import { LedgerQueries } from '../src/budget/ledger-queries.js';

/**
 * The ledger is WRITTEN with hand-written SQL (inside transactions shared with
 * the runner) and READ through Drizzle (in `LedgerQueries`). Both use the same
 * connection, so this suite proves the two views agree — which is the only
 * thing that makes a mixed-driver migration safe.
 */
function seed() {
  const db = openDb({ path: ':memory:' });
  const budget = new BudgetEnforcer(db);
  const ledger = new TokenLedger(db);
  const queries = new LedgerQueries(db);

  // token_ledger.pool_id and .run_id are real foreign keys, so the parents must
  // exist. Creating them is not ceremony: it proves the schema constrains us.
  const pool = budget.createPool({ ownerKind: 'factory', ownerId: 'f', amountUsd: 100 });
  for (const id of ['r1', 'r2']) {
    db.prepare(
      `INSERT OR IGNORE INTO runs
         (id, factory_id, agent_id, goal, status, tier, pool_id, turn, created_at, updated_at)
       VALUES (?, 'f', 'a', 'g', 'running', 'B', ?, 0, 0, 0)`,
    ).run(id, pool.id);
  }

  return { db, ledger, queries, poolId: pool.id };
}

describe('Drizzle reads agree with raw-SQL writes', () => {
  it('sees a row written through the raw INSERT immediately', () => {
    const { ledger, queries, poolId } = seed();
    ledger.record({
      runId: 'r1',
      poolId,
      provider: 'mistral',
      model: 'deepseek-v4-1-flash-1017',
      tier: 'S',
      unitPriceInUsd: 0.14,
      unitPriceOutUsd: 0.28,
      tokensIn: 1_000_000,
      tokensOut: 0,
      category: 'turn',
    });

    const recent = queries.recent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.model).toBe('deepseek-v4-1-flash-1017');
    expect(recent[0]!.costUsd).toBeCloseTo(0.14, 9);
  });

  it('totalForPool matches TokenLedger.totalForPool', () => {
    const { ledger, queries, poolId } = seed();
    for (let i = 0; i < 5; i++) {
      ledger.record({
        poolId,
        provider: 'p',
        model: 'm',
        tier: 'B',
        unitPriceInUsd: 1,
        unitPriceOutUsd: 1,
        tokensIn: 1000,
        tokensOut: 0,
        category: 'turn',
      });
    }
    // The two independent implementations must agree to the nanodollar.
    expect(queries.totalForPool(poolId)).toBeCloseTo(ledger.totalForPool(poolId), 12);
    expect(queries.totalForPool(poolId)).toBeCloseTo(0.005, 12);
  });

  it('summary matches TokenLedger.summary', () => {
    const { ledger, queries } = seed();
    for (const category of ['turn', 'turn', 'tool_summary', 'classifier'] as const) {
      ledger.record({
        provider: 'p',
        model: 'm',
        tier: 'D',
        unitPriceInUsd: 100,
        unitPriceOutUsd: 100,
        tokensIn: 1000,
        tokensOut: 1000,
        category,
      });
    }
    const a = queries.summary();
    const b = ledger.summary();
    expect(a.totalCostUsd).toBeCloseTo(b.totalCostUsd, 12);
    expect(a.byCategory.turn!.calls).toBe(2);
    expect(a.byCategory.tool_summary!.calls).toBe(1);
    expect(a.byCategory.classifier!.calls).toBe(1);
  });

  it('filters by run', () => {
    const { ledger, queries } = seed();
    const base = {
      provider: 'p',
      model: 'm',
      tier: 'B',
      unitPriceInUsd: 1,
      unitPriceOutUsd: 1,
      tokensIn: 10,
      tokensOut: 10,
      category: 'turn' as const,
    };
    ledger.record({ ...base, runId: 'r1' });
    ledger.record({ ...base, runId: 'r2' });
    expect(queries.forRun('r1')).toHaveLength(1);
    expect(queries.summary({ runId: 'r2' }).totalCostUsd).toBeGreaterThan(0);
  });

  it('boolean columns round-trip (isEstimated / aborted are stored as integers)', () => {
    const { ledger, queries } = seed();
    ledger.record({
      runId: 'r1',
      provider: 'p',
      model: 'm',
      tier: 'B',
      unitPriceInUsd: 1,
      unitPriceOutUsd: 1,
      tokensIn: 10,
      tokensOut: 0,
      isEstimated: true,
      aborted: true,
      category: 'turn',
    });
    const row = queries.recent(1)[0]!;
    // Drizzle's mode:'boolean' maps 1/0 to true/false; if that mapping broke we
    // would see 1 here and Tokenomics would mislabel real spend as estimates.
    expect(row.isEstimated).toBe(true);
    expect(row.aborted).toBe(true);
    expect(queries.abortedForRun('r1')).toHaveLength(1);
  });

  it('byCategoryForRun separates the price of work from the price of watching it', () => {
    const { ledger, queries } = seed();
    ledger.record({ runId: 'r1', provider: 'p', model: 'm', tier: 'B', unitPriceInUsd: 1000, unitPriceOutUsd: 0, tokensIn: 1000, tokensOut: 0, category: 'turn' });
    ledger.record({ runId: 'r1', provider: 'p', model: 'm', tier: 'D', unitPriceInUsd: 100, unitPriceOutUsd: 0, tokensIn: 1000, tokensOut: 0, category: 'tool_summary' });

    const rows = queries.byCategoryForRun('r1');
    const turn = rows.find((r) => r.category === 'turn')!;
    const summary = rows.find((r) => r.category === 'tool_summary')!;
    expect(turn.costUsd).toBeCloseTo(1, 9);
    expect(summary.costUsd).toBeCloseTo(0.1, 9);
    expect(turn.calls).toBe(1);
  });

  it('an empty ledger returns zeros, not NaN', () => {
    const { queries } = seed();
    expect(queries.totalForPool('nope')).toBe(0);
    expect(queries.summary().totalCostUsd).toBe(0);
    expect(queries.recent()).toEqual([]);
  });
});

