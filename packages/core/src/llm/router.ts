import { z } from 'zod';
import { roundMoney } from '../budget/money.js';
import { getModelPrice } from './pricing.js';
import type { LlmMessage, LlmProvider, LlmRequest, LlmResponse } from './types.js';
import { estimateTokens, messagesTokenEstimate } from './fake.js';
import { TIERS, type Tier, type ThinkingLevel } from '../types.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';

export const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['openai-compatible', 'fake']).default('openai-compatible'),
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().default('MISTRAL_API_KEY'),
  /** Extra static headers (never contains the key itself). */
  extraHeaders: z.record(z.string(), z.string()).default({}),
  supportsThinking: z.boolean().default(false),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const TierRouteSchema = z.object({
  tier: z.enum(TIERS),
  providerId: z.string().min(1),
  /** The REAL model name. Never a friendly alias: sovereignty means seeing truth. */
  model: z.string().min(1),
  thinking: z.enum(['off', 'low', 'medium', 'high']).default('off'),
  maxOutputTokens: z.number().int().positive().default(4096),
  temperature: z.number().min(0).max(2).default(0.2),
  contextLimitTokens: z.number().int().positive().default(128_000),
});
export type TierRoute = z.infer<typeof TierRouteSchema>;

export const RouterConfigSchema = z.object({
  providers: z.array(ProviderConfigSchema).min(1),
  routes: z.array(TierRouteSchema).min(1),
  compaction: z
    .object({
      enabled: z.boolean().default(true),
      /** Compact when the prompt exceeds this fraction of the model context. */
      triggerRatio: z.number().min(0.1).max(1).default(0.75),
      /** Messages kept verbatim at the tail after compaction. */
      keepLastMessages: z.number().int().min(1).default(6),
    })
    .default({ enabled: true, triggerRatio: 0.75, keepLastMessages: 6 }),
});
export type RouterConfig = z.infer<typeof RouterConfigSchema>;

export interface RouterDeps {
  /** Resolves the API key for a provider id. Never logged. */
  resolveApiKey(providerId: string, envVar: string): string | undefined;
  createProvider?(cfg: ProviderConfig, model: string, apiKey: string): LlmProvider;
  compactionProvider?: LlmProvider;
}

export interface RoutedCall {
  response: LlmResponse;
  route: TierRoute;
  price: { in: number; out: number };
  /** True when auto-compaction ran before this call. */
  compacted: boolean;
}

/**
 * Maps tiers to concrete providers+models.
 *
 * The UI shows `provider/model` verbatim so there is never doubt about who is
 * answering, and every call returns the price snapshot the ledger must store.
 */
export class LlmRouter {
  private readonly providers = new Map<string, LlmProvider>();
  private readonly routes = new Map<Tier, TierRoute>();
  private readonly config: RouterConfig;

  constructor(config: RouterConfig, deps: RouterDeps) {
    this.config = RouterConfigSchema.parse(config);
    for (const p of this.config.providers) {
      if (p.kind === 'fake') continue;
      const key = deps.resolveApiKey(p.id, p.apiKeyEnv);
      if (!key) {
        // Do not throw at construction: a factory may route some tiers to a
        // local provider. The error surfaces when that tier is actually used.
        continue;
      }
      const route = this.config.routes.find((r) => r.providerId === p.id);
      const model = route?.model ?? '';
      const provider = deps.createProvider
        ? deps.createProvider(p, model, key)
        : new OpenAiCompatibleProvider({
            name: p.id,
            baseUrl: p.baseUrl ?? '',
            apiKey: key,
            model,
            unitPriceInUsd: getModelPrice(model).in,
            unitPriceOutUsd: getModelPrice(model).out,
            extraHeaders: p.extraHeaders,
            supportsThinking: p.supportsThinking,
          });
      this.providers.set(p.id, provider);
    }
    for (const r of this.config.routes) {
      this.routes.set(r.tier, r);
    }
  }

  /** Register a provider implementation directly (used for FakeLLM and tests). */
  setProvider(providerId: string, provider: LlmProvider): void {
    this.providers.set(providerId, provider);
  }

  route(tier: Tier): TierRoute {
    const r = this.routes.get(tier);
    if (!r) throw new Error(`No route configured for tier ${tier}`);
    return r;
  }

  /** Total transparency: the exact provider/model behind each tier. */
  describeRoutes(): Array<{ tier: Tier; providerId: string; model: string; thinking: ThinkingLevel; price: { in: number; out: number } }> {
    return [...this.routes.values()].map((r) => ({
      tier: r.tier,
      providerId: r.providerId,
      model: r.model,
      thinking: r.thinking,
      price: getModelPrice(r.model),
    }));
  }

  providerFor(tier: Tier): LlmProvider {
    const route = this.route(tier);
    const p = this.providers.get(route.providerId);
    if (!p) {
      throw new Error(
        `Provider '${route.providerId}' is not available for tier ${tier}. ` +
          `Check that its API key variable is set.`,
      );
    }
    return p;
  }

  /**
   * Applies auto-compaction when the prompt would exceed the configured
   * ratio of the context window. Returns the (possibly new) messages.
   */
  async maybeCompact(
    messages: LlmMessage[],
    tier: Tier,
    compact: (msgs: LlmMessage[]) => Promise<LlmMessage[]>,
  ): Promise<{ messages: LlmMessage[]; compacted: boolean }> {
    if (!this.config.compaction.enabled) return { messages, compacted: false };
    const route = this.route(tier);
    const estimated = messagesTokenEstimate(messages);
    const limit = route.contextLimitTokens * this.config.compaction.triggerRatio;
    if (estimated <= limit) return { messages, compacted: false };
    const compacted = await compact(messages);
    return { messages: compacted, compacted: true };
  }

  async call(
    tier: Tier,
    req: Omit<LlmRequest, 'tier'> & { tier?: never },
  ): Promise<RoutedCall> {
    const route = this.route(tier);
    const provider = this.providerFor(tier);
    const price = getModelPrice(route.model);
    const response = await provider.complete({
      ...req,
      tier,
      thinking: req.thinking ?? route.thinking,
      temperature: req.temperature ?? route.temperature,
      maxOutputTokens: req.maxOutputTokens ?? route.maxOutputTokens,
    });

    // Guard: a provider reporting fantasy usage must not silently corrupt the
    // ledger. If nothing was reported we keep the estimate AND say so.
    const tokensIn = response.usage.tokensIn >= 0 ? response.usage.tokensIn : estimateTokens(JSON.stringify(req.messages));
    const tokensOut = response.usage.tokensOut >= 0 ? response.usage.tokensOut : estimateTokens(response.content);

    return {
      response: { ...response, usage: { tokensIn, tokensOut, estimated: response.usage.estimated } },
      route,
      price: { in: roundMoney(price.in), out: roundMoney(price.out) },
      compacted: false,
    };
  }
}
