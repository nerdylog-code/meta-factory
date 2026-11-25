import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  FactoryError,
  NotFoundError,
  type CommandDefinition,
  type Db,
  type HarnessModule,
  type LlmProvider,
  type Tier,
  type TokenLedger,
} from '@mf/core';

/**
 * Proactive pipeline, strictly code-first:
 *
 *   Trigger (cron | webhook | file_watcher | log_event)
 *     -> Deterministic Job (TypeScript). Runs always, cheap, no model.
 *     -> IF the job reports no delta: STOP. Cost $0. Log the discard.
 *     -> Classifier (cheap tier, typed Zod output) decides wake or discard.
 *     -> Only on "wake" does an agent run start (the expensive part).
 *
 * The economic rule that makes this worth building: noise must cost nothing.
 * A job that finds nothing never calls a model, and every discard is recorded
 * so a human can audit what the filter threw away.
 */

// ---------------------------------------------------------------- job contract

export const JobDeltaSchema = z.object({
  /** Whether anything actionable changed. `false` short-circuits everything. */
  changed: z.boolean(),
  /** Human/model-readable description of what changed. */
  summary: z.string().max(4000).default(''),
  /** Optional structured payload handed to the classifier and the agent. */
  payload: z.unknown().optional(),
});
export type JobDelta = z.infer<typeof JobDeltaSchema>;

export interface JobContext {
  factoryId: string;
  triggerId: string | null;
  jobId: string;
  /** Trigger-specific input (webhook body, file path, log line...). */
  event: unknown;
  /** Persisted scratch state across runs (e.g. last-seen file mtime). */
  state: StateStore;
  now: number;
}

/**
 * A deterministic job. MUST be pure with respect to money: it may read/write
 * local state, but it must not call an LLM. That is what makes "no delta => $0"
 * a structural guarantee rather than a hope.
 */
export interface ProactiveJob {
  id: string;
  name: string;
  /** Relative path shown in the UI. */
  modulePath: string;
  run(ctx: JobContext): Promise<JobDelta>;
}

// ------------------------------------------------------------- state storage

export class StateStore {
  constructor(
    private readonly db: Db,
    private readonly scope: string,
  ) {}

