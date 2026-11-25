import { describe, expect, it } from 'vitest';
import { deriveMaxOutputTokens, BudgetEnforcer, BudgetError } from '../src/budget/enforcer.js';
import { TokenLedger } from '../src/budget/ledger.js';
import { openDb } from '../src/db/client.js';

function make() {
  const db = openDb({ path: ':memory:' });
  return { db, budget: new BudgetEnforcer(db), ledger: new TokenLedger(db) };
}

describe('deriveMaxOutputTokens', () => {
  it('discounts the input cost before computing the output ceiling', () => {
    // $10/1M in, $30/1M out. 100k input tokens => $1.00 of input.
    const res = deriveMaxOutputTokens({
      configuredMaxTokens: 4096,
      inputTokens: 100_000,
      unitPriceInUsd: 10,
      unitPriceOutUsd: 30,
      remainingUsd: 1.5,
    });
    // Remaining after input: $0.50 => 0.50/30 * 1M = 16666 tokens, capped at 4096.
    expect(res.inputCostUsd).toBeCloseTo(1.0, 9);
    expect(res.remainingForOutputUsd).toBeCloseTo(0.5, 9);
    expect(res.maxOutputTokens).toBe(4096);
    expect(res.exhausted).toBe(false);
  });

  it('caps the output at what the remaining budget actually buys', () => {
    // $1/1M in, $10/1M out, $0.05 remaining, no input cost.
    const res = deriveMaxOutputTokens({
      configuredMaxTokens: 8192,
      inputTokens: 0,
      unitPriceInUsd: 1,
      unitPriceOutUsd: 10,
      remainingUsd: 0.05,
    });
    // 0.05 / 10 * 1e6 = 5000
    expect(res.maxOutputTokens).toBe(5000);
  });

  it('marks exhausted when the input alone costs more than remains', () => {
    const res = deriveMaxOutputTokens({
      configuredMaxTokens: 4096,
      inputTokens: 1_000_000, // $10 at $10/1M
      unitPriceInUsd: 10,
      unitPriceOutUsd: 30,
      remainingUsd: 0.5,
    });
    expect(res.exhausted).toBe(true);
    expect(res.maxOutputTokens).toBe(0);
    expect(res.remainingForOutputUsd).toBeLessThan(0);
  });

  it('marks exhausted when the output ceiling is below the useful floor', () => {
    const res = deriveMaxOutputTokens({
      configuredMaxTokens: 4096,
      inputTokens: 0,
      unitPriceInUsd: 0,
      unitPriceOutUsd: 1_000_000, // $1 per token
      remainingUsd: 0.0001,
      minUsefulOutputTokens: 16,
    });
    expect(res.exhausted).toBe(true);
  });

  it('does not divide by zero for a free output model', () => {
    const res = deriveMaxOutputTokens({
      configuredMaxTokens: 2048,
      inputTokens: 5000,
      unitPriceInUsd: 0,
      unitPriceOutUsd: 0,
      remainingUsd: 0,
    });
    // remaining is 0 which is not > 0 -> exhausted, but no NaN/Infinity leaks.
    expect(res.exhausted).toBe(true);
    expect(Number.isFinite(res.remainingForOutputUsd)).toBe(true);
  });
});

