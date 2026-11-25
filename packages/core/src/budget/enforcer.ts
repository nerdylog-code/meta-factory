import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import { immediate } from '../db/client.js';
import { addMoney, gt, gte, lt, roundMoney, subMoney } from './money.js';

export type PoolOwnerKind = 'factory' | 'run' | 'subagent' | 'job';

export interface BudgetPool {
  id: string;
  parentPoolId: string | null;
  ownerKind: PoolOwnerKind;
  ownerId: string;
  amountUsd: number;
  usedUsd: number;
  releasedUsd: number;
  createdAt: number;
}

export class BudgetError extends Error {
  constructor(
    message: string,
    readonly code: 'INSUFFICIENT_POOL' | 'POOL_NOT_FOUND' | 'ALREADY_RELEASED',
  ) {
    super(message);
    this.name = 'BudgetError';
  }
}

/** Threshold at which the enforcer injects a wrap-up instruction. */
export const WRAP_UP_BUDGET_RATIO = 0.8;
/** Threshold at which the enforcer aborts the work. */
export const HARD_KILL_BUDGET_RATIO = 1.0;
/** Threshold at which the enforcer injects a wrap-up instruction, by time. */
export const WRAP_UP_TIME_RATIO = 0.6;
/**
 * Safety multiplier for estimated input tokens when reserving budget.
 * Our token count is a heuristic; the provider's bill is not.
 */
export const DEFAULT_INPUT_SAFETY_FACTOR = 1.5;

export interface DeriveMaxOutputTokensArgs {
  /** Output token ceiling from configuration. */
  configuredMaxTokens: number;
  /** Prompt token count already known for this call. */
  inputTokens: number;
  /** USD per 1M output tokens. */
  unitPriceOutUsd: number;
  /** USD per 1M input tokens. */
  unitPriceInUsd: number;
  /** Remaining USD available to this call. */
  remainingUsd: number;
  /** Floor; below this an output is useless, so the run is killed instead. */
  minUsefulOutputTokens?: number;
}

export interface DeriveMaxOutputTokensResult {
  maxOutputTokens: number;
  /** USD already consumed by the input tokens of this call. */
  inputCostUsd: number;
  /** USD left for output after paying for input. */
  remainingForOutputUsd: number;
  exhausted: boolean;
}

/**
 * Budget inside the turn.
 *
 * The input tokens are not free: charging them only after the call means a
 * huge prompt can push a nearly-empty pool past its limit. So we price the
 * input FIRST, subtract it, and derive the output ceiling from what is left.
 */
export function deriveMaxOutputTokens(args: DeriveMaxOutputTokensArgs): DeriveMaxOutputTokensResult {
  const minUseful = args.minUsefulOutputTokens ?? 16;
  const inputCostUsd = roundMoney((args.inputTokens / 1_000_000) * args.unitPriceInUsd);
  const remainingForOutputUsd = roundMoney(args.remainingUsd - inputCostUsd);

  if (!gt(remainingForOutputUsd, 0) || lt(args.remainingUsd, inputCostUsd)) {
    return { maxOutputTokens: 0, inputCostUsd, remainingForOutputUsd, exhausted: true };
  }

  // How many output tokens can we afford? Never divide by zero.
  const affordable =
    args.unitPriceOutUsd <= 0
      ? Number.MAX_SAFE_INTEGER
      : Math.floor((remainingForOutputUsd / args.unitPriceOutUsd) * 1_000_000);

  const maxOutputTokens = Math.min(args.configuredMaxTokens, affordable);

  if (maxOutputTokens < minUseful) {
    return {
      maxOutputTokens: 0,
      inputCostUsd,
      remainingForOutputUsd,
      exhausted: true,
    };
  }
  return { maxOutputTokens, inputCostUsd, remainingForOutputUsd, exhausted: false };
}

export interface EnforcerVerdict {
  action: 'continue' | 'wrap_up' | 'kill';
  reason?: string;
  /** Human/model-facing instruction when action === 'wrap_up'. */
  instruction?: string;
  budgetRatio: number;
  timeRatio: number;
}

