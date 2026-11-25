import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  BudgetEnforcer,
  BudgetError,
  DurableRunner,
  FactoryError,
  NotFoundError,
  WRAP_UP_BUDGET_RATIO,
  WRAP_UP_TIME_RATIO,
  type CommandBus,
  type CommandDefinition,
  type Db,
  type FakeLLMProvider,
  type HarnessModule,
  type LlmProvider,
  type RunRow,
  type Tier,
  type TokenLedger,
} from '@mf/core';

export interface SubagentRecord {
  id: string;
  parentRunId: string;
  goal: string;
  tier: Tier;
  status: 'running' | 'completed' | 'failed' | 'killed_budget' | 'cancelled' | 'stopped';
  poolId: string;
  maxCostUsd: number;
  maxDurationMs: number;
  startedAt: number;
  endedAt: number | null;
  /** Last assistant message, for subagent.read. */
  output: string | null;
  /** Why the run ended, when it was not a natural completion. */
  endReason: string | null;
}

/** In-memory + DB bookkeeping of subagent runs. */
export class SubagentRegistry {
  constructor(
    private readonly db: Db,
    private readonly budget: BudgetEnforcer,
  ) {}

  list(parentRunId?: string): SubagentRecord[] {
    const rows = parentRunId
      ? (this.db
          .prepare(`SELECT * FROM subagents WHERE parent_run_id = ? ORDER BY started_at DESC`)
          .all(parentRunId) as RawSub[])
      : (this.db.prepare(`SELECT * FROM subagents ORDER BY started_at DESC`).all() as RawSub[]);
    return rows.map(mapSub);
  }

  get(id: string): SubagentRecord | null {
    const row = this.db.prepare(`SELECT * FROM subagents WHERE id = ?`).get(id) as RawSub | undefined;
    return row ? mapSub(row) : null;
  }

  create(args: {
    parentRunId: string;
    goal: string;
    tier: Tier;
    poolId: string;
    maxCostUsd: number;
    maxDurationMs: number;
  }): SubagentRecord {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO subagents
           (id, parent_run_id, goal, tier, status, pool_id, max_cost_usd, max_duration_ms, started_at, ended_at, output, end_reason)
         VALUES (?,?,?,?,'running',?,?,?,?,NULL,NULL,NULL)`,
      )
      .run(id, args.parentRunId, args.goal, args.tier, args.poolId, args.maxCostUsd, args.maxDurationMs, Date.now());
    return this.get(id)!;
  }

  finish(id: string, status: SubagentRecord['status'], output: string | null, reason: string | null): void {
    this.db
      .prepare(`UPDATE subagents SET status = ?, ended_at = ?, output = ?, end_reason = ? WHERE id = ?`)
      .run(status, Date.now(), output, reason, id);
  }

  active(): SubagentRecord[] {
    return this.list().filter((s) => s.status === 'running');
  }
}

export function ensureSubagentsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subagents (
      id              TEXT PRIMARY KEY,
      parent_run_id   TEXT NOT NULL,
      goal            TEXT NOT NULL,
      tier            TEXT NOT NULL,
      status          TEXT NOT NULL,
      pool_id         TEXT NOT NULL,
      max_cost_usd    REAL NOT NULL,
      max_duration_ms INTEGER NOT NULL,
      started_at      INTEGER NOT NULL,
      ended_at        INTEGER,
      output          TEXT,
      end_reason      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_subagents_parent ON subagents(parent_run_id, started_at DESC);
  `);
}

export interface SubagentsHarnessOptions {
  db: Db;
  /** The factory pool that subagents carve out of. */
  parentPoolId: string;
  /** Resolves the provider+price for a tier; keeps tier honesty. */
  providerFor: (tier: Tier) => { provider: LlmProvider; price: { in: number; out: number } };
  budget: BudgetEnforcer;
  ledger: TokenLedger;
  bus: CommandBus;
  /** Ceiling regardless of what the model asks for. */
  maxCostUsdCap?: number;
  maxDurationMsCap?: number;
  /** Poll interval for enforcer checks while a subagent works. */
  tickMs?: number;
}

const SPAWN_INPUT = z.object({
  goal: z.string().min(1).max(8000),
  tier: z.enum(['S+', 'S', 'A', 'B', 'C', 'D']).default('B'),
  maxCostUsd: z.number().positive().max(100).default(0.25),
  maxDurationMs: z.number().int().min(1000).max(3_600_000).default(120_000),
  /** Tools the subagent may use. Empty means "its own tier's defaults". */
  tools: z.array(z.string()).default([]),
});

