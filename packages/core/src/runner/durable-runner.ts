import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import { immediate } from '../db/client.js';
import { BudgetEnforcer, deriveMaxOutputTokens } from '../budget/enforcer.js';
import { costUsd, roundMoney } from '../budget/money.js';
import { TokenLedger } from '../budget/ledger.js';
import { SqliteGateStore, type CommandBus, type StoredGate } from '../bus/command-bus.js';
import { ConflictError, NotFoundError } from '../errors.js';
import type { LlmProvider, LlmResponse } from '../llm/types.js';
import { messagesTokenEstimate } from '../llm/fake.js';
import type { LlmMessage } from '../llm/types.js';
import {
  type Actor,
  type AgentActor,
  type Tier,
  isTerminalStatus,
} from '../types.js';
import {
  type LlmRespondedPayload,
  type LlmRequestedPayload,
  type RunEvent,
  type RunEventType,
  type ToolCallStartedPayload,
  type ToolResultPayload,
} from './events.js';
import type { ToolActivity, ToolSummarizer } from './tool-summary.js';

export interface RunRow {
  id: string;
  factoryId: string;
  agentId: string | null;
  goal: string;
  status: string;
  tier: Tier;
  poolId: string | null;
  turn: number;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
}

/**
 * Default ceiling for one model call.
 *
 * Sized so a full generated page or a long file write fits in a single tool
 * call. The budget enforcer still caps the real value per pool, so this is a
 * ceiling, not a grant.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** How many times a run may be nudged after an output truncation. */
export const MAX_TRUNCATION_RETRIES = 2;

export interface StartRunArgs {
  factoryId: string;
  agentId?: string;
  goal: string;
  tier: Tier;
  poolId: string;
  systemPrompt: string;
  maxTurns?: number;
  /**
   * Per-call output ceiling. Further clamped by the budget enforcer, which
   * prices what the pool can afford.
   */
  maxOutputTokens?: number;
  /** Cooperative cancellation. Also used by tests to stop a loop. */
  signal?: AbortSignal;
}

export interface RunnerDeps {
  db: Db;
  bus: CommandBus;
  ledger: TokenLedger;
  budget: BudgetEnforcer;
  /**
   * Provider + price used by default. A run may name a different tier; in that
   * case `providerFor(tier)` is consulted instead.
   */
  provider: LlmProvider;
  /** USD per 1M tokens for the provider, snapshotted into every ledger row. */
  price: { in: number; out: number };
  /**
   * Resolves provider + price for a specific tier. Without it, every run uses
   * the default provider regardless of its requested tier — which would
   * silently route an S-tier run to a D-tier model.
   */
  providerFor?(tier: Tier): { provider: LlmProvider; price: { in: number; out: number } };
  /** System prompt sections from registered harnesses, joined for the model. */
  renderSystemPrompt?(args: StartRunArgs): string;
  /** Optional hook fired on every appended event (SSE fan-out). */
  onEvent?(ev: RunEvent): void;
  /** Optional UI/stream hook for assistant text. */
  onChunk?(runId: string, chunk: { kind: 'text' | 'thinking'; delta: string }): void;
  /**
   * Summarizes tool batches into one-liners for the human supervisor. Optional:
   * without it, the event feed simply shows raw tool results.
   */
  summarizer?: ToolSummarizer;
}

/** Supplies the system prompt a resumed run should use. */
export interface RunPromptProvider {
  forRun(run: RunRow): string;
}

/** The provider/price pair a given run should use. */
export interface RunTarget {
  provider: LlmProvider;
  price: { in: number; out: number };
}

interface ToolCallState {
  toolCallId: string;
  name: string;
  input: unknown;
  idempotent: boolean;
  started: boolean;
  resolved: boolean;
  result?: ToolResultPayload;
}

/** Reconstruction of a run's durable state from `run_events`. */
export interface RecoveredState {
  runId: string;
  status: string;
  turn: number;
  events: RunEvent[];
  /** tool calls with a `tool_call_started` but no `tool_result` */
  dangling: ToolCallState[];
  /** Number of completed turns, derived from `turn_started` events. */
  completedTurns: number;
  lastAssistantContent: string | null;
}

/**
 * Durable, crash-recoverable agent loop over SQLite.
 *
 * Two guarantees, both enforced by `appendEvents`:
 * 1. Every event append happens in the SAME transaction as the run's status
 *    update, so no event can exist for a status that was never persisted.
 * 2. `recoverRun` derives state from the event log alone; it never trusts the
 *    in-memory loop.
 */