/**
 * Hierarchical budgets in SQLite.
 *
 * carveOut/releaseRemainder are the two operations that must never race. Both
 * run as BEGIN IMMEDIATE so two concurrent subagents cannot both see enough
 * headroom and jointly overdraw the parent.
 */
export class BudgetEnforcer {
  constructor(private readonly db: Db) {}

  createPool(args: {
    ownerKind: PoolOwnerKind;
    ownerId: string;
    amountUsd: number;
    parentPoolId?: string | null;
    id?: string;
  }): BudgetPool {
    const id = args.id ?? randomUUID();
    return immediate(this.db, () => {
      const parent = args.parentPoolId ?? null;
      if (parent) {
        const p = this.getPoolOrThrow(parent);
        // A child pool carved out with parentPoolId must not exceed the parent.
        const available = this.availableUsd(p);
        if (gt(args.amountUsd, available)) {
          throw new BudgetError(
            `Cannot create pool of $${args.amountUsd} under parent with $${available} available`,
            'INSUFFICIENT_POOL',
          );
        }
      }
      this.db
        .prepare(
          `INSERT INTO budget_pools
             (id, parent_pool_id, owner_kind, owner_id, amount_usd, used_usd, released_usd, created_at)
           VALUES (?,?,?,?,?,0,0,?)`,
        )
        .run(id, parent, args.ownerKind, args.ownerId, roundMoney(args.amountUsd), Date.now());
      return this.getPoolOrThrow(id);
    });
  }

  getPool(id: string): BudgetPool | null {
    const row = this.db.prepare(`SELECT * FROM budget_pools WHERE id = ?`).get(id) as RawPool | undefined;
    return row ? mapPool(row) : null;
  }

  getPoolOrThrow(id: string): BudgetPool {
    const p = this.getPool(id);
    if (!p) throw new BudgetError(`Pool ${id} not found`, 'POOL_NOT_FOUND');
    return p;
  }

  /**
   * USD still spendable from a pool.
   *
   * The TOKEN LEDGER is the single source of truth for spend: every call is
   * appended there with its price snapshot, and every consumer (enforcer,
   * releaseRemainder, Tokenomics) derives from it. `used_usd` on the row is a
   * reporting mirror only, never an input to this calculation — two books of
   * account that can disagree is how a budget silently stops meaning anything.
   */
  availableUsd(pool: BudgetPool): number {
    const spent = this.spentForPool(pool.id);
    return roundMoney(pool.amountUsd - spent);
  }