describe('carveOut / releaseRemainder', () => {
  it('carves a child pool and debits the parent', () => {
    const { budget } = make();
    const parent = budget.createPool({ ownerKind: 'factory', ownerId: 'f', amountUsd: 1.0 });
    const childId = budget.carveOut(parent.id, 0.25, { ownerKind: 'subagent', ownerId: 's1' });

    expect(budget.getPool(parent.id)!.amountUsd).toBeCloseTo(0.75, 9);
    expect(budget.getPool(childId)!.amountUsd).toBeCloseTo(0.25, 9);
    expect(budget.getPool(childId)!.parentPoolId).toBe(parent.id);
  });

  it('refuses a carve larger than the parent has available', () => {
    const { budget } = make();
    const parent = budget.createPool({ ownerKind: 'factory', ownerId: 'f', amountUsd: 0.5 });
    expect(() => budget.carveOut(parent.id, 0.6, { ownerKind: 'subagent', ownerId: 's1' })).toThrow(BudgetError);
    // Nothing was mutated by the failed attempt.
    expect(budget.getPool(parent.id)!.amountUsd).toBeCloseTo(0.5, 9);
  });

  it('refuses a non-positive carve (would create free money)', () => {
    const { budget } = make();
    const parent = budget.createPool({ ownerKind: 'factory', ownerId: 'f', amountUsd: 1 });
    expect(() => budget.carveOut(parent.id, 0, { ownerKind: 'subagent', ownerId: 's' })).toThrow(/must be positive/);
    expect(() => budget.carveOut(parent.id, -1, { ownerKind: 'subagent', ownerId: 's' })).toThrow(/must be positive/);
  });

  it('concurrent carve-outs cannot overdraw the parent', async () => {
    const { db, budget } = make();
    const parent = budget.createPool({ ownerKind: 'factory', ownerId: 'f', amountUsd: 1.0 });

    // 10 concurrent attempts of $0.2 against a pool that fits only 5.
    const attempts = Array.from({ length: 10 }, (_, i) =>
      Promise.resolve().then(() => {
        try {
          budget.carveOut(parent.id, 0.2, { ownerKind: 'subagent', ownerId: `s${i}` });
          return 'ok';
        } catch (e) {
          return e instanceof BudgetError ? 'rejected' : 'unexpected';
        }
      }),
    );
    const results = await Promise.all(attempts);

    expect(results.filter((r) => r === 'ok')).toHaveLength(5);
    expect(results.filter((r) => r === 'rejected')).toHaveLength(5);
    expect(budget.getPool(parent.id)!.amountUsd).toBeCloseTo(0, 9);

    const poolCount = db.prepare(`SELECT COUNT(*) c FROM budget_pools WHERE parent_pool_id = ?`).get(parent.id) as {
      c: number;
    };
    expect(poolCount.c).toBe(5);
  });

  it('releaseRemainder returns only unspent money to the parent', () => {
    const { budget, ledger } = make();
    const parent = budget.createPool({ ownerKind: 'factory', ownerId: 'f', amountUsd: 1.0 });
    const childId = budget.carveOut(parent.id, 0.3, { ownerKind: 'subagent', ownerId: 's1' });

    // Child spends $0.1.
    ledger.record({
      poolId: childId,
      provider: 'p',
      model: 'm',
      tier: 'B',
      unitPriceInUsd: 10,
      unitPriceOutUsd: 10,
      tokensIn: 5_000,
      tokensOut: 5_000,
      category: 'turn',
    });
    expect(budget.spentForPool(childId)).toBeCloseTo(0.1, 9);

    const released = budget.releaseRemainder(childId);
    expect(released.releasedUsd).toBeCloseTo(0.2, 9);
    // Parent is back to 0.7 + 0.2, and the spent 0.1 is gone.
    expect(budget.getPool(parent.id)!.amountUsd).toBeCloseTo(0.9, 9);
    expect(budget.spentForPool(childId)).toBeCloseTo(0.1, 9);
  });

  it('a second release is a no-op (no double credit)', () => {
    const { budget } = make();
    const parent = budget.createPool({ ownerKind: 'factory', ownerId: 'f', amountUsd: 1.0 });
    const childId = budget.carveOut(parent.id, 0.4, { ownerKind: 'subagent', ownerId: 's1' });

    budget.releaseRemainder(childId);
    expect(budget.getPool(parent.id)!.amountUsd).toBeCloseTo(1.0, 9);

    const again = budget.releaseRemainder(childId);
    expect(again.releasedUsd).toBe(0);
    expect(budget.getPool(parent.id)!.amountUsd).toBeCloseTo(1.0, 9);
  });
});

