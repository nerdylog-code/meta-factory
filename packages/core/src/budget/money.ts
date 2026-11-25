/**
 * Money helpers.
 *
 * Budgets are USD configured as decimals (e.g. 0.25). SQLite REAL is a double,
 * so `0.1 + 0.2 !== 0.3`. Every comparison in the budget path therefore goes
 * through `lte`/`gte` with a tolerance of 1e-12, and every mutation rounds to
 * nanodollars (1e-9) so long chains of small charges cannot drift into a false
 * "over budget" verdict.
 */

export const NANO = 1e9;

/** Rounds to nanodollar precision. */
export function roundMoney(usd: number): number {
  return Math.round(usd * NANO) / NANO;
}

export function addMoney(a: number, b: number): number {
  return roundMoney(a + b);
}

export function subMoney(a: number, b: number): number {
  return roundMoney(a - b);
}

export function lte(a: number, b: number): boolean {
  return a <= b + 1e-12;
}

export function lt(a: number, b: number): boolean {
  return a < b - 1e-12;
}

export function gte(a: number, b: number): boolean {
  return a >= b - 1e-12;
}

export function gt(a: number, b: number): boolean {
  return a > b + 1e-12;
}

/**
 * Cost of a call given token counts and a price snapshot (USD per 1M tokens,
 * the convention every provider uses).
 */
export function costUsd(
  tokensIn: number,
  tokensOut: number,
  unitPriceInUsd: number,
  unitPriceOutUsd: number,
): number {
  return roundMoney((tokensIn / 1_000_000) * unitPriceInUsd + (tokensOut / 1_000_000) * unitPriceOutUsd);
}

export function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  if (Math.abs(usd) < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(2)}`;
}