const ReadInput = z.object({ subagentId: z.string().min(1) });
const StopInput = z.object({ subagentId: z.string().min(1), reason: z.string().max(500).default('stopped by caller') });
const ListInput = z.object({ parentRunId: z.string().optional() });

export interface SubagentsHarness extends HarnessModule {
  registry: SubagentRegistry;
  /** Test/diagnostic hook: read a finished subagent's full event log. */
  runnerFor(subagentId: string): DurableRunner | null;
}

/**
 * Disposable subagents with transactional budget carve-out.
 *
 * The money contract, which is the whole point of this harness:
 *  1. `carveOut(parent, amount)` runs in a SQLite IMMEDIATE transaction, so two
 *     concurrent subagents cannot both observe enough headroom.
 *  2. The subagent spends only from its own pool.
 *  3. Whatever it did not spend is returned with `releaseRemainder`.
 * A subagent that crashes therefore cannot strand or overdraw budget.
 */
export function createSubagentsHarness(opts: SubagentsHarnessOptions): SubagentsHarness {
  ensureSubagentsTable(opts.db);
  const registry = new SubagentRegistry(opts.db, opts.budget);
  const runners = new Map<string, DurableRunner>();
  const active = new Map<string, AbortController>();
  const maxCostCap = opts.maxCostUsdCap ?? 5;
  const maxDurCap = opts.maxDurationMsCap ?? 600_000;

  const spawn: CommandDefinition<typeof SPAWN_INPUT> = {
    name: 'subagent.run',
    description:
      'Start a disposable subagent with its own budget carved from the factory pool. Returns when it finishes.',
    inputSchema: SPAWN_INPUT,
    allowedActors: ['human', 'lead'],
    // Spawning spends money and does work: never blindly replayed after a crash.
    idempotent: false,
    async execute(input, actor) {
      if (actor.kind !== 'agent') {
        throw new FactoryError('subagent.run must be called by an agent (it needs a parent run)', 'BAD_ACTOR', 400);
      }
      const parentRunId = actor.runId;
      const amount = Math.min(input.maxCostUsd, maxCostCap);
      const duration = Math.min(input.maxDurationMs, maxDurCap);

      // Atomic: throws INSUFFICIENT_POOL rather than overdrafting the parent.
      const childPoolId = opts.budget.carveOut(opts.parentPoolId, amount, {
        ownerKind: 'subagent',
        ownerId: `${parentRunId}:${randomUUID()}`,
      });

      const record = registry.create({
        parentRunId,
        goal: input.goal,
        tier: input.tier,
        poolId: childPoolId,
        maxCostUsd: amount,
        maxDurationMs: duration,
      });

      const { provider, price } = opts.providerFor(input.tier);
      const runner = new DurableRunner({
        db: opts.db,
        bus: opts.bus,
        ledger: opts.ledger,
        budget: opts.budget,
        provider,
        price,
      });
      runners.set(record.id, runner);

      const ctrl = new AbortController();
      active.set(record.id, ctrl);

      // The enforcer runs on a timer so a subagent that burns money or time
      // without ever calling the model still gets stopped.
      // Held in an object: TypeScript narrows a let assigned only inside a
      // callback to its initial value, which made the later read unreachable.
      const state = { killed: null as string | null };
      const watcher = setInterval(() => {
        const verdict = opts.budget.evaluate({
          poolId: childPoolId,
          startedAtMs: record.startedAt,
          maxDurationMs: duration,
        });
        if (verdict.action === 'kill') {
          state.killed = verdict.reason ?? 'killed';
          ctrl.abort();
        }
      }, opts.tickMs ?? 250);

      let status: SubagentRecord['status'] = 'completed';
      let output: string | null = null;
      let reason: string | null = null;

      try {
        const run = await runner.startRun({
          factoryId: 'subagent',
          goal: input.goal,
          tier: input.tier,
          poolId: childPoolId,
          systemPrompt: [
            `You are a disposable subagent. Goal: ${input.goal}`,
            'You have a hard budget and time limit. Finish with a short, concrete answer.',
            input.tools.length ? `You may use only: ${input.tools.join(', ')}.` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          maxTurns: 8,
          signal: ctrl.signal,
        });

        output = lastAssistant(runner, run.id);
        if (state.killed) {
          status = state.killed.startsWith('budget') ? 'killed_budget' : 'cancelled';
          reason = state.killed;
        } else if (run.status === 'completed') {
          status = 'completed';
        } else if (run.status === 'killed_budget') {
          status = 'killed_budget';
          reason = 'budget exhausted';
        } else if (run.status === 'cancelled') {
          status = 'cancelled';
          reason = 'aborted';
        } else {
          status = 'failed';
          reason = `run ended as ${run.status}`;
        }
      } catch (err) {
        status = err instanceof BudgetError ? 'killed_budget' : 'failed';
        reason = (err as Error).message;
      } finally {
        clearInterval(watcher);
        active.delete(record.id);
      }

      // Always return what was not spent, even on failure.
      const released = opts.budget.releaseRemainder(childPoolId);
      registry.finish(record.id, status, output, reason);

      return {
        subagentId: record.id,
        status,
        output,
        reason,
        spentUsd: (opts.ledger.summary({ runId: record.id }).totalCostUsd as number) || undefined,
        releasedUsd: released.releasedUsd,
        poolId: childPoolId,
      };
    },
  };

  const read: CommandDefinition<typeof ReadInput> = {
    name: 'subagent.read',
    description: 'Read a subagent record: status, output and what it spent.',
    inputSchema: ReadInput,
    allowedActors: ['human', 'lead'],
    idempotent: true,
    execute(input) {
      const rec = registry.get(input.subagentId);
      if (!rec) throw new NotFoundError(`Subagent ${input.subagentId} not found`);
      return {
        subagent: rec,
        spentUsd: opts.budget.spentForPool(rec.poolId),
        availableUsd: opts.budget.availableUsd(opts.budget.getPoolOrThrow(rec.poolId)),
      };
    },
  };

  const stop: CommandDefinition<typeof StopInput> = {
    name: 'subagent.stop',
    description: 'Stop a running subagent, returning its unspent budget to the factory.',
    inputSchema: StopInput,
    allowedActors: ['human', 'lead'],
    idempotent: true,
    execute(input) {
      const rec = registry.get(input.subagentId);
      if (!rec) throw new NotFoundError(`Subagent ${input.subagentId} not found`);
      const ctrl = active.get(input.subagentId);
      if (ctrl) {
        ctrl.abort();
        return { subagentId: rec.id, stopping: true };
      }
      // Already finished: report honestly rather than pretending we stopped it.
      return { subagentId: rec.id, stopping: false, status: rec.status };
    },
  };

  const list: CommandDefinition<typeof ListInput> = {
    name: 'subagent.list',
    description: 'List subagents, optionally only those of one parent run.',
    inputSchema: ListInput,
    allowedActors: ['human', 'lead'],
    idempotent: true,
    execute(input) {
      return { subagents: registry.list(input.parentRunId) };
    },
  };

  return {
    id: 'subagents',
    name: 'Subagents',
    registry,
    runnerFor: (id) => runners.get(id) ?? null,
    commands: [spawn, read, stop, list],
    renderPromptSection(ctx) {
      if (!ctx.toolNames.includes('subagent.run')) return '';
      return [
        '## Subagents',
        'You may delegate a self-contained task to a subagent with subagent.run.',
        `Its budget is carved from the factory pool and capped at $${maxCostCap}.`,
        'It is stopped at 80% of its budget/time (wrap-up warning) and at 100% (hard kill).',
        'Prefer delegating narrow, verifiable work. Do not delegate the decision itself.',
      ].join('\n');
    },
  };
}

function lastAssistant(runner: DurableRunner, runId: string): string | null {
  const events = runner.getEvents(runId);
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === 'llm_responded') {
      const p = ev.payload as { content?: string };
      if (p.content) return p.content;
    }
  }
  return null;
}

interface RawSub {
  id: string;
  parent_run_id: string;
  goal: string;
  tier: string;
  status: string;
  pool_id: string;
  max_cost_usd: number;
  max_duration_ms: number;
  started_at: number;
  ended_at: number | null;
  output: string | null;
  end_reason: string | null;
}

function mapSub(r: RawSub): SubagentRecord {
  return {
    id: r.id,
    parentRunId: r.parent_run_id,
    goal: r.goal,
    tier: r.tier as Tier,
    status: r.status as SubagentRecord['status'],
    poolId: r.pool_id,
    maxCostUsd: r.max_cost_usd,
    maxDurationMs: r.max_duration_ms,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    output: r.output,
    endReason: r.end_reason,
  };
}

export { WRAP_UP_BUDGET_RATIO, WRAP_UP_TIME_RATIO };
export type { FakeLLMProvider, RunRow };