describe('enforcer verdicts', () => {
  it('wraps up at 80% of budget and kills at 100%', () => {
    const { budget, ledger } = make();
    const pool = budget.createPool({ ownerKind: 'factory', ownerId: 'f', amountUsd: 1.0 });
    const startedAtMs = Date.now();

    ledger.record({
      poolId: pool.id,
      provider: 'p',
      model: 'm',
      tier: 'B',
      unitPriceInUsd: 1000,
      unitPriceOutUsd: 1000,
      tokensIn: 400,
      tokensOut: 400, // 0.8 total
      category: 'turn',
    });
    expect(budget.evaluate({ poolId: pool.id, startedAtMs }).action).toBe('wrap_up');

    ledger.record({
      poolId: pool.id,
      provider: 'p',
      model: 'm',
      tier: 'B',
      unitPriceInUsd: 1000,
      unitPriceOutUsd: 1000,
      tokensIn: 200,
      tokensOut: 0, // now 1.0
      category: 'turn',
    });
    const verdict = budget.evaluate({ poolId: pool.id, startedAtMs });
    expect(verdict.action).toBe('kill');
    expect(verdict.reason).toMatch(/budget exhausted/);
  });

  it('wraps up at 60% of time and kills at 100%', () => {
    const { budget } = make();
    const pool = budget.createPool({ ownerKind: 'subagent', ownerId: 's', amountUsd: 10 });
    const startedAtMs = 1_000_000;

    const mid = budget.evaluate({ poolId: pool.id, startedAtMs, maxDurationMs: 1000, nowMs: startedAtMs + 600 });
    expect(mid.action).toBe('wrap_up');
    expect(mid.instruction).toMatch(/Stop exploring/);

    const end = budget.evaluate({ poolId: pool.id, startedAtMs, maxDurationMs: 1000, nowMs: startedAtMs + 1000 });
    expect(end.action).toBe('kill');
    expect(end.reason).toMatch(/time exhausted/);
  });

  it('continues when comfortably inside both limits', () => {
    const { budget } = make();
    const pool = budget.createPool({ ownerKind: 'factory', ownerId: 'f', amountUsd: 10 });
    const v = budget.evaluate({ poolId: pool.id, startedAtMs: 0, maxDurationMs: 1000, nowMs: 100 });
    expect(v.action).toBe('continue');
  });
});

