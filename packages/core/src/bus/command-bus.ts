import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { immediate } from '../db/client.js';
import { ForbiddenError, UnknownCommandError, ValidationError } from '../errors.js';
import {
  type Actor,
  type AnyCommandDefinition,
  type CommandBusLike,
  type PendingApproval,
  type ResolvedActorKind,
  type ToolDescriptor,
  actorKindOf,
  describeActor,
} from '../types.js';

export interface GateStore {
  createGate(args: {
    runId: string | null;
    factoryId: string;
    commandName: string;
    validatedInputJson: string;
    requestedByJson: string;
    idempotencyKey: string;
    toolCallId: string | null;
  }): string;
  /** Returns the stored gate, or null if one already existed for the key. */
  findByKey(factoryId: string, idempotencyKey: string): StoredGate | null;
}

export interface StoredGate {
  id: string;
  runId: string | null;
  factoryId: string;
  commandName: string;
  validatedInputJson: string;
  requestedByJson: string;
  idempotencyKey: string;
  toolCallId: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
}

/** Minimal run-control surface the bus needs; implemented by DurableRunner. */
export interface RunPauser {
  pauseForGate(runId: string, gateId: string): void;
}

export interface DispatchOptions {
  /**
   * Stable per-call key. Two dispatches with the same key must not produce two
   * gates. The runner derives it from runId + toolCallId.
   */
  idempotencyKey?: string;
  /** Factory scope for the gate row and idempotency bookkeeping. */
  factoryId?: string;
}

export type DispatchResult<T = unknown> =
  | { status: 'ok'; result: T }
  | PendingApproval;

/**
 * The single mutation entry point.
 *
 * Two rules are load-bearing and enforced here rather than documented:
 * 1. `actor` is a parameter, never part of `input`.
 * 2. `requiresGate` commands called by a non-human never execute; they persist
 *    a gate holding the POST-Zod input and return `pending_approval`.
 */
export class CommandBus implements CommandBusLike {
  readonly commands = new Map<string, AnyCommandDefinition>();
  private gateStore: GateStore | null = null;
  private runPauser: RunPauser | null = null;
  private onChange: (() => void) | null = null;

  constructor(private readonly db?: Db) {}

  register(cmd: AnyCommandDefinition): void {
    if (this.commands.has(cmd.name)) {
      throw new Error(`Duplicate command registration: ${cmd.name}`);
    }
    this.commands.set(cmd.name, cmd);
    this.onChange?.();
  }

  registerAll(cmds: readonly AnyCommandDefinition[]): void {
    for (const c of cmds) this.register(c);
  }

  setGateStore(store: GateStore): void {
    this.gateStore = store;
  }

  setRunPauser(pauser: RunPauser): void {
    this.runPauser = pauser;
  }

  /** Notified whenever the command registry changes (UI tool lists refresh). */
  subscribe(fn: () => void): void {
    this.onChange = fn;
  }

  get(name: string): AnyCommandDefinition {
    const cmd = this.commands.get(name);
    if (!cmd) throw new UnknownCommandError(name);
    return cmd;
  }

  /** Capability check. Throws ForbiddenError when the actor kind is not allowed. */
  assertAllowed(cmd: AnyCommandDefinition, actor: Actor): void {
    const kind = actorKindOf(actor);
    if (!cmd.allowedActors.includes(kind)) {
      throw new ForbiddenError(
        `Actor '${describeActor(actor)}' (${kind}) may not call '${cmd.name}'; allowed: ${cmd.allowedActors.join(', ')}`,
      );
    }
  }