  spentForPool(poolId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM token_ledger WHERE pool_id = ?`)
      .get(poolId) as { total: number };
    return roundMoney(row.total);
  }

  /**
   * Atomically moves `amountUsd` from a parent pool into a new child pool.
   * Returns the child pool id.
   */
  carveOut(parentPoolId: string, amountUsd: number, child: { ownerKind: PoolOwnerKind; ownerId: string; id?: string }): string {
    if (!gt(amountUsd, 0)) {
      throw new BudgetError(`carveOut amount must be positive, got ${amountUsd}`, 'INSUFFICIENT_POOL');
    }
    const childId = child.id ?? randomUUID();
    return immediate(this.db, () => {
      const parent = this.getPoolOrThrow(parentPoolId);
      const available = this.availableUsd(parent);

      if (!gte(available, amountUsd)) {
        throw new BudgetError(
          `INSUFFICIENT_POOL: parent ${parentPoolId} has $${available.toFixed(6)} available, carve of $${amountUsd} requested`,
          'INSUFFICIENT_POOL',
        );
      }

      // The amount lives in exactly one place at a time: debit the parent by
      // shrinking its allocation, and give the child that same allocation.
      this.db
        .prepare(`UPDATE budget_pools SET amount_usd = ? WHERE id = ?`)
        .run(roundMoney(subMoney(parent.amountUsd, amountUsd)), parentPoolId);

      this.db
        .prepare(
          `INSERT INTO budget_pools
             (id, parent_pool_id, owner_kind, owner_id, amount_usd, used_usd, released_usd, created_at)
           VALUES (?,?,?,?,?,0,0,?)`,
        )
        .run(childId, parentPoolId, child.ownerKind, child.ownerId, roundMoney(amountUsd), Date.now());

      return childId;
    });
  }

  /**
   * Returns a child's untouched remainder to its parent. This is what stops a
   * subagent that finished early from stranding budget.
   */
  releaseRemainder(childPoolId: string): { releasedUsd: number; parentPoolId: string | null; overspentUsd: number } {
    return immediate(this.db, () => {
      const child = this.getPoolOrThrow(childPoolId);
      const remainder = this.availableUsd(child);

      if (remainder < -1e-12) {
        // Overspent. There is nothing to return, and pretending otherwise would
        // hide real overspend from the caller.
        return { releasedUsd: 0, parentPoolId: child.parentPoolId, overspentUsd: roundMoney(-remainder) };
      }
      if (remainder <= 1e-12) {
        return { releasedUsd: 0, parentPoolId: child.parentPoolId, overspentUsd: 0 };
      }

      // Shrink the child's allocation by the remainder. What stays allocated
      // is exactly what was spent, so a second release computes 0 and cannot
      // double-credit the parent.
      this.db
        .prepare(`UPDATE budget_pools SET amount_usd = ?, released_usd = ? WHERE id = ?`)
        .run(roundMoney(subMoney(child.amountUsd, remainder)), roundMoney(addMoney(child.releasedUsd, remainder)), childPoolId);

      if (child.parentPoolId) {
        const parent = this.getPoolOrThrow(child.parentPoolId);
        this.db
          .prepare(`UPDATE budget_pools SET amount_usd = ? WHERE id = ?`)
          .run(roundMoney(addMoney(parent.amountUsd, remainder)), parent.id);
      }
      return { releasedUsd: remainder, parentPoolId: child.parentPoolId, overspentUsd: 0 };
    });
  }

  /**
   * Charges a pool. Unlike the ledger (append-only history), this is the
   * running total the enforcer compares against.
   */
  charge(poolId: string, usd: number): BudgetPool {
    return immediate(this.db, () => {
      const pool = this.getPoolOrThrow(poolId);
      this.db
        .prepare(`UPDATE budget_pools SET used_usd = ? WHERE id = ?`)
        .run(roundMoney(addMoney(pool.usedUsd, usd)), poolId);
      return this.getPoolOrThrow(poolId);
    });
  }

  /**
   * Charge that CANNOT overdraw the pool.
   *
   * The pre-call reservation is only an estimate: the provider bills real
   * tokens. This is the last line of defence. When the actual cost would
   * exceed what remains, the pool is charged only what is left and the overage
   * is reported — so `availableUsd` never goes negative and a parent's
   * `releaseRemainder` stays meaningful.
   */
  /**
   * Charge that CANNOT overdraw the pool.
   *
   * Available credit is `amount_usd` minus what the LEDGER says was spent (the
   * authoritative book). This records `used_usd` for reporting and applies the
   * clamp so the pool is never oversubscribed. Returns the overage, which the
   * caller must surface: it means the provider billed more than the pool had.
   */
  chargeWithinPool(poolId: string, usd: number): { chargedUsd: number; overageUsd: number; exhausted: boolean } {
    return immediate(this.db, () => {
      const pool = this.getPoolOrThrow(poolId);
      const available = this.availableUsd(pool);
      const charged = available <= 0 ? 0 : lt(usd, available) ? usd : available;
      this.db
        .prepare(`UPDATE budget_pools SET used_usd = ? WHERE id = ?`)
        .run(roundMoney(addMoney(pool.usedUsd, charged)), poolId);
      return {
        chargedUsd: roundMoney(charged),
        overageUsd: roundMoney(usd - charged),
        exhausted: charged >= available,
      };
    });
  }

  /**
   * Checks whether a pool can absorb `usd` BEFORE spending it.
   *
   * A single LLM call can cost more than an entire subagent pool (a 1M-token
   * prompt is $0.14 on its own). Without this check the pool goes negative, the
   * remainder is meaningless, and the parent never gets anything back.
   * Callers must reserve/refuse rather than discover the overspend afterwards.
   */
  canAfford(poolId: string, usd: number): boolean {
    const pool = this.getPoolOrThrow(poolId);
    return gte(this.availableUsd(pool), usd);
  }

  /**
   * Estimate of a call's cost BEFORE making it.
   *
   * Input token counts on our side come from a `chars/4` approximation, which
   * routinely undershoots a real tokenizer (measured: 154 estimated vs 1000
   * billed on a tool-heavy transcript). We therefore apply a safety margin so
   * the reservation errs on the expensive side; refusing a marginal call is
   * cheaper than overdrafting a pool and corrupting the parent's release.
   */
  estimateCallCostUsd(args: {
    inputTokens: number;
    maxOutputTokens: number;
    unitPriceInUsd: number;
    unitPriceOutUsd: number;
    /** Multiplier applied to the estimated input tokens. Default 1.5. */
    inputSafetyFactor?: number;
  }): number {
    const factor = args.inputSafetyFactor ?? DEFAULT_INPUT_SAFETY_FACTOR;
    const billedInputTokens = Math.ceil(args.inputTokens * factor);
    return roundMoney(
      (billedInputTokens / 1_000_000) * args.unitPriceInUsd +
        (args.maxOutputTokens / 1_000_000) * args.unitPriceOutUsd,
    );
  }

  /**
   * Single verdict used by runs and subagents alike. Time and budget are
   * evaluated together because a subagent can be killed by either.
   */
  evaluate(args: {
    poolId: string;
    startedAtMs: number;
    maxDurationMs?: number;
    nowMs?: number;
  }): EnforcerVerdict {
    const pool = this.getPoolOrThrow(args.poolId);
    const spent = this.spentForPool(args.poolId);
    const budgetRatio = pool.amountUsd <= 0 ? (spent > 0 ? Infinity : 0) : spent / pool.amountUsd;

    const nowMs = args.nowMs ?? Date.now();
    const elapsed = nowMs - args.startedAtMs;
    const timeRatio = args.maxDurationMs && args.maxDurationMs > 0 ? elapsed / args.maxDurationMs : 0;

    if (budgetRatio >= HARD_KILL_BUDGET_RATIO) {
      return {
        action: 'kill',
        reason: `budget exhausted: $${spent.toFixed(6)} of $${pool.amountUsd.toFixed(6)} used`,
        budgetRatio,
        timeRatio,
      };
    }
    if (args.maxDurationMs && gte(timeRatio, HARD_KILL_BUDGET_RATIO)) {
      return {
        action: 'kill',
        reason: `time exhausted: ${elapsed}ms of ${args.maxDurationMs}ms`,
        budgetRatio,
        timeRatio,
      };
    }
    if (gte(budgetRatio, WRAP_UP_BUDGET_RATIO) || (args.maxDurationMs && timeRatio >= WRAP_UP_TIME_RATIO)) {
      const which = gte(budgetRatio, WRAP_UP_BUDGET_RATIO) ? 'budget' : 'time';
      return {
        action: 'wrap_up',
        reason: `wrap-up threshold reached on ${which}`,
        instruction:
          `You are at ${Math.round(which === 'budget' ? budgetRatio * 100 : timeRatio * 100)}% of your ${which} allowance. ` +
          `Stop exploring. Finish the current step, then produce your final answer now.`,
        budgetRatio,
        timeRatio,
      };
    }
    return { action: 'continue', budgetRatio, timeRatio };
  }
}

interface RawPool {
  id: string;
  parent_pool_id: string | null;
  owner_kind: string;
  owner_id: string;
  amount_usd: number;
  used_usd: number;
  released_usd: number;
  created_at: number;
}

function mapPool(r: RawPool): BudgetPool {
  return {
    id: r.id,
    parentPoolId: r.parent_pool_id,
    ownerKind: r.owner_kind as PoolOwnerKind,
    ownerId: r.owner_id,
    amountUsd: r.amount_usd,
    usedUsd: r.used_usd,
    releasedUsd: r.released_usd,
    createdAt: r.created_at,
  };
}
