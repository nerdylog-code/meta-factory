import { estimateTokens, messagesTokenEstimate } from './fake.js';
import type { LlmProvider, LlmRequest, LlmResponse, LlmToolCall } from './types.js';

export interface OpenAiCompatibleOptions {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** USD per 1M input tokens — snapshot at construction for the ledger. */
  unitPriceInUsd: number;
  /** USD per 1M output tokens. */
  unitPriceOutUsd: number;
  /** Extra headers, e.g. providers that require a session id. */
  extraHeaders?: Record<string, string>;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Enable provider-side reasoning where supported. */
  supportsThinking?: boolean;
}

/**
 * Provider for any OpenAI-compatible `/chat/completions` endpoint
 * (Mistral, OpenAI, llama.cpp server, Ollama, OpenRouter, vLLM...).
 *
 * Deliberate choices:
 * - Prompt is always sent as chat messages; no provider SDK.
 * - `tools` use `inputSchema` converted from Zod upstream and passed through
 *   verbatim as JSON Schema.
 * - Usage is taken from the provider when present; when absent the numbers are
 *   flagged `estimated`, never silently treated as exact.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  readonly unitPriceInUsd: number;
  readonly unitPriceOutUsd: number;
  private readonly opts: OpenAiCompatibleOptions;
  private readonly doFetch: typeof fetch;

  constructor(opts: OpenAiCompatibleOptions) {
    this.opts = opts;
    this.name = opts.name;
    this.model = opts.model;
    this.unitPriceInUsd = opts.unitPriceInUsd;
    this.unitPriceOutUsd = opts.unitPriceOutUsd;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toWireMessages(req),
      max_tokens: req.maxOutputTokens,
      temperature: req.temperature ?? 0.2,
      stream: false,
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
      body.tool_choice = 'auto';
    }
    if (this.opts.supportsThinking && req.thinking && req.thinking !== 'off') {
      body.reasoning_effort = req.thinking;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 120_000);
    const onAbort = () => controller.abort();
    req.signal?.addEventListener('abort', onAbort);

    let res: Response;
    try {
      res = await this.doFetch(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.apiKey}`,
          ...(this.opts.extraHeaders ?? {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (req.signal?.aborted) return this.abortResponse(req);
      throw new ProviderHttpError(`Network error calling ${this.name}: ${(err as Error).message}`, 0, null);
    } finally {
      clearTimeout(timeout);
      req.signal?.removeEventListener('abort', onAbort);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderHttpError(`${this.name} returned HTTP ${res.status}`, res.status, text.slice(0, 2000));
    }

    const json = (await res.json()) as ChatCompletionResponse;
    return this.fromResponse(json, req);
  }

  private abortResponse(req: LlmRequest): LlmResponse {
    return {
      content: '',
      toolCalls: [],
      usage: { tokensIn: messagesTokenEstimate(req.messages), tokensOut: 0, estimated: true },
      aborted: true,
      finishReason: 'aborted',
      model: this.model,
      provider: this.name,
    };
  }

  private fromResponse(json: ChatCompletionResponse, req: LlmRequest): LlmResponse {
    const choice = json.choices?.[0];
    if (!choice) {
      throw new ProviderHttpError(`${this.name} returned no choices`, 200, JSON.stringify(json).slice(0, 1000));
    }
    const msg = choice.message ?? {};
    const toolCalls: LlmToolCall[] = (msg.tool_calls ?? []).map((tc, i) => ({
      id: tc.id ?? `call_${i}`,
      name: tc.function?.name ?? '',
      arguments: tc.function?.arguments ?? '{}',
    }));

    // Newer providers nest reasoning separately; keep it out of `content` so
    // the runner's messages stay valid for the next turn.
    const reasoning = (msg.reasoning_content ?? msg.reasoning) as string | undefined;

    const reportedIn = json.usage?.prompt_tokens;
    const reportedOut = json.usage?.completion_tokens;
    const estimated = reportedIn === undefined || reportedOut === undefined;

    const usage = {
      tokensIn: reportedIn ?? messagesTokenEstimate(req.messages),
      tokensOut: reportedOut ?? estimateTokens(msg.content ?? '') + toolCalls.reduce((n, t) => n + estimateTokens(t.arguments), 0),
      estimated,
    };

    const finish = mapFinish(choice.finish_reason, toolCalls.length);

    return {
      content: msg.content ?? '',
      toolCalls,
      usage,
      aborted: false,
      finishReason: finish,
      model: json.model ?? this.model,
      provider: this.name,
      ...(reasoning ? { thinking: reasoning } : {}),
    };
  }
}

function mapFinish(reason: string | undefined, toolCallCount: number): LlmResponse['finishReason'] {
  if (toolCallCount > 0) return 'tool_calls';
  switch (reason) {
    case 'length':
      return 'length';
    case 'tool_calls':
      return 'tool_calls';
    case 'stop':
    case 'end_turn':
      return 'stop';
    case undefined:
      return 'stop';
    default:
      return 'stop';
  }
}

export function toWireMessages(req: LlmRequest): unknown[] {
  return req.messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content ?? '', tool_call_id: m.toolCallId };
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: m.content ?? null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    return { role: m.role, content: m.content ?? '' };
  });
}

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string | null,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
      reasoning_content?: string | null;
      reasoning?: string | null;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}
