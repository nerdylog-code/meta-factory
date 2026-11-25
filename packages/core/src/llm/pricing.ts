/**
 * Price table: USD per 1,000,000 tokens.
 *
 * Every number here is a SNAPSHOT that gets written into `token_ledger` with the
 * call. Changing a price here never rewrites past spend.
 *
 * `unknown: true` means we do not have a published number for that model on
 * this account. Calls still work; the ledger records the entry with
 * `is_estimated: true` so Tokenomics never presents a guess as a fact.
 */
export interface ModelPrice {
  in: number;
  out: number;
  unknown: boolean;
}

const PRICES: Record<string, ModelPrice> = {
  // --- Mistral account (this project's primary provider) -----------------
  // Reasoning-capable, 1M context. Prices are per Mistral's published sheet;
  // verify against your invoice before trusting Tokenomics for accounting.
  'deepseek-v4-1-flash-1017': { in: 0.14, out: 0.28, unknown: false },
  // Cheap Tier C/D model used for tool summaries and the proactive classifier.
  'ministral-3b-latest': { in: 0.04, out: 0.04, unknown: false },
  'ministral-3b-2512': { in: 0.04, out: 0.04, unknown: false },
  'ministral-8b-latest': { in: 0.1, out: 0.1, unknown: false },
  'mistral-large-latest': { in: 2.0, out: 6.0, unknown: false },
  'mistral-medium-latest': { in: 0.4, out: 2.0, unknown: false },
  'mistral-small-latest': { in: 0.1, out: 0.3, unknown: false },
  'codestral-latest': { in: 0.3, out: 0.9, unknown: false },

  // --- Local providers: free at the margin, but not free -----------------
  // llama.cpp / Ollama consume electricity and wall-clock; we record $0 so the
  // budget enforcer does not throttle them, and mark them known.
  'local': { in: 0, out: 0, unknown: false },
};

/** Fallback for models we have no published price for. */
const UNKNOWN_PRICE: ModelPrice = { in: 0, out: 0, unknown: true };

export function getModelPrice(model: string): ModelPrice {
  const direct = PRICES[model];
  if (direct) return direct;
  // Match alias suffixes such as `-latest` or dated snapshots against a family.
  const family = Object.keys(PRICES).find((k) => model.startsWith(k.split('-').slice(0, 2).join('-')));
  if (family) return PRICES[family]!;
  return UNKNOWN_PRICE;
}

export function listKnownPrices(): Array<{ model: string } & ModelPrice> {
  return Object.entries(PRICES).map(([model, p]) => ({ model, ...p }));
}

/** Overrides come from Settings so a user can correct a stale snapshot. */
export function withOverrides(overrides: Record<string, ModelPrice>): (model: string) => ModelPrice {
  return (model: string) => overrides[model] ?? getModelPrice(model);
}
