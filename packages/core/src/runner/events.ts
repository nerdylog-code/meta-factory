/**
 * Run event taxonomy.
 *
 * The durability contract depends on these being distinguishable, so they are a
 * closed union rather than free strings:
 * - `tool_call_started` with no matching `tool_result` (same toolCallId) is the
 *   exact marker `recoverRun` looks for.
 * - Recovery itself appends `tool_result` (unknown_after_crash) or
 *   `tool_call_replayed`, so the log stays append-only.
 */
export type RunEventType =
  | 'run_created'
  | 'run_started'
  | 'turn_started'
  | 'llm_requested'
  | 'llm_responded'
  | 'thinking'
  | 'tool_call_started'
  | 'tool_result'
  | 'tool_call_replayed'
  | 'gate_opened'
  | 'gate_resolved'
  | 'gate_replayed'
  | 'status_changed'
  | 'budget_warning'
  | 'budget_killed'
  | 'compacted'
  | 'tool_summary'
  | 'error'
  | 'run_completed';

export interface RunEvent<T = unknown> {
  id: number;
  runId: string;
  seq: number;
  type: RunEventType;
  payload: T;
  actor: unknown;
  createdAt: number;
}

export interface ToolCallStartedPayload {
  toolCallId: string;
  name: string;
  input: unknown;
  idempotent: boolean;
}

export interface ToolResultPayload {
  toolCallId: string;
  name: string;
  /** 'unknown_after_crash' is written by recovery for non-idempotent tools. */
  status: 'ok' | 'error' | 'pending_approval' | 'unknown_after_crash' | 'rejected';
  result?: unknown;
  error?: string;
  gateId?: string;
}

export interface LlmRequestedPayload {
  turn: number;
  tier: string;
  provider: string;
  model: string;
  maxOutputTokens: number;
  inputTokens: number;
  remainingUsd: number;
}

export interface LlmRespondedPayload {
  turn: number;
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  aborted: boolean;
  finishReason: string;
  estimated: boolean;
}