export class DurableRunner {
  readonly gates: SqliteGateStore;
  private readonly db: Db;
  private readonly listeners: Set<(ev: RunEvent) => void> = new Set();
  private readonly running = new Set<string>();
  /**
   * Set during shutdown. Once true, the loop stops at the next safe point and
   * never touches SQLite again.
   *
   * Two distinct hazards motivate this:
   *  1. Writing after close() throws "database connection is not open" and,
   *     worse, can finalize a statement during teardown, which is a NATIVE
   *     assertion on some better-sqlite3/Node combinations — a process kill,
   *     not an exception.
   *  2. A wake-run from the proactive pipeline can still be mid-flight when the
   *     server is asked to stop.
   * The durable event log means stopping at a turn boundary loses nothing.
   */
  private shuttingDown = false;
  /** Per-run abort controllers, so a running loop can be cancelled by id. */
  private readonly aborts = new Map<string, AbortController>();

  constructor(private readonly deps: RunnerDeps) {
    this.db = deps.db;
    this.gates = new SqliteGateStore(deps.db);
    deps.bus.setGateStore(this.gates);
    deps.bus.setRunPauser({
      // The bus calls this when it opens a gate for an agent actor.
      pauseForGate: (runId: string, gateId: string) => {
        this.appendEvents(runId, [{ type: 'gate_opened', payload: { gateId } }], {
          status: 'paused_gate',
        });
      },
    });
  }

  // ------------------------------------------------------------ event log

  subscribe(fn: (ev: RunEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getEvents(runId: string, afterSeq = 0): RunEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC`)
      .all(runId, afterSeq) as RawEvent[];
    return rows.map(mapEvent);
  }

  /**
   * Appends events and optionally updates run status atomically.
   * Returns the inserted events with their assigned seq values.
   */
  appendEvents(
    runId: string,
    events: Array<{ type: RunEventType; payload?: unknown; actor?: Actor }>,
    statusChange?: { status: string; error?: unknown },
  ): RunEvent[] {
    // Shutdown guard: writing after the connection starts closing is a process
    // kill (native assertion), not an exception. Refuse quietly here; the
    // caller's `finally` blocks still run.
    if (this.shuttingDown) return [];
    const inserted = immediate(this.db, () => {
      const run = this.getRun(runId);
      if (!run) throw new NotFoundError(`Run ${runId} not found`);

      const seqRow = this.db
        .prepare(`SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM run_events WHERE run_id = ?`)
        .get(runId) as { maxSeq: number };
      let seq = seqRow.maxSeq;
      const now = Date.now();
      const out: RunEvent[] = [];
      const fallbackActor: AgentActor = {
        kind: 'agent',
        role: 'lead',
        agentId: run.agentId ?? 'runner',
        runId,
        toolCallId: '',
      };

      for (const ev of events) {
        seq += 1;
        const actor: Actor = ev.actor ?? fallbackActor;
        const info = this.db
          .prepare(
            `INSERT INTO run_events (run_id, seq, type, payload_json, actor_json, created_at)
             VALUES (?,?,?,?,?,?)`,
          )
          .run(runId, seq, ev.type, JSON.stringify(ev.payload ?? {}), JSON.stringify(actor), now);
        out.push({
          id: Number(info.lastInsertRowid),
          runId,
          seq,
          type: ev.type,
          payload: ev.payload ?? {},
          actor,
          createdAt: now,
        });
      }

      if (statusChange) {
        const ended = isTerminalStatus(statusChange.status) ? now : null;
        this.db
          .prepare(`UPDATE runs SET status = ?, updated_at = ?, ended_at = COALESCE(?, ended_at), error_json = ? WHERE id = ?`)
          .run(
            statusChange.status,
            now,
            ended,
            statusChange.error === undefined ? null : JSON.stringify(statusChange.error),
            runId,
          );
      } else {
        this.db.prepare(`UPDATE runs SET updated_at = ? WHERE id = ?`).run(now, runId);
      }
      return out;
    });

    for (const e of inserted) {
      for (const l of this.listeners) {
        try {
          l(e);
        } catch {
          /* listener failures must not corrupt the run */
        }
      }
    }
    return inserted;
  }

  // ---------------------------------------------------------------- runs

  getRun(runId: string): RunRow | null {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as RawRun | undefined;
    return row ? mapRun(row) : null;
  }

  listRuns(limit = 50): RunRow[] {
    const rows = this.db.prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`).all(limit) as RawRun[];
    return rows.map(mapRun);
  }