  get<T>(key: string): T | null {
    const row = this.db
      .prepare(`SELECT value_json FROM proactive_state WHERE scope = ? AND key = ?`)
      .get(this.scope, key) as { value_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return null;
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO proactive_state (scope, key, value_json, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(scope, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(this.scope, key, JSON.stringify(value ?? null), Date.now());
  }
}

export function ensureProactiveTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proactive_state (
      scope      TEXT NOT NULL,
      key        TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, key)
    );
  `);
}

// --------------------------------------------------------------- classifier

export const ClassifierDecisionSchema = z.object({
  decision: z.enum(['wake', 'discard']),
  reason: z.string().max(500).default(''),
});
export type ClassifierDecision = z.infer<typeof ClassifierDecisionSchema>;

export const DEFAULT_CLASSIFIER_PROMPT = `You decide whether a factory agent should be woken up.
You are given a delta detected by a deterministic script.
Wake the agent ONLY when the delta needs a decision or an action now.
Discard routine, noise, or already-handled changes.
Answer with JSON: {"decision":"wake"|"discard","reason":"<short>"}`;

export interface ClassifierOptions {
  provider: LlmProvider;
  ledger: TokenLedger;
  tier?: Tier;
  price: { in: number; out: number };
  prompt?: string;
  maxOutputTokens?: number;
}

export interface ClassifierOutcome {
  decision: 'wake' | 'discard' | 'error';
  reason: string;
  costUsd: number;
  model: string;
  raw: string;
}

export class Classifier {
  constructor(
    private readonly db: Db,
    private readonly opts: ClassifierOptions,
  ) {}

  /** Cheap-tier decision with a Zod-validated output. Never throws. */
  async classify(args: { factoryId: string; jobId: string; triggerId: string | null; delta: JobDelta }): Promise<ClassifierOutcome> {
    const tier = this.opts.tier ?? 'D';
    let outcome: ClassifierOutcome = {
      decision: 'error',
      reason: 'not run',
      costUsd: 0,
      model: this.opts.provider.model,
      raw: '',
    };

    try {
      const res = await this.opts.provider.complete({
        tier,
        messages: [
          { role: 'system', content: this.opts.prompt ?? DEFAULT_CLASSIFIER_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({ summary: args.delta.summary, payload: args.delta.payload ?? null }).slice(0, 8000),
          },
        ],
        maxOutputTokens: this.opts.maxOutputTokens ?? 120,
        temperature: 0,
        category: 'classifier',
      });

      outcome.costUsd = round(
        (res.usage.tokensIn / 1_000_000) * this.opts.price.in +
          (res.usage.tokensOut / 1_000_000) * this.opts.price.out,
      );
      outcome.model = res.model;
      outcome.raw = res.content;

      this.opts.ledger.record({
        provider: res.provider,
        model: res.model,
        tier,
        unitPriceInUsd: this.opts.price.in,
        unitPriceOutUsd: this.opts.price.out,
        tokensIn: res.usage.tokensIn,
        tokensOut: res.usage.tokensOut,
        isEstimated: res.usage.estimated,
        aborted: res.aborted,
        category: 'classifier',
      });

      const parsed = parseDecision(res.content);
      if (parsed) {
        outcome = { ...outcome, decision: parsed.decision, reason: parsed.reason };
      } else {
        // Unparseable output is an ERROR, not a silent discard: a filter that
        // fails closed hides exactly the events it was meant to surface.
        outcome = { ...outcome, decision: 'error', reason: `unparseable classifier output: ${res.content.slice(0, 200)}` };
      }
    } catch (err) {
      outcome = { ...outcome, decision: 'error', reason: (err as Error).message };
    }

    this.log({
      factoryId: args.factoryId,
      jobId: args.jobId,
      triggerId: args.triggerId,
      model: outcome.model,
      inputDigest: digest(args.delta),
      decision: outcome.decision,
      reason: outcome.reason,
      outputJson: JSON.stringify({ raw: outcome.raw }).slice(0, 8000),
      costUsd: outcome.costUsd,
    });

    return outcome;
  }

  log(row: {
    factoryId: string;
    jobId: string | null;
    triggerId: string | null;
    model: string;
    inputDigest: string;
    decision: 'wake' | 'discard' | 'error';
    reason: string;
    outputJson: string;
    costUsd: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO classifier_logs
           (factory_id, job_id, trigger_id, model, input_digest, decision, reason, output_json, cost_usd, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.factoryId,
        row.jobId,
        row.triggerId,
        row.model,
        row.inputDigest,
        row.decision,
        row.reason,
        row.outputJson,
        round(row.costUsd),
        Date.now(),
      );
  }

  listLogs(factoryId: string, limit = 100): ClassifierLogRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM classifier_logs WHERE factory_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(factoryId, limit) as RawLog[];
    return rows.map(mapLog);
  }
}

function parseDecision(text: string): ClassifierDecision | null {
  // The model may wrap JSON in prose or code fences; find the first object.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as unknown;
    const parsed = ClassifierDecisionSchema.safeParse(obj);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function digest(delta: JobDelta): string {
  return createHash('sha256').update(JSON.stringify({ s: delta.summary, p: delta.payload ?? null })).digest('hex').slice(0, 32);
}

function round(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

// ------------------------------------------------------------------ triggers

export const TriggerKindSchema = z.enum(['cron', 'webhook', 'file_watcher', 'log_event']);
export type TriggerKind = z.infer<typeof TriggerKindSchema>;

export interface TriggerRow {
  id: string;
  factoryId: string;
  kind: TriggerKind;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  secret: string | null;
  lastFireAt: number | null;
  nextFireAt: number | null;
}

export interface PipelineResult {
  jobId: string;
  triggerId: string | null;
  /** 'no_delta' means the job found nothing: cost is exactly 0. */
  stage: 'no_delta' | 'discarded' | 'woke' | 'error';
  delta: JobDelta | null;
  classifier: ClassifierOutcome | null;
  /** Total USD spent on this firing. 0 when no model was called. */
  costUsd: number;
  /** Whether the caller should start an agent run. */
  shouldWake: boolean;
  reason: string;
}

export interface ProactiveHarnessOptions {
  db: Db;
  factoryId: string;
  classifier: Classifier;
  /** Called when the classifier says "wake". Starts the expensive work. */
  onWake?: (args: { job: ProactiveJob; delta: JobDelta; triggerId: string | null }) => Promise<void> | void;
}

export interface ProactiveHarness extends HarnessModule {
  registerJob(job: ProactiveJob): void;
  jobs(): ProactiveJob[];
  /** Runs one job end to end and returns a full, auditable result. */
  fireJob(jobId: string, event?: unknown, triggerId?: string | null): Promise<PipelineResult>;
  addTrigger(input: {
    kind: TriggerKind;
    name: string;
    config: Record<string, unknown>;
    secret?: string;
  }): TriggerRow;
  listTriggers(): TriggerRow[];
  listClassifierLogs(limit?: number): ClassifierLogRow[];
}

export function createProactiveHarness(opts: ProactiveHarnessOptions): ProactiveHarness {
  ensureProactiveTables(opts.db);
  const registry = new Map<string, ProactiveJob>();
  const { db, factoryId } = opts;

  function addTrigger(input: { kind: TriggerKind; name: string; config: Record<string, unknown>; secret?: string }): TriggerRow {
    const parsed = TriggerKindSchema.parse(input.kind);
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO triggers_and_jobs (id, factory_id, kind, name, enabled, config_json, secret, created_at, updated_at)
       VALUES (?,?,?,?,1,?,?,?,?)`,
    ).run(id, factoryId, parsed, input.name, JSON.stringify(input.config), input.secret ?? null, now, now);
    return getTrigger(id)!;
  }

  function getTrigger(id: string): TriggerRow | null {
    const row = db.prepare(`SELECT * FROM triggers_and_jobs WHERE id = ? AND factory_id = ?`).get(id, factoryId) as
      | RawTrigger
      | undefined;
    return row ? mapTrigger(row) : null;
  }

  function listTriggers(): TriggerRow[] {
    const rows = db
      .prepare(`SELECT * FROM triggers_and_jobs WHERE factory_id = ? ORDER BY created_at DESC`)
      .all(factoryId) as RawTrigger[];
    return rows.map(mapTrigger);
  }

  async function fireJob(jobId: string, event: unknown = null, triggerId: string | null = null): Promise<PipelineResult> {
    const job = registry.get(jobId);
    if (!job) throw new NotFoundError(`Job '${jobId}' is not registered`);

    const state = new StateStore(db, `${factoryId}:${jobId}`);
    let delta: JobDelta;
    try {
      delta = JobDeltaSchema.parse(
        await job.run({ factoryId, triggerId, jobId, event, state, now: Date.now() }),
      );
    } catch (err) {
      // A broken job is an error, not a silent pass.
      opts.classifier.log({
        factoryId,
        jobId,
        triggerId,
        model: 'n/a',
        inputDigest: 'job_error',
        decision: 'error',
        reason: `job failed: ${(err as Error).message}`,
        outputJson: JSON.stringify({ error: String(err) }).slice(0, 4000),
        costUsd: 0,
      });
      return {
        jobId,
        triggerId,
        stage: 'error',
        delta: null,
        classifier: null,
        costUsd: 0,
        shouldWake: false,
        reason: `job failed: ${(err as Error).message}`,
      };
    }

    if (!delta.changed) {
      // THE economic guarantee: no model call, no cost, but still auditable.
      opts.classifier.log({
        factoryId,
        jobId,
        triggerId,
        model: 'none',
        inputDigest: digest(delta),
        decision: 'discard',
        reason: delta.summary || 'no delta reported by the job (deterministic, no model called)',
        outputJson: JSON.stringify({ stage: 'no_delta' }),
        costUsd: 0,
      });
      return {
        jobId,
        triggerId,
        stage: 'no_delta',
        delta,
        classifier: null,
        costUsd: 0,
        shouldWake: false,
        reason: 'no delta: $0 spent, agent not woken',
      };
    }

    const outcome = await opts.classifier.classify({ factoryId, jobId, triggerId, delta });
    if (outcome.decision === 'wake') {
      await opts.onWake?.({ job, delta, triggerId });
      return {
        jobId,
        triggerId,
        stage: 'woke',
        delta,
        classifier: outcome,
        costUsd: outcome.costUsd,
        shouldWake: true,
        reason: outcome.reason,
      };
    }
    if (outcome.decision === 'error') {
      return {
        jobId,
        triggerId,
        stage: 'error',
        delta,
        classifier: outcome,
        costUsd: outcome.costUsd,
        shouldWake: false,
        reason: outcome.reason,
      };
    }
    return {
      jobId,
      triggerId,
      stage: 'discarded',
      delta,
      classifier: outcome,
      costUsd: outcome.costUsd,
      shouldWake: false,
      reason: outcome.reason,
    };
  }

  // ----------------------------------------------------------- commands
  const triggersList: CommandDefinition<z.ZodObject<Record<string, never>>> = {
    name: 'proactive.triggers',
    description: 'List configured proactive triggers (cron, webhook, file_watcher, log_event).',
    inputSchema: z.object({}),
    allowedActors: ['human', 'lead'],
    idempotent: true,
    execute: () => ({ triggers: listTriggers() }),
  };

  const JOB_LIST_INPUT = z.object({});
  const jobsList: CommandDefinition<typeof JOB_LIST_INPUT> = {
    name: 'proactive.jobs',
    description: 'List registered code-first jobs.',
    inputSchema: JOB_LIST_INPUT,
    allowedActors: ['human', 'lead'],
    idempotent: true,
    execute: () => ({
      jobs: [...registry.values()].map((j) => ({ id: j.id, name: j.name, modulePath: j.modulePath })),
    }),
  };

  const FIRE_INPUT = z.object({
    jobId: z.string().min(1),
    event: z.unknown().optional(),
  });
  const fire: CommandDefinition<typeof FIRE_INPUT> = {
    name: 'proactive.fire',
    description:
      'Run a job through the code-first pipeline now. Returns whether the agent was woken and what it cost.',
    inputSchema: FIRE_INPUT,
    allowedActors: ['human', 'lead'],
    // Firing twice can double-wake an agent; not safe to replay.
    idempotent: false,
    execute: async (input) => fireJob(input.jobId, input.event ?? null),
  };

  const ADD_TRIGGER_INPUT = z.object({
    kind: TriggerKindSchema,
    name: z.string().min(1).max(200),
    config: z.record(z.string(), z.unknown()).default({}),
    secret: z.string().min(16).max(200).optional(),
  });
  const addTriggerCmd: CommandDefinition<typeof ADD_TRIGGER_INPUT> = {
    name: 'proactive.addTrigger',
    description: 'Register a trigger. webhook triggers require a secret (16+ chars).',
    inputSchema: ADD_TRIGGER_INPUT,
    allowedActors: ['human', 'lead'],
    idempotent: false,
    execute(input) {
      if (input.kind === 'webhook' && !input.secret) {
        throw new FactoryError('webhook triggers require a secret', 'SECRET_REQUIRED', 400);
      }
      return { trigger: addTrigger(input) };
    },
  };

  const LOGS_INPUT = z.object({ limit: z.number().int().min(1).max(500).default(100) });
  const logsCmd: CommandDefinition<typeof LOGS_INPUT> = {
    name: 'proactive.classifierLogs',
    description: 'Read the classifier audit trail, including every discard.',
    inputSchema: LOGS_INPUT,
    allowedActors: ['human', 'lead'],
    idempotent: true,
    execute: (input) => ({ logs: opts.classifier.listLogs(factoryId, input.limit) }),
  };

  return {
    id: 'proactive',
    name: 'Proactive',
    commands: [triggersList, jobsList, fire, addTriggerCmd, logsCmd],
    registerJob(job) {
      if (registry.has(job.id)) throw new Error(`Job '${job.id}' already registered`);
      registry.set(job.id, job);
      db.prepare(
        `INSERT INTO jobs (id, factory_id, trigger_id, name, module_path, created_at)
         VALUES (?,?,NULL,?,?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, module_path = excluded.module_path`,
      ).run(job.id, factoryId, job.name, job.modulePath, Date.now());
    },
    jobs: () => [...registry.values()],
    fireJob,
    addTrigger,
    listTriggers,
    listClassifierLogs: (limit = 100) => opts.classifier.listLogs(factoryId, limit),
    renderPromptSection(ctx) {
      if (!ctx.toolNames.includes('proactive.fire')) return '';
      return [
        '## Proactive',
        'Triggers wake you only after a deterministic job found a real delta AND a classifier judged it actionable.',
        'When you run proactive.fire yourself, you spend classifier money; do it to verify a job, not to poll.',
      ].join('\n');
    },
  };
}

