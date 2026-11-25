import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Db } from '../db/client.js';
import { tokenLedger } from '../db/drizzle-schema.js';
import { roundMoney } from './money.js';

/**
 * Reads over the token ledger, expressed in Drizzle.
 *
 * This is the read half of `TokenLedger` (which keeps its hand-written
 * INSERT because it runs inside transactions shared with the runner). Moving
 * the READS first is deliberate: they are the same result regardless of driver,
 * so the migration is verifiable, and they are what the UI hammers.
 *
 * The raw `Db` handle is still the connection; Drizzle wraps the same handle, so
 * writes made through plain SQL are immediately visible here.
 */
export class LedgerQueries {
  private readonly d: BetterSQLite3Database;

  constructor(db: Db) {
    this.d = drizzle(db);
  }

  /** Total USD spent from a pool, straight from the ledger (the true book). */
  totalForPool(poolId: string): number {
    const row = this.d
      .select({ total: sql<number>`COALESCE(SUM(${tokenLedger.costUsd}), 0)` })
      .from(tokenLedger)
      .where(eq(tokenLedger.poolId, poolId))
      .get();
    return roundMoney(row?.total ?? 0);
  }

  /** Aggregate for the live Tokenomics bar. */
  summary(filter: { runId?: string } = {}) {
    const rows = filter.runId
      ? this.d.select().from(tokenLedger).where(eq(tokenLedger.runId, filter.runId)).all()
      : this.d.select().from(tokenLedger).all();

    const out = {
      totalCostUsd: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      estimatedCostUsd: 0,
      abortedCostUsd: 0,
      byCategory: {} as Record<string, { costUsd: number; tokensIn: number; tokensOut: number; calls: number }>,
      byModel: {} as Record<string, { costUsd: number; tokensIn: number; tokensOut: number; calls: number }>,
    };

    for (const r of rows) {
      out.totalCostUsd = roundMoney(out.totalCostUsd + r.costUsd);
      out.totalTokensIn += r.tokensIn;
      out.totalTokensOut += r.tokensOut;
      if (r.isEstimated) out.estimatedCostUsd = roundMoney(out.estimatedCostUsd + r.costUsd);
      if (r.aborted) out.abortedCostUsd = roundMoney(out.abortedCostUsd + r.costUsd);

      const cat = (out.byCategory[r.category] ??= { costUsd: 0, tokensIn: 0, tokensOut: 0, calls: 0 });
      cat.costUsd = roundMoney(cat.costUsd + r.costUsd);
      cat.tokensIn += r.tokensIn;
      cat.tokensOut += r.tokensOut;
      cat.calls += 1;

      const model = (out.byModel[r.model] ??= { costUsd: 0, tokensIn: 0, tokensOut: 0, calls: 0 });
      model.costUsd = roundMoney(model.costUsd + r.costUsd);
      model.tokensIn += r.tokensIn;
      model.tokensOut += r.tokensOut;
      model.calls += 1;
    }
    return out;
  }

  /** Most recent entries, newest first. */
  recent(limit = 100) {
    return this.d.select().from(tokenLedger).orderBy(desc(tokenLedger.id)).limit(limit).all();
  }

  forRun(runId: string) {
    return this.d.select().from(tokenLedger).where(eq(tokenLedger.runId, runId)).orderBy(tokenLedger.id).all();
  }

  /** Spend per category for one run — the "price of observability" split. */
  byCategoryForRun(runId: string): Array<{ category: string; costUsd: number; calls: number }> {
    return this.d
      .select({
        category: tokenLedger.category,
        costUsd: sql<number>`COALESCE(SUM(${tokenLedger.costUsd}), 0)`,
        calls: sql<number>`COUNT(*)`,
      })
      .from(tokenLedger)
      .where(eq(tokenLedger.runId, runId))
      .groupBy(tokenLedger.category)
      .all();
  }

  /** Aborted/partial spend, which must never be presented as a normal cost. */
  abortedForRun(runId: string) {
    return this.d
      .select()
      .from(tokenLedger)
      .where(and(eq(tokenLedger.runId, runId), eq(tokenLedger.aborted, true)))
      .all();
  }
}