describe('pool overdraw protection', () => {
  it('chargeWithinPool reports honest numbers but the ledger decides availability', () => {
    const { budget } = make();
    const pool = budget.createPool({ ownerKind: 'run', ownerId: 'r', amountUsd: 0.0005 });

    const res = budget.chargeWithinPool(pool.id, 10);
    // The clamp reports what the pool could actually absorb.
    expect(res.chargedUsd).toBeCloseTo(0.0005, 9);
    expect(res.overageUsd).toBeGreaterThan(9);
    expect(res.exhausted).toBe(true);
    // used_usd is the reporting mirror.
    expect(budget.getPoolOrThrow(pool.id).usedUsd).toBeCloseTo(0.0005, 9);
  });

  it('the ledger is the authoritative book; availableUsd follows it', () => {
    const { budget, ledger } = make();
    const pool = budget.createPool({ ownerKind: 'run', ownerId: 'r', amountUsd: 0.01 });
    // Prices are per 1M tokens: 6000 in at $1/1M = $0.006.
    ledger.record({
      poolId: pool.id,
      provider: 'p',
      model: 'm',
      tier: 'B',
      unitPriceInUsd: 1,
      unitPriceOutUsd: 1,
      tokensIn: 6000,
      tokensOut: 0,
      category: 'turn',
    });
    // Availability follows the ledger immediately, without any charge() call.
    expect(budget.availableUsd(budget.getPoolOrThrow(pool.id))).toBeCloseTo(0.004, 9);

    const res = budget.chargeWithinPool(pool.id, 10);
    expect(res.chargedUsd).toBeCloseTo(0.004, 9);
    expect(res.overageUsd).toBeCloseTo(9.996, 9);
    // The ledger still governs availability: nothing double-counted.
    expect(budget.availableUsd(budget.getPoolOrThrow(pool.id))).toBeCloseTo(0.004, 9);
  });

  it('availableUsd never goes negative after repeated clamped charges', () => {
    const { budget, ledger } = make();
    const pool = budget.createPool({ ownerKind: 'run', ownerId: 'r', amountUsd: 0.01 });
    for (let i = 0; i < 20; i++) budget.chargeWithinPool(pool.id, 0.003);
    // No ledger rows were written, so availability is still the full allocation:
    // charging used_usd alone must never masquerade as spend.
    expect(budget.availableUsd(budget.getPoolOrThrow(pool.id))).toBeCloseTo(0.01, 9);
    expect(ledger.totalForPool(pool.id)).toBe(0);
  });

  it('estimateCallCostUsd applies the input safety factor so reservations over-reserve', () => {
    const { budget } = make();
    // 154 estimated tokens realistically bill ~1000; the factor must cover it.
    const estimate = budget.estimateCallCostUsd({
      inputTokens: 154,
      maxOutputTokens: 2048,
      unitPriceInUsd: 0.14,
      unitPriceOutUsd: 0.28,
    });
    const naive =
      (154 / 1e6) * 0.14 + (2048 / 1e6) * 0.28;
    expect(estimate).toBeGreaterThan(naive);
  });

  it('canAfford is false when the pool cannot cover the reservation', () => {
    const { budget } = make();
    const pool = budget.createPool({ ownerKind: 'run', ownerId: 'r', amountUsd: 0.0001 });
    expect(budget.canAfford(pool.id, 0.01)).toBe(false);
    expect(budget.canAfford(pool.id, 0.00001)).toBe(true);
  });

  it('releaseRemainder reports overspend instead of silently returning zero', () => {
    const { budget, ledger } = make();
    const parent = budget.createPool({ ownerKind: 'factory', ownerId: 'f', amountUsd: 1 });
    const childId = budget.carveOut(parent.id, 0.1, { ownerKind: 'subagent', ownerId: 's' });
    // Spend MORE than the child pool (simulates provider billing above estimate).
    ledger.record({
      poolId: childId,
      provider: 'p',
      model: 'm',
      tier: 'B',
      unitPriceInUsd: 1000,
      unitPriceOutUsd: 1000,
      tokensIn: 200,
      tokensOut: 0, // $0.2 against a $0.1 pool
      category: 'turn',
    });
    const res = budget.releaseRemainder(childId);
    expect(res.releasedUsd).toBe(0);
    expect(res.overspentUsd).toBeCloseTo(0.1, 9);
  });
});

describe('TokenLedger', () => {
  it('snapshots unit prices instead of recomputing them later', () => {
    const { ledger } = make();
    ledger.record({
      provider: 'mistral',
      model: 'deepseek-v4-1-flash-1017',
      tier: 'S',
      unitPriceInUsd: 0.14,
      unitPriceOutUsd: 0.28,
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
      category: 'turn',
    });
    const [row] = ledger.listRecent(1);
    expect(row!.unitPriceInUsd).toBe(0.14);
    expect(row!.unitPriceOutUsd).toBe(0.28);
    expect(row!.costUsd).toBeCloseTo(0.42, 9);
  });

  it('records aborted streams as partial with the estimate flag', () => {
    const { ledger } = make();
    ledger.record({
      provider: 'mistral',
      model: 'm',
      tier: 'B',
      unitPriceInUsd: 1,
      unitPriceOutUsd: 1,
      tokensIn: 100,
      tokensOut: 50,
      aborted: true,
      isEstimated: true,
      category: 'turn',
    });
    const summary = ledger.summary();
    expect(summary.abortedCostUsd).toBeGreaterThan(0);
    expect(summary.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('aggregates by category and model', () => {
    const { ledger } = make();
    for (const category of ['turn', 'turn', 'tool_summary'] as const) {
      ledger.record({
        provider: 'p',
        model: 'm',
        tier: 'B',
        unitPriceInUsd: 100,
        unitPriceOutUsd: 100,
        tokensIn: 1000,
        tokensOut: 1000,
        category,
      });
    }
    const s = ledger.summary();
    expect(s.byCategory.turn!.calls).toBe(2);
    expect(s.byCategory.tool_summary!.calls).toBe(1);
    expect(s.byModel.m!.calls).toBe(3);
    expect(s.totalCostUsd).toBeCloseTo(0.6, 9);
  });
});
