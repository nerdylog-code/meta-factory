import type { LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmToolCall } from './types.js';

/**
 * Typed script steps. Tests author these; nothing else should.
 */
export type FakeStep =
  | { type: 'text'; content: string; thinking?: string }
  | { type: 'tool_call'; name: string; args: unknown; callId?: string }
  | {
      type: 'stream_then_abort';
      /** Text emitted before the abort is signalled. */
      partialContent: string;
      /** Tokens the provider claims it consumed before the abort. */
      partialTokensOut: number;
    }
  | { type: 'crash_process'; after?: 'nothing' | 'tool_call_started' };

export interface FakeLLMProviderOptions {
  /** Default script used for every tier when `scripts` has no entry. */
  script: FakeStep[];
  /** Per-tier scripts. A tier without an entry falls back to `script`. */
  scripts?: Partial<Record<string, FakeStep[]>>;
  providerName?: string;
  model?: string;
  /** Token accounting for `text`/`tool_call` steps when the test doesn't care. */
  tokensIn?: number;
  tokensOut?: number;
}

/**
 * Deterministic provider. First-class in core, not a test double bolted on:
 * every phase's acceptance criteria run through it, and the real provider must
 * satisfy the same contract.
 *
 * Scripts are consumed one step per call. When a script is exhausted the
 * provider throws, so a run that calls the model more times than the test
 * planned fails loudly instead of returning empty content.
 */
export class FakeLLMProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  private readonly scripts: Map<string, FakeStep[]>;
  private readonly counters = new Map<string, number>();
  private readonly fallback: FakeStep[];
  private readonly tokensIn: number;
  private readonly tokensOut: number;
  /** Every request received, for assertions on prompt assembly. */
  readonly requests: LlmRequest[] = [];

  constructor(opts: FakeLLMProviderOptions) {
    this.name = opts.providerName ?? 'fake';
    this.model = opts.model ?? 'fake-model';
    this.fallback = opts.script;
    this.scripts = new Map(
      Object.entries(opts.scripts ?? {}).filter((e): e is [string, FakeStep[]] => e[1] !== undefined),
    );
    this.tokensIn = opts.tokensIn ?? 10;
    this.tokensOut = opts.tokensOut ?? 5;
  }

  private nextStep(tier: string): FakeStep {
    const script = this.scripts.get(tier) ?? this.fallback;
    const idx = this.counters.get(tier) ?? 0;
    const step = script[idx];
    if (!step) {
      throw new Error(
        `FakeLLMProvider: script for tier '${tier}' exhausted after ${idx} call(s). ` +
          `Add more steps or fix the run loop.`,
      );
    }
    this.counters.set(tier, idx + 1);
    return step;
  }

  peekRemaining(tier: string): number {
    const script = this.scripts.get(tier) ?? this.fallback;
    return script.length - (this.counters.get(tier) ?? 0);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const step = this.nextStep(req.tier);

    switch (step.type) {
      case 'text':
        return this.build(req, {
          content: step.content,
          toolCalls: [],
          finishReason: 'stop',
          thinking: step.thinking,
        });

      case 'tool_call': {
        const call: LlmToolCall = {
          id: step.callId ?? `call_${req.tier}_${this.counters.get(req.tier)}`,
          name: step.name,
          arguments: JSON.stringify(step.args ?? {}),
        };
        return this.build(req, {
          content: '',
          toolCalls: [call],
          finishReason: 'tool_calls',
        });
      }

      case 'stream_then_abort': {
        // Simulates a provider that stops mid-stream. The partial text is
        // consumed and billed: that is the whole point of the test.
        return {
          content: step.partialContent,
          toolCalls: [],
          usage: { tokensIn: this.tokensIn, tokensOut: step.partialTokensOut, estimated: true },
          aborted: true,
          finishReason: 'aborted',
          model: this.model,
          provider: this.name,
        };
      }

      case 'crash_process': {
        // Thrown, not returned: callers must not swallow this into a normal
        // response. Durability is exercised by the runner tests that catch it.
        throw new SimulatedCrashError(step.after ?? 'nothing');
      }
    }
  }

  private build(
    req: LlmRequest,
    partial: Pick<LlmResponse, 'content' | 'toolCalls' | 'finishReason' | 'thinking'>,
  ): LlmResponse {
    return {
      ...partial,
      usage: { tokensIn: this.tokensIn, tokensOut: this.tokensOut, estimated: false },
      aborted: false,
      model: this.model,
      provider: this.name,
    };
  }
}

/** Signals the fake provider was told to die mid-run. */
export class SimulatedCrashError extends Error {
  constructor(readonly after: 'nothing' | 'tool_call_started') {
    super(`SimulatedCrashError(after=${after})`);
    this.name = 'SimulatedCrashError';
  }
}

/** Rough token estimate used when a provider reports nothing. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // ~4 chars/token is the conventional English approximation; good enough for
  // an *estimate* flag, never for billing a real provider.
  return Math.max(1, Math.ceil(text.length / 4));
}

export function messagesTokenEstimate(messages: LlmMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += 4; // per-message overhead
    if (m.content) n += estimateTokens(m.content);
    for (const tc of m.toolCalls ?? []) {
      n += estimateTokens(tc.name) + estimateTokens(tc.arguments);
    }
  }
  return n;
}