  /**
   * Validates input with the command's Zod schema. The actor is intentionally
   * absent from the parsed output.
   */
  validate(cmd: AnyCommandDefinition, rawInput: unknown): { ok: true; data: unknown } | { ok: false; error: ValidationError } {
    const parsed = cmd.inputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        error: new ValidationError(`Invalid input for '${cmd.name}'`, parsed.error.issues),
      };
    }
    return { ok: true, data: parsed.data };
  }

  /**
   * Dispatch a command. Capability is checked BEFORE validation so a
   * forbidden actor learns nothing about the schema.
   */
  async dispatch(name: string, rawInput: unknown, actor: Actor, opts: DispatchOptions = {}): Promise<DispatchResult> {
    const cmd = this.get(name);
    this.assertAllowed(cmd, actor);

    const validated = this.validate(cmd, rawInput);
    if (!validated.ok) throw validated.error;

    if (cmd.requiresGate && actor.kind !== 'human') {
      return this.persistGate(cmd, validated.data, actor, opts);
    }

    const result = await cmd.execute(validated.data, actor);
    return { status: 'ok', result };
  }

  private persistGate(
    cmd: AnyCommandDefinition,
    validatedInput: unknown,
    actor: Actor,
    opts: DispatchOptions,
  ): PendingApproval {
    if (!this.gateStore) {
      throw new Error(
        `Command '${cmd.name}' requires a gate but no GateStore is configured on the CommandBus`,
      );
    }
    const factoryId = opts.factoryId ?? 'default';
    const idempotencyKey =
      opts.idempotencyKey ?? `${cmd.name}:${actor.kind === 'agent' ? actor.toolCallId : randomUUID()}`;

    const existing = this.gateStore.findByKey(factoryId, idempotencyKey);
    if (existing) {
      // Same logical call, replayed (e.g. after a crash). Return the same gate
      // instead of opening a second one.
      return { status: 'pending_approval', gateId: existing.id };
    }

    const runId = actor.kind === 'agent' ? actor.runId : null;
    const toolCallId = actor.kind === 'agent' ? actor.toolCallId : null;

    const gateId = this.gateStore.createGate({
      runId,
      factoryId,
      commandName: cmd.name,
      validatedInputJson: JSON.stringify(validatedInput),
      requestedByJson: JSON.stringify(actor),
      idempotencyKey,
      toolCallId,
    });

    if (runId) this.runPauser?.pauseForGate(runId, gateId);

    return { status: 'pending_approval', gateId };
  }

  /**
   * Tools an actor may see. This is the ONLY source for LLM tool lists:
   * anything absent here is unreachable by the model, not merely discouraged.
   */
  listToolsForActor(role: ResolvedActorKind): ToolDescriptor[] {
    const out: ToolDescriptor[] = [];
    for (const cmd of this.commands.values()) {
      if (!cmd.allowedActors.includes(role)) continue;
      out.push({
        name: cmd.name,
        description: cmd.description,
        inputSchema: z.toJSONSchema(cmd.inputSchema, { io: 'input', target: 'draft-7' }) as Record<
          string,
          unknown
        >,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  listCommandMeta(): Array<{
    name: string;
    description: string;
    allowedActors: string[];
    idempotent: boolean;
    requiresGate: boolean;
  }> {
    return [...this.commands.values()]
      .map((c) => ({
        name: c.name,
        description: c.description,
        allowedActors: [...c.allowedActors],
        idempotent: c.idempotent,
        requiresGate: c.requiresGate === true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

/**
 * SQLite-backed gate store. Kept here (not in the runner) so the bus can be
 * used without a runner in tests.
 */
export class SqliteGateStore implements GateStore {
  constructor(private readonly db: Db) {}

  createGate(args: {
    runId: string | null;
    factoryId: string;
    commandName: string;
    validatedInputJson: string;
    requestedByJson: string;
    idempotencyKey: string;
    toolCallId: string | null;
  }): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO approval_gates
           (id, run_id, factory_id, command_name, validated_input_json, requested_by_json,
            idempotency_key, tool_call_id, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,'pending',?)`,
      )
      .run(
        id,
        args.runId,
        args.factoryId,
        args.commandName,
        args.validatedInputJson,
        args.requestedByJson,
        args.idempotencyKey,
        args.toolCallId,
        Date.now(),
      );
    return id;
  }

  findByKey(factoryId: string, idempotencyKey: string): StoredGate | null {
    const row = this.db
      .prepare(`SELECT * FROM approval_gates WHERE factory_id = ? AND idempotency_key = ?`)
      .get(factoryId, idempotencyKey) as RawGate | undefined;
    return row ? mapGate(row) : null;
  }

  get(id: string): StoredGate | null {
    const row = this.db.prepare(`SELECT * FROM approval_gates WHERE id = ?`).get(id) as RawGate | undefined;
    return row ? mapGate(row) : null;
  }

  listPending(): StoredGate[] {
    const rows = this.db
      .prepare(`SELECT * FROM approval_gates WHERE status = 'pending' ORDER BY created_at ASC`)
      .all() as RawGate[];
    return rows.map(mapGate);
  }

  resolve(id: string, status: 'approved' | 'rejected' | 'expired', resolvedBy: Actor, reason?: string): void {
    immediate(this.db, () => {
      const gate = this.get(id);
      if (!gate) throw new UnknownCommandError(`Gate ${id}`);
      if (gate.status !== 'pending') {
        throw new ForbiddenError(`Gate ${id} already resolved as '${gate.status}'`);
      }
      this.db
        .prepare(
          `UPDATE approval_gates SET status = ?, resolved_at = ?, resolved_by_json = ?, reason = ? WHERE id = ?`,
        )
        .run(status, Date.now(), JSON.stringify(resolvedBy), reason ?? null, id);
    });
  }
}

interface RawGate {
  id: string;
  run_id: string | null;
  factory_id: string;
  command_name: string;
  validated_input_json: string;
  requested_by_json: string;
  idempotency_key: string;
  tool_call_id: string | null;
  status: string;
  created_at: number;
  resolved_at: number | null;
  resolved_by_json: string | null;
  reason: string | null;
}

function mapGate(r: RawGate): StoredGate {
  return {
    id: r.id,
    runId: r.run_id,
    factoryId: r.factory_id,
    commandName: r.command_name,
    validatedInputJson: r.validated_input_json,
    requestedByJson: r.requested_by_json,
    idempotencyKey: r.idempotency_key,
    toolCallId: r.tool_call_id,
    status: r.status as StoredGate['status'],
  };
}
