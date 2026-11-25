import type { Tier, ThinkingLevel } from '../types.js';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Absent for pure tool-call assistant turns. */
  content?: string;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments as the model emitted them (a string, not parsed). */
  arguments: string;
}

export interface LlmToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmRequest {
  tier: Tier;
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  thinking?: ThinkingLevel;
  maxOutputTokens: number;
  temperature?: number;
  /** Free-form tag propagated to the ledger (turn | tool_summary | classifier | ...). */
  category?: string;
  /** Aborts the call. Providers must surface partial usage when this fires. */
  signal?: AbortSignal;
}

export interface LlmUsage {
  tokensIn: number;
  tokensOut: number;
  /** True when the numbers are a heuristic rather than reported by the provider. */
  estimated: boolean;
}

export interface LlmResponse {
  content: string;
  toolCalls: LlmToolCall[];
  usage: LlmUsage;
  aborted: boolean;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'aborted' | 'error';
  model: string;
  provider: string;
  /** Thinking/reasoning text when the provider exposes it. */
  thinking?: string;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** Streaming chunk for UI live-thinking. Optional capability. */
export interface LlmStreamChunk {
  delta: string;
  kind: 'text' | 'thinking' | 'tool_call';
}

export interface StreamingLlmProvider extends LlmProvider {
  stream(req: LlmRequest): AsyncIterable<LlmStreamChunk>;
}