export interface ClassifierLogRow {
  id: number;
  factoryId: string;
  jobId: string | null;
  triggerId: string | null;
  model: string;
  inputDigest: string;
  decision: 'wake' | 'discard' | 'error';
  reason: string | null;
  outputJson: string | null;
  costUsd: number;
  createdAt: number;
}

interface RawLog {
  id: number;
  factory_id: string;
  job_id: string | null;
  trigger_id: string | null;
  model: string;
  input_digest: string;
  decision: string;
  reason: string | null;
  output_json: string | null;
  cost_usd: number;
  created_at: number;
}

function mapLog(r: RawLog): ClassifierLogRow {
  return {
    id: r.id,
    factoryId: r.factory_id,
    jobId: r.job_id,
    triggerId: r.trigger_id,
    model: r.model,
    inputDigest: r.input_digest,
    decision: r.decision as ClassifierLogRow['decision'],
    reason: r.reason,
    outputJson: r.output_json,
    costUsd: r.cost_usd,
    createdAt: r.created_at,
  };
}

interface RawTrigger {
  id: string;
  factory_id: string;
  kind: string;
  name: string;
  enabled: number;
  config_json: string;
  secret: string | null;
  last_fire_at: number | null;
  next_fire_at: number | null;
}

function mapTrigger(r: RawTrigger): TriggerRow {
  return {
    id: r.id,
    factoryId: r.factory_id,
    kind: r.kind as TriggerKind,
    name: r.name,
    enabled: r.enabled === 1,
    config: JSON.parse(r.config_json) as Record<string, unknown>,
    secret: r.secret,
    lastFireAt: r.last_fire_at,
    nextFireAt: r.next_fire_at,
  };
}

export { digest };
export * from './triggers.js';