  createRun(args: Omit<StartRunArgs, 'signal'>): RunRow {
    const id = randomUUID();
    const now = Date.now();
    immediate(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO runs (id, factory_id, agent_id, goal, status, tier, pool_id, turn, created_at, updated_at)
           VALUES (?,?,?,?,'pending',?,?,0,?,?)`,
        )
        .run(id, args.factoryId, args.agentId ?? null, args.goal, args.tier, args.poolId, now, now);
    });
    this.appendEvents(id, [{ type: 'run_created', payload: { goal: args.goal, tier: args.tier } }]);
    return this.getRun(id)!;
  }

  /**
   * Runs the agent loop on a NEW run.
   *
   * Prefer `startExisting` when the caller needs the run id before the loop
   * begins (e.g. to return it from an HTTP request), otherwise the id is only
   * available after the loop finishes.
   */
  async startRun(args: StartRunArgs): Promise<RunRow> {
    const run = this.createRun(args);
    return this.executeLoop(run.id, args);
  }

  /**
   * Runs the loop on a run created by `createRun`.
   *
   * Creating the run outside lets the HTTP layer return an id immediately and
   * start the loop without awaiting — and without creating a second run.
   */
  async startExisting(runId: string, args: StartRunArgs): Promise<RunRow> {
    const run = this.getRun(runId);
    if (!run) throw new NotFoundError(`Run ${runId} not found`);
    if (isTerminalStatus(run.status)) {
      throw new ConflictError(`Run ${runId} is ${run.status} and cannot be started`);
    }
    return this.executeLoop(runId, args);
  }

  /** Continues a paused run from its durable state. */
  async resumeRun(runId: string, args: Omit<StartRunArgs, 'goal' | 'factoryId' | 'tier' | 'poolId'>): Promise<RunRow> {
    const run = this.getRun(runId);
    if (!run) throw new NotFoundError(`Run ${runId} not found`);
    if (isTerminalStatus(run.status)) {
      throw new ConflictError(`Run ${runId} is ${run.status} and cannot be resumed`);
    }
    return this.executeLoop(runId, {
      factoryId: run.factoryId,
      agentId: run.agentId ?? undefined,
      goal: run.goal,
      tier: run.tier,
      poolId: run.poolId ?? '',
      systemPrompt: args.systemPrompt,
      maxTurns: args.maxTurns,
      signal: args.signal,
    });
  }

  /** The provider/price a run's tier resolves to. */
  targetFor(tier: Tier): RunTarget {
    if (this.deps.providerFor) return this.deps.providerFor(tier);
    return { provider: this.deps.provider, price: this.deps.price };
  }

  /**
   * Begins shutdown: the loop stops at the next turn boundary and no further
   * database writes are attempted. Call this BEFORE closing the db.
   */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  /** True while any run loop is executing (used to wait before closing). */
  get activeRunCount(): number {
    return this.running.size;
  }

  /**
   * Cancels a run that is executing right now.
   *
   * The abort is cooperative: the loop checks the signal between turns and the
   * provider receives it, so a stream in flight is cut rather than waited on.
   * Whatever was already spent stays in the ledger (the partial-usage path is
   * the normal accounting one), and the run ends as `cancelled` instead of
   * silently disappearing.
   */
  stopRun(
    runId: string,
    reason = 'stopped by human',
  ): { status: 'stopped' | 'not_running' | 'not_found'; run: RunRow | null; spentUsd: number } {
    const run = this.getRun(runId);
    if (!run) return { status: 'not_found', run: null, spentUsd: 0 };

    const controller = this.aborts.get(runId);
    if (!controller || !this.running.has(runId)) {
      return { status: 'not_running', run, spentUsd: this.ledgerSpend(runId) };
    }

    // Record the intent BEFORE aborting, so the log explains why the loop ends
    // even if the abort lands exactly between two turns.
    this.appendEvents(runId, [{ type: 'status_changed', payload: { note: 'stop requested', reason } }]);
    controller.abort();
    return { status: 'stopped', run: this.getRun(runId), spentUsd: this.ledgerSpend(runId) };
  }

  private ledgerSpend(runId: string): number {
    try {
      return this.deps.ledger.summary({ runId }).totalCostUsd;
    } catch {
      return 0;
    }
  }

  /**
   * Waits for in-flight loops to reach a boundary. Returns false on timeout, in
   * which case the caller must NOT close the database: a native assertion would
   * kill the process instead of throwing.
   */
  async drain(timeoutMs = 5000): Promise<boolean> {
    this.beginShutdown();
    const deadline = Date.now() + timeoutMs;
    while (this.running.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return this.running.size === 0;
  }

  private async executeLoop(runId: string, args: StartRunArgs): Promise<RunRow> {
    if (this.running.has(runId)) {
      throw new ConflictError(`Run ${runId} is already executing`);
    }
    this.running.add(runId);

    /**
     * One controller per executing run, composed with any caller signal.
     *
     * The runner owns this so `stopRun` can cancel a run that is already in
     * flight — an external signal alone cannot be aborted by us. Composing
     * keeps a caller's own cancellation working.
     */
    const controller = new AbortController();
    if (args.signal) {
      if (args.signal.aborted) controller.abort();
      else args.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    this.aborts.set(runId, controller);
    args = { ...args, signal: controller.signal };

    const maxTurns = args.maxTurns ?? 12;
    const systemPrompt = this.deps.renderSystemPrompt?.(args) ?? args.systemPrompt;
    // Resolve once per execution so a resume uses the same tier mapping.
    const target = this.targetFor(args.tier);

    try {
      this.appendEvents(runId, [{ type: 'run_started', payload: { maxTurns } }], { status: 'running' });

      let truncations = 0;
      let truncationNote: string | undefined;

      for (let turn = 1; turn <= maxTurns; turn++) {
        if (this.shuttingDown) {
          // Shutdown requested: leave the run durable (its status stays as it
          // was) rather than writing to a connection that is going away.
          return this.getRun(runId)!;
        }
        if (args.signal?.aborted) {
          return this.finish(runId, 'cancelled');
        }
        const state = this.recoverRun(runId);
        const currentRun = this.getRun(runId)!;
        if (currentRun.status === 'paused_gate' || currentRun.status === 'paused_human') {
          return currentRun;
        }
        if (isTerminalStatus(currentRun.status)) return currentRun;

        const verdict = this.deps.budget.evaluate({ poolId: args.poolId, startedAtMs: currentRun.createdAt });
        if (verdict.action === 'kill') {
          this.appendEvents(
            runId,
            [{ type: 'budget_killed', payload: { reason: verdict.reason, budgetRatio: verdict.budgetRatio } }],
            { status: 'killed_budget' },
          );
          return this.getRun(runId)!;
        }
        if (verdict.action === 'wrap_up') {
          this.appendEvents(runId, [{ type: 'budget_warning', payload: { instruction: verdict.instruction } }]);
        }

        this.appendEvents(runId, [{ type: 'turn_started', payload: { turn } }]);
        this.db.prepare(`UPDATE runs SET turn = ? WHERE id = ?`).run(turn, runId);

        const messages = this.buildMessages(systemPrompt, runId, args.goal, state, verdict.instruction, truncationNote);
        // The nudge is one-shot: it applies to the very next call only.
        truncationNote = undefined;
        const remainingUsd = this.deps.budget.availableUsd(this.deps.budget.getPoolOrThrow(args.poolId));
        const inputTokens = messagesTokenEstimate(messages);
        const derived = deriveMaxOutputTokens({
          // A generated page or a long file write easily exceeds 2048 tokens. A
          // low ceiling truncates the tool call mid-JSON; the provider reports
          // `finishReason: 'length'` and the model then retries the same call
          // forever. The budget enforcer still caps this per pool.
          configuredMaxTokens: args.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          inputTokens,
          unitPriceInUsd: target.price.in,
          unitPriceOutUsd: target.price.out,
          remainingUsd,
        });

        if (derived.exhausted) {
          this.appendEvents(
            runId,
            [
              {
                type: 'budget_killed',
                payload: {
                  reason: `input alone costs $${derived.inputCostUsd} against $${remainingUsd} remaining`,
                },
              },
            ],
            { status: 'killed_budget' },
          );
          return this.getRun(runId)!;
        }

        // Reserve before spending. A single call can exceed a small pool (a
        // long prompt alone is $0.14 at deepseek prices), and overspending here
        // makes the pool negative, which corrupts releaseRemainder for the
        // parent. Refuse instead: the run is killed with a precise reason.
        const estimatedCallCost = this.deps.budget.estimateCallCostUsd({
          inputTokens,
          maxOutputTokens: derived.maxOutputTokens,
          unitPriceInUsd: target.price.in,
          unitPriceOutUsd: target.price.out,
        });
        if (!this.deps.budget.canAfford(args.poolId, estimatedCallCost)) {
          this.appendEvents(
            runId,
            [
              {
                type: 'budget_killed',
                payload: {
                  reason:
                    `next call would cost up to $${estimatedCallCost.toFixed(6)} ` +
                    `(${inputTokens} in + ${derived.maxOutputTokens} out) but only ` +
                    `$${remainingUsd.toFixed(6)} remains in the pool`,
                },
              },
            ],
            { status: 'killed_budget' },
          );
          return this.getRun(runId)!;
        }

        const tools = this.deps.bus.listToolsForActor('lead').map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));

        this.appendEvents(runId, [
          {
            type: 'llm_requested',
            payload: {
              turn,
              tier: args.tier,
              provider: target.provider.name,
              model: target.provider.model,
              maxOutputTokens: derived.maxOutputTokens,
              inputTokens,
              remainingUsd,
            } satisfies LlmRequestedPayload,
          },
        ]);

        let response: LlmResponse;
        try {
          response = await target.provider.complete({
            tier: args.tier,
            messages,
            tools,
            maxOutputTokens: derived.maxOutputTokens,
            signal: args.signal,
          });
        } catch (err) {
          // A provider crash is NOT a run crash: the event log already holds
          // everything needed to retry from the last durable point.
          this.appendEvents(runId, [{ type: 'error', payload: { stage: 'llm', message: String((err as Error).message) } }]);
          return this.finish(runId, 'failed', { message: String((err as Error).message) });
        }

        const cost = costUsd(response.usage.tokensIn, response.usage.tokensOut, target.price.in, target.price.out);
        this.deps.ledger.record({
          runId,
          agentId: args.agentId ?? null,
          poolId: args.poolId,
          provider: response.provider,
          model: response.model,
          tier: args.tier,
          unitPriceInUsd: target.price.in,
          unitPriceOutUsd: target.price.out,
          tokensIn: response.usage.tokensIn,
          tokensOut: response.usage.tokensOut,
          isEstimated: response.usage.estimated,
          aborted: response.aborted,
          category: 'turn',
          turn,
        });
        // Last line of defence: the provider bills REAL tokens, which can
        // exceed the pre-call estimate. Charging within the pool keeps
        // availableUsd from ever going negative.
        const charge = this.deps.budget.chargeWithinPool(args.poolId, cost);
        if (charge.overageUsd > 0) {
          this.appendEvents(runId, [
            {
              type: 'budget_warning',
              payload: {
                note: 'actual call cost exceeded the remaining pool; pool clamped at zero',
                overageUsd: charge.overageUsd,
              },
            },
          ]);
        }

        const respondedPayload: LlmRespondedPayload = {
          turn,
          content: response.content,
          toolCalls: response.toolCalls,
          tokensIn: response.usage.tokensIn,
          tokensOut: response.usage.tokensOut,
          costUsd: cost,
          aborted: response.aborted,
          finishReason: response.finishReason,
          estimated: response.usage.estimated,
        };
        this.appendEvents(runId, [{ type: 'llm_responded', payload: respondedPayload }]);

        if (response.thinking) {
          this.appendEvents(runId, [{ type: 'thinking', payload: { turn, text: response.thinking } }]);
          this.deps.onChunk?.(runId, { kind: 'thinking', delta: response.thinking });
        }
        if (response.content) this.deps.onChunk?.(runId, { kind: 'text', delta: response.content });

        if (response.aborted) {
          // Partial stream: usage was already recorded with aborted:true.
          this.appendEvents(runId, [{ type: 'status_changed', payload: { note: 'stream aborted' } }]);
          return this.finish(runId, 'cancelled');
        }

        // The model hit the output ceiling. Its tool-call arguments are now
        // TRUNCATED JSON — executing them is guaranteed to fail validation, and
        // the model then retries the same oversized call until the turn limit
        // and the budget are gone (observed with a real model: 12 tool calls,
        // every pages.create rejected, run ended `failed`).
        // The honest response is to not execute anything and tell it to be
        // smaller — at most twice, so a model that cannot comply still stops.
        if (response.finishReason === 'length') {
          truncations += 1;
          this.appendEvents(runId, [
            {
              type: 'error',
              payload: {
                stage: 'llm',
                message:
                  `output truncated at maxOutputTokens=${derived.maxOutputTokens}; ` +
                  `${response.toolCalls.length} tool call(s) discarded because their arguments were incomplete`,
              },
            },
          ]);
          if (truncations <= MAX_TRUNCATION_RETRIES && turn < maxTurns) {
            truncationNote =
              'Your previous tool call was cut off: the output hit the token limit. Emit a SMALLER call ' +
              '(split the work into several calls) or a shorter answer. Do not repeat the same oversized call.';
            continue;
          }
          return this.finish(runId, 'failed', { message: 'output token ceiling exceeded repeatedly' });
        }

        if (response.toolCalls.length === 0) {
          return this.finish(runId, 'completed');
        }

        const paused = await this.executeToolCalls(runId, response.toolCalls, args);
        if (paused) return this.getRun(runId)!;
      }

      // Turn budget exhausted without a final answer.
      return this.finish(runId, 'failed', { message: `max turns (${maxTurns}) exhausted` });
    } finally {
      this.running.delete(runId);
      this.aborts.delete(runId);
    }
  }

  private finish(runId: string, status: string, error?: unknown): RunRow {
    this.appendEvents(runId, [{ type: 'run_completed', payload: { status, error } }], { status, error });
    return this.getRun(runId)!;
  }

  private async executeToolCalls(
    runId: string,
    toolCalls: Array<{ id: string; name: string; arguments: string }>,
    args: StartRunArgs,
  ): Promise<boolean> {
    const run = this.getRun(runId)!;
    for (const call of toolCalls) {
      const input = parseArgs(call.arguments);
      let idempotent = false;
      try {
        idempotent = this.deps.bus.get(call.name).idempotent;
      } catch {
        // Unknown tool: record as an error result so the model can correct.
        this.appendEvents(runId, [
          {
            type: 'tool_result',
            payload: {
              toolCallId: call.id,
              name: call.name,
              status: 'error',
              error: `Unknown tool '${call.name}'`,
            } satisfies ToolResultPayload,
          },
        ]);
        continue;
      }

      this.appendEvents(runId, [
        {
          type: 'tool_call_started',
          payload: { toolCallId: call.id, name: call.name, input, idempotent } satisfies ToolCallStartedPayload,
        },
      ]);

      const actor: AgentActor = {
        kind: 'agent',
        role: 'lead',
        agentId: run.agentId ?? 'lead',
        runId,
        toolCallId: call.id,
      };

      let payload: ToolResultPayload;
      try {
        const res = await this.deps.bus.dispatch(call.name, input, actor, {
          factoryId: run.factoryId,
          idempotencyKey: `${runId}:${call.id}`,
        });
        payload =
          res.status === 'pending_approval'
            ? { toolCallId: call.id, name: call.name, status: 'pending_approval', gateId: res.gateId }
            : { toolCallId: call.id, name: call.name, status: 'ok', result: res.result };
      } catch (err) {
        payload = {
          toolCallId: call.id,
          name: call.name,
          status: 'error',
          error: `${(err as Error).name}: ${(err as Error).message}`,
        };
      }

      this.appendEvents(runId, [{ type: 'tool_result', payload }]);

      if (payload.status === 'pending_approval') {
        // Run is now paused_gate (the bus already wrote the status transition).
        await this.runSummarizer(runId);
        return true;
      }
    }

    await this.runSummarizer(runId);
    return false;
  }

  /**
   * Compresses any completed tool batch into one line and appends it as an
   * event. Never throws: a summary is a courtesy, the event log is the truth.
   */
  private async runSummarizer(runId: string): Promise<void> {
    const summarizer = this.deps.summarizer;
    if (!summarizer) return;

    const activity: ToolActivity[] = [];
    const started = new Map<string, { name: string; input: unknown; seq: number }>();
    for (const ev of this.getEvents(runId)) {
      if (ev.type === 'tool_call_started') {
        const p = ev.payload as ToolCallStartedPayload;
        started.set(p.toolCallId, { name: p.name, input: p.input, seq: ev.seq });
      } else if (ev.type === 'tool_result') {
        const p = ev.payload as ToolResultPayload;
        const s = started.get(p.toolCallId);
        if (!s) continue;
        activity.push({
          seq: s.seq,
          name: p.name,
          status: p.status,
          input: s.input,
          result: p.result,
          error: p.error,
        });
      }
    }

    try {
      const record = await summarizer.maybeSummarize(runId, activity);
      if (record) {
        this.appendEvents(runId, [
          {
            type: 'tool_summary',
            payload: {
              summary: record.summary,
              toolNames: record.toolNames,
              batchStart: record.batchStart,
              batchEnd: record.batchEnd,
              costUsd: record.costUsd,
            },
          },
        ]);
      }
    } catch (err) {
      this.appendEvents(runId, [
        { type: 'error', payload: { stage: 'tool_summary', message: String((err as Error).message) } },
      ]);
    }
  }

  // ----------------------------------------------------------- recovery

  /**
   * Rebuilds a run's state from `run_events` only.
   *
   * The contract: a `tool_call_started` without a matching `tool_result` is
   * resolved here, deterministically:
   *   idempotent   -> re-execute the tool and append the real result
   *   non-idempotent -> append `unknown_after_crash`, never re-execute
   */
  recoverRun(runId: string): RecoveredState {
    const run = this.getRun(runId);
    if (!run) throw new NotFoundError(`Run ${runId} not found`);

    const events = this.getEvents(runId);
    const calls = new Map<string, ToolCallState>();
    let completedTurns = 0;
    let lastAssistantContent: string | null = null;

    for (const ev of events) {
      switch (ev.type) {
        case 'turn_started':
          completedTurns += 1;
          break;
        case 'llm_responded': {
          const p = ev.payload as LlmRespondedPayload;
          if (p.content) lastAssistantContent = p.content;
          break;
        }
        case 'tool_call_started': {
          const p = ev.payload as ToolCallStartedPayload;
          calls.set(p.toolCallId, {
            toolCallId: p.toolCallId,
            name: p.name,
            input: p.input,
            idempotent: p.idempotent,
            started: true,
            resolved: false,
          });
          break;
        }
        case 'tool_result': {
          const p = ev.payload as ToolResultPayload;
          const st = calls.get(p.toolCallId);
          if (st) {
            st.resolved = true;
            st.result = p;
          }
          break;
        }
        default:
          break;
      }
    }

    const dangling = [...calls.values()].filter((c) => c.started && !c.resolved);

    return {
      runId,
      status: run.status,
      turn: run.turn,
      events,
      dangling,
      completedTurns,
      lastAssistantContent,
    };
  }

  /**
   * Reconciles dangling tool calls. Split out from `recoverRun` so recovery can
   * stay a pure read and reconciliation is an explicit, auditable write.
   */
  async reconcileDanglingTools(runId: string): Promise<ToolResultPayload[]> {
    const state = this.recoverRun(runId);
    const run = this.getRun(runId)!;
    const produced: ToolResultPayload[] = [];

    for (const call of state.dangling) {
      if (call.idempotent) {
        const actor: AgentActor = {
          kind: 'agent',
          role: 'lead',
          agentId: run.agentId ?? 'lead',
          runId,
          toolCallId: call.toolCallId,
        };
        let payload: ToolResultPayload;
        try {
          const res = await this.deps.bus.dispatch(call.name, call.input, actor, {
            factoryId: run.factoryId,
            idempotencyKey: `${runId}:${call.toolCallId}`,
          });
          payload =
            res.status === 'pending_approval'
              ? { toolCallId: call.toolCallId, name: call.name, status: 'pending_approval', gateId: res.gateId }
              : { toolCallId: call.toolCallId, name: call.name, status: 'ok', result: res.result };
        } catch (err) {
          payload = {
            toolCallId: call.toolCallId,
            name: call.name,
            status: 'error',
            error: `${(err as Error).name}: ${(err as Error).message}`,
          };
        }
        this.appendEvents(runId, [
          { type: 'tool_call_replayed', payload: { toolCallId: call.toolCallId, name: call.name } },
          { type: 'tool_result', payload },
        ]);
        produced.push(payload);
      } else {
        const payload: ToolResultPayload = {
          toolCallId: call.toolCallId,
          name: call.name,
          status: 'unknown_after_crash',
          result: {
            note:
              'The process died after this non-idempotent tool started. It was NOT re-run. ' +
              'Its effect may or may not have happened; inspect the target before deciding.',
          },
        };
        this.appendEvents(runId, [{ type: 'tool_result', payload }]);
        produced.push(payload);
      }
    }
    return produced;
  }

  // -------------------------------------------------------------- gates

  getGate(gateId: string): StoredGate | null {
    return this.gates.get(gateId);
  }

  listPendingGates(): StoredGate[] {
    return this.gates.listPending();
  }

  /**
   * Human approves a gate. The stored validated input is executed EXACTLY as
   * saved; nothing is re-parsed, re-validated or amended.
   */
  async approveGate(gateId: string): Promise<{ gate: StoredGate; result: unknown }> {
    const gate = this.requirePendingGate(gateId);
    const human: Actor = { kind: 'human' };
    const cmd = this.deps.bus.get(gate.commandName);

    // Execute from the stored JSON: this is the "exact" in ApprovalGate.
    const input = JSON.parse(gate.validatedInputJson);
    const result = await cmd.execute(input, human);

    this.gates.resolve(gateId, 'approved', human);
    if (gate.runId) {
      this.appendEvents(gate.runId, [
        {
          type: 'gate_resolved',
          payload: { gateId, decision: 'approved', commandName: gate.commandName, result },
          actor: human,
        },
      ]);
    }
    return { gate, result };
  }

  /**
   * Resumes a run that was paused on an approved gate.
   *
   * Separate from `approveGate` on purpose: approval is a durable decision that
   * must be recorded even if resuming is not possible yet (no provider in this
   * process, a run already finished, shutdown in progress). The caller decides,
   * and reports honestly when it cannot resume.
   *
   * `resumePrompts.forRun` lets the app layer supply the system prompt it
   * composed at start time; core has no harness knowledge to rebuild it.
   */
  async resumeIfPaused(runId: string, resumePrompts?: RunPromptProvider): Promise<RunRow | null> {
    const run = this.getRun(runId);
    if (!run) return null;
    if (run.status !== 'paused_gate' && run.status !== 'paused_human') return run;

    const stillPending = this.db
      .prepare(`SELECT 1 AS ok FROM approval_gates WHERE run_id = ? AND status = 'pending' LIMIT 1`)
      .get(runId) as { ok: number } | undefined;
    if (stillPending) return run; // another gate is still waiting on a human

    const prompt =
      resumePrompts?.forRun(run) ?? this.deps.renderSystemPrompt?.({ ...run, systemPrompt: '' } as never) ?? '';

    return this.resumeRun(runId, { systemPrompt: prompt });
  }

  async rejectGate(gateId: string, reason?: string): Promise<StoredGate> {
    const gate = this.requirePendingGate(gateId);
    const human: Actor = { kind: 'human' };
    this.gates.resolve(gateId, 'rejected', human, reason);
    if (gate.runId) {
      this.appendEvents(gate.runId, [
        {
          type: 'gate_resolved',
          payload: { gateId, decision: 'rejected', commandName: gate.commandName, reason },
          actor: human,
        },
      ]);
    }
    return { ...gate, status: 'rejected' };
  }

  private requirePendingGate(gateId: string): StoredGate {
    const gate = this.gates.get(gateId);
    if (!gate) throw new NotFoundError(`Gate ${gateId} not found`);
    if (gate.status !== 'pending') throw new ConflictError(`Gate ${gateId} is already ${gate.status}`);
    return gate;
  }

  // ----------------------------------------------------------- messages

  /**
   * Rebuilds the conversation from the event log. This is what makes a resume
   * after a crash indistinguishable from an uninterrupted run.
   */
  private buildMessages(
    systemPrompt: string,
    runId: string,
    goal: string,
    state: RecoveredState,
    wrapUpInstruction?: string,
    truncationNote?: string,
  ): LlmMessage[] {
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: goal },
    ];

    for (const ev of state.events) {
      if (ev.type === 'llm_responded') {
        const p = ev.payload as LlmRespondedPayload;
        if (p.toolCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: p.content || undefined,
            toolCalls: p.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
          });
        } else if (p.content) {
          messages.push({ role: 'assistant', content: p.content });
        }
      } else if (ev.type === 'tool_result') {
        const p = ev.payload as ToolResultPayload;
        messages.push({
          role: 'tool',
          toolCallId: p.toolCallId,
          name: p.name,
          content: JSON.stringify({
            status: p.status,
            ...(p.result !== undefined ? { result: p.result } : {}),
            ...(p.error ? { error: p.error } : {}),
            ...(p.gateId ? { gateId: p.gateId, note: 'Awaiting human approval.' } : {}),
          }),
        });
      }
    }

    if (wrapUpInstruction) {
      messages.push({ role: 'system', content: wrapUpInstruction });
    }
    if (truncationNote) {
      messages.push({ role: 'system', content: truncationNote });
    }
    return messages;
  }

  /** Runs known to be non-terminal (used at boot for crash-recovery reporting). */
  listResumable(): RunRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE status IN ('running','paused_gate','paused_human','pending') ORDER BY created_at`)
      .all() as RawRun[];
    return rows.map(mapRun);
  }
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return { __unparsed: raw };
  }
}

interface RawRun {
  id: string;
  factory_id: string;
  agent_id: string | null;
  goal: string;
  status: string;
  tier: string;
  pool_id: string | null;
  turn: number;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
}

function mapRun(r: RawRun): RunRow {
  return {
    id: r.id,
    factoryId: r.factory_id,
    agentId: r.agent_id,
    goal: r.goal,
    status: r.status,
    tier: r.tier as Tier,
    poolId: r.pool_id,
    turn: r.turn,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    endedAt: r.ended_at,
  };
}

interface RawEvent {
  id: number;
  run_id: string;
  seq: number;
  type: string;
  payload_json: string;
  actor_json: string;
  created_at: number;
}

function mapEvent(r: RawEvent): RunEvent {
  return {
    id: r.id,
    runId: r.run_id,
    seq: r.seq,
    type: r.type as RunEventType,
    payload: JSON.parse(r.payload_json),
    actor: JSON.parse(r.actor_json),
    createdAt: r.created_at,
  };
}

export { roundMoney };






