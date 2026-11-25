/**
 * Core domain types for the Sovereign Meta Software Factory.
 *
 * The single most important invariant in this file: `Actor` is NEVER parsed
 * from a request payload. HTTP injects `{ kind: 'human' }` after authenticating;
 * the DurableRunner injects `{ kind: 'agent', ... }` in-process. See
 * `bus/command-bus.ts` and `server/app.ts`.
 */
import type { z } from 'zod';

export type ActorKind = 'human' | 'lead' | 'specialist' | 'trigger';

export interface HumanActor {
  kind: 'human';
}

export interface AgentActor {
  kind: 'agent';
  role: Exclude<ActorKind, 'human' | 'trigger'>;
  agentId: string;
  runId: string;
  toolCallId: string;
}

export interface TriggerActor {
  kind: 'trigger';
  triggerId: string;
  jobId: string;
}

export type Actor = HumanActor | AgentActor | TriggerActor;

/** The capability namespace an actor resolves to (an agent resolves to its role). */
export type ResolvedActorKind = Exclude<ActorKind, 'agent'>;

export function actorKindOf(actor: Actor): ResolvedActorKind {
  return actor.kind === 'agent' ? actor.role : actor.kind;
}

export function describeActor(actor: Actor): string {
  switch (actor.kind) {
    case 'human':
      return 'human';
    case 'trigger':
      return `trigger:${actor.triggerId}`;
    case 'agent':
      return `${actor.role}:${actor.agentId}`;
  }
}

/** Model tiers. S+ is the strongest; D is the cheapest (used for classification/summaries). */
export const TIERS = ['S+', 'S', 'A', 'B', 'C', 'D'] as const;
export type Tier = (typeof TIERS)[number];

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

/** Result when a gate intercepts a mutating command. */
export interface PendingApproval {
  status: 'pending_approval';
  gateId: string;
}

export interface RunStatus {
  status:
    | 'pending'
    | 'running'
    | 'paused_gate'
    | 'paused_human'
    | 'completed'
    | 'failed'
    | 'killed_budget'
    | 'cancelled';
}

/** Terminal statuses after which a run will not resume on its own. */
export const TERMINAL_RUN_STATUSES = [
  'completed',
  'failed',
  'killed_budget',
  'cancelled',
] as const;

export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export function isTerminalStatus(s: string): s is TerminalRunStatus {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(s);
}

/** Everything a harness needs to render its slice of the system prompt. */
export interface PromptSectionContext {
  actor: Actor;
  /** Tools visible to the current actor, already filtered for capabilities. */
  toolNames: string[];
  factoryName: string;
}

export type JsonSchema = Record<string, unknown>;

/**
 * A single capability exposed through the CommandBus.
 *
 * `execute` receives *validated* input (post-Zod) and the actor resolved by
 * the caller. It must not read identity from `input`.
 */
export interface CommandDefinition<I extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  inputSchema: I;
  allowedActors: readonly ActorKind[];
  idempotent: boolean;
  requiresGate?: boolean;
  /**
   * When true the command may be re-executed by crash recovery. Defaults to
   * `idempotent`. Some commands are idempotent in the "safe to retry" sense but
   * decorate their result; keep the explicit flag available.
   */
  reexecutableOnCrash?: boolean;
  execute(input: z.output<I>, actor: Actor): Promise<unknown> | unknown;
}

export type AnyCommandDefinition = CommandDefinition<z.ZodType>;

/** A harness module bundles commands + prompt contribution. */
export interface HarnessModule {
  id: string;
  name: string;
  commands: readonly AnyCommandDefinition[];
  renderPromptSection(ctx: PromptSectionContext): string;
  onRegister?(bus: CommandBusLike): void | Promise<void>;
}

/** Minimal surface a harness needs from the bus during registration. */
export interface CommandBusLike {
  register(cmd: AnyCommandDefinition): void;
  readonly commands: ReadonlyMap<string, AnyCommandDefinition>;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}
