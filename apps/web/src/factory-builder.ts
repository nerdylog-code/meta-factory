/**
 * Factory registry: turns a config name into a wired, runnable factory.
 *
 * Single place where "which harnesses does this factory have" and "which
 * provider serves which tier" are decided, so the CLI and the MetaFactory's
 * `factory.spinUp` cannot diverge.
 */
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  BudgetEnforcer,
  CommandBus,
  DurableRunner,
  FakeLLMProvider,
  LlmRouter,
  OpenAiCompatibleProvider,
  SqliteGateStore,
  TokenLedger,
  ToolSummarizer,
  getModelPrice,
  openDb,
  type Db,
  type FactoryConfig,
  type HarnessModule,
  type LlmProvider,
  type ReadModelExtension,
  type Tier,
} from '@mf/core';
import { createNotesHarness, ensureNotesTable } from '@mf/harness-notes';
import {
  DisabledDriver,
  LocalProcessDriver,
  Workspace,
  createCodingHarness,
} from '@mf/harness-coding';
import { createPagesHarness } from '@mf/harness-pages';
import { SettingsStore, createSettingsHarness } from '@mf/harness-settings';
import { createTeamsHarness } from '@mf/harness-teams';
import { createMailboxHarness } from '@mf/harness-mailbox';
import { createMetaFactoryHarness } from '@mf/harness-metafactory';
import { createSubagentsHarness } from '@mf/harness-subagents';
import { Classifier, createProactiveHarness, type ProactiveHarness } from '@mf/harness-proactive';

export interface BuildFactoryOptions {
  env: NodeJS.ProcessEnv;
  /** Directory holding `factory.config.ts` and `state.db`. */
  dir: string;
  config: FactoryConfig;
  port: number;
  /** PageStage origin port (separate origin is required by the design). */
  pageStagePort?: number;
  /** Overrides the config's pool size. */
  budgetUsd?: number;
  /** Force the deterministic provider (tests / offline demos). */
  useFakeProvider?: boolean;
  extraHarnesses?: HarnessModule[];
  extraReadModels?: ReadModelExtension[];
  humanToken?: import('@mf/core').HumanToken;
  /** UI dev server origin; defaults to same-origin. */
  uiOrigin?: string;
}

export interface BuiltFactory {
  db: Db;
  config: FactoryConfig;
  bus: CommandBus;
  runner: DurableRunner;
  ledger: TokenLedger;
  budget: BudgetEnforcer;
  poolId: string;
  harnesses: HarnessModule[];
  router: LlmRouter | null;
  provider: LlmProvider;
  price: { in: number; out: number };
  proactive: ProactiveHarness | null;
  drain(): Promise<void>;
}

/**
 * Tier -> model map.
 *
 * CURRENT POLICY: deepseek-v4-1-flash-1017 serves every tier. Recorded decision:
 * switching a tier to a cheap model is a future optimization, so it is exposed
 * as a flag (`MF_CHEAP_MODEL`) rather than hardcoded.
 *
 * ECONOMIC NOTE (do not lose this): the proactive classifier and tool-summary
 * exist to avoid waking the expensive agent on noise. Running them on a frontier
 * model costs roughly 3500x per discard compared with a small local model. The
 * architecture is still correct; only the cost per triggered job is higher.
 */
export const PRIMARY_MODEL = 'deepseek-v4-1-flash-1017';
/** Tiers that MAY be routed to a cheaper model when the flag is set. */
const CHEAP_TIER_CANDIDATES = new Set<Tier>(['C', 'D']);

export const DEFAULT_ROUTES = [
  { tier: 'S+' as Tier, model: PRIMARY_MODEL },
  { tier: 'S' as Tier, model: PRIMARY_MODEL },
  { tier: 'A' as Tier, model: PRIMARY_MODEL },
  { tier: 'B' as Tier, model: PRIMARY_MODEL },
  { tier: 'C' as Tier, model: PRIMARY_MODEL },
  { tier: 'D' as Tier, model: PRIMARY_MODEL },
] as const;

/**
 * Resolves the model for a tier, honouring the optional cheap-model flag.
 * Pure: the same inputs always produce the same model, so route reporting in
 * the UI matches what the runner actually uses.
 */
export function resolveTierModel(tier: Tier, env: NodeJS.ProcessEnv = process.env): string {
  const cheap = env['MF_CHEAP_MODEL']?.trim();
  if (cheap && CHEAP_TIER_CANDIDATES.has(tier)) return cheap;
  return DEFAULT_ROUTES.find((r) => r.tier === tier)?.model ?? PRIMARY_MODEL;
}

/** Context window of a model, for compaction thresholds. */
export function contextLimitFor(model: string): number {
  if (model.startsWith('deepseek')) return 1_000_000;
  if (model.startsWith('ministral-3b')) return 131_072;
  if (model.startsWith('ministral-8b')) return 262_144;
  return 128_000;
}

/**
 * Builds a router over the configured providers. Returns null when no API key
 * is present so the caller can decide between failing loudly and using Fake.
 */
export function buildRouter(env: NodeJS.ProcessEnv = process.env): LlmRouter | null {
  const apiKey = env.MISTRAL_API_KEY;
  if (!apiKey) return null;

  const providerId = 'mistral';
  return new LlmRouter(
    {
      providers: [
        {
          id: providerId,
          kind: 'openai-compatible',
          baseUrl: env.MISTRAL_BASE_URL ?? 'https://api.mistral.ai/v1',
          apiKeyEnv: 'MISTRAL_API_KEY',
          extraHeaders: {},
          supportsThinking: false,
        },
      ],
      routes: DEFAULT_ROUTES.map((r) => {
        const model = resolveTierModel(r.tier, env);
        return {
          tier: r.tier,
          providerId,
          model,
          thinking: 'off' as const,
          maxOutputTokens: 4096,
          temperature: 0.2,
          contextLimitTokens: contextLimitFor(model),
        };
      }),
      compaction: { enabled: true, triggerRatio: 0.75, keepLastMessages: 6 },
    },
    {
      resolveApiKey: (_id, envVar) => env[envVar],
      createProvider: (cfg, model, key) =>
        new OpenAiCompatibleProvider({
          name: cfg.id,
          baseUrl: cfg.baseUrl ?? 'https://api.mistral.ai/v1',
          apiKey: key,
          model,
          unitPriceInUsd: getModelPrice(model).in,
          unitPriceOutUsd: getModelPrice(model).out,
          supportsThinking: cfg.supportsThinking,
        }),
    },
  );
}

export function buildFactory(opts: BuildFactoryOptions): BuiltFactory {
  const { config, dir } = opts;
  const dbPath = join(dir, 'state.db');
  const db = openDb({ path: dbPath });
  const ledger = new TokenLedger(db);
  const budget = new BudgetEnforcer(db);
  const bus = new CommandBus(db);
  const gates = new SqliteGateStore(db);
  bus.setGateStore(gates);

  // Reuse an existing factory pool across restarts instead of minting a new
  // one each boot (which would silently reset the budget).
  const existing = db
    .prepare(`SELECT id FROM budget_pools WHERE owner_kind = 'factory' AND owner_id = ? ORDER BY created_at LIMIT 1`)
    .get(config.name) as { id: string } | undefined;
  const poolId =
    existing?.id ??
    budget.createPool({
      ownerKind: 'factory',
      ownerId: config.name,
      amountUsd: opts.budgetUsd ?? config.budgetUsd,
    }).id;

  ensureNotesTable(db);

  const harnesses: HarnessModule[] = [...(config.harnesses.includes('notes') ? [createNotesHarness(db, config.name)] : [])];
  if (config.harnesses.includes('coding')) {
    const root = resolveWorkspaceRoot(dir, config);
    mkdirSync(root, { recursive: true });
    harnesses.push(
      createCodingHarness({
        workspace: Workspace.createSync(root),
        // Shell is opt-in: without MF_SHELL=1 the driver refuses, and even with
        // it the command still needs a human gate.
        sandbox: opts.env['MF_SHELL'] === '1' ? new LocalProcessDriver() : new DisabledDriver(),
      }),
    );
  }
  if (config.harnesses.includes('pages')) {
    harnesses.push(createPagesHarness({ db, factoryId: config.name }));
  }
  if (config.harnesses.includes('teams')) {
    harnesses.push(createTeamsHarness({ db, factoryId: config.name }));
  }
  if (config.harnesses.includes('mailbox')) {
    harnesses.push(createMailboxHarness({ db, factoryId: config.name }));
  }
  if (config.harnesses.includes('metafactory')) {
    // The MetaFactory manages the repository this factory lives in.
    harnesses.push(createMetaFactoryHarness({ root: resolve(dir, '..', '..') }));
  }
  if (config.harnesses.includes('subagents')) {
    harnesses.push(
      createSubagentsHarness({
        db,
        parentPoolId: poolId,
        budget,
        ledger,
        bus,
        providerFor: (t: Tier) => {
          if (useFake) return { provider: fakeProvider, price: { in: 0, out: 0 } };
          const model = resolveTierModel(t, opts.env);
          const p = getModelPrice(model);
          return { provider: router!.providerFor(t), price: { in: p.in, out: p.out } };
        },
      }),
    );
  }
  // Settings are always available: the Core Four must never be unreachable.
  harnesses.push(createSettingsHarness({ db, factoryId: config.name }));
  harnesses.push(...(opts.extraHarnesses ?? []));
  for (const h of harnesses) bus.registerAll(h.commands);

  // A harness named in the config but not implemented here must be LOUD: a
  // silently missing capability is indistinguishable from a broken one.
  const KNOWN = new Set([
    'notes',
    'coding',
    'pages',
    'settings',
    'teams',
    'mailbox',
    'metafactory',
    'proactive',
    'subagents',
  ]);
  const unknown = config.harnesses.filter((h) => !KNOWN.has(h));
  if (unknown.length > 0) {
    throw new Error(
      `Factory '${config.name}' requests unknown harness(es): ${unknown.join(', ')}. ` +
        `Known: ${[...KNOWN].join(', ')}`,
    );
  }

  const router = opts.useFakeProvider ? null : buildRouter(opts.env);
  const useFake = opts.useFakeProvider === true || router === null;
  const fakeProvider = new FakeLLMProvider({
    script: [
      { type: 'tool_call', name: 'notes.create', args: { title: 'Hello from the sandbox', body: 'The factory works.' }, callId: 'demo-1' },
      { type: 'tool_call', name: 'notes.delete', args: { id: 'any-note' }, callId: 'demo-2' },
      { type: 'text', content: 'Done: created a note, and the delete is waiting on a human decision.' },
    ],
    providerName: useFake && router === null && !opts.useFakeProvider ? 'fake-no-key' : 'fake',
    model: 'fake-model',
  });

  const tier = config.tier;
  const tierModel = resolveTierModel(tier, opts.env);
  const price = useFake ? { in: 0, out: 0 } : { in: getModelPrice(tierModel).in, out: getModelPrice(tierModel).out };
  const provider: LlmProvider = useFake ? fakeProvider : router!.providerFor(tier);

  const runner = new DurableRunner({
    db,
    bus,
    ledger,
    budget,
    provider,
    price,
    // Every tier resolves through the same map the CLI reports, so a run's tier
    // can never silently execute on a different model than advertised.
    providerFor: (t: Tier) => {
      if (useFake) return { provider: fakeProvider, price: { in: 0, out: 0 } };
      const model = resolveTierModel(t, opts.env);
      const p = getModelPrice(model);
      return { provider: router!.providerFor(t), price: { in: p.in, out: p.out } };
    },
    summarizer: toolSummarizerFor({ db, ledger, useFake, fakeProvider, router, env: opts.env }),
  });

  // ---------------------------------------------------- proactive (Phase 3)
  // Built after the runner so `onWake` can start a real agent run.
  let proactive: ProactiveHarness | null = null;
  /** Wake-runs still executing; shutdown waits for these before closing the db. */
  const pendingRuns = new Set<string>();
  if (config.harnesses.includes('proactive')) {
    // The classifier needs its OWN fake script in demo mode: sharing one FakeLLM
    // script with the run loop means each call consumes the other's steps and
    // the classifier reads empty output ("unparseable"), which looks like a bug
    // in the classifier rather than in the wiring.
    const classifierFake = new FakeLLMProvider({
      script: [{ type: 'text', content: '{"decision":"wake","reason":"files changed in the workspace"}' }],
      providerName: 'fake-classifier',
      model: 'fake-cheap',
      tokensIn: 200,
      tokensOut: 20,
    });
    const classifierProvider = useFake ? classifierFake : router!.providerFor('D');
    const classifierModel = resolveTierModel('D', opts.env);
    const classifierPrice = useFake
      ? { in: 0.04, out: 0.04 }
      : { in: getModelPrice(classifierModel).in, out: getModelPrice(classifierModel).out };

    const classifier = new Classifier(db, {
      provider: classifierProvider,
      ledger,
      tier: 'D',
      price: classifierPrice,
    });

    proactive = createProactiveHarness({
      db,
      factoryId: config.name,
      classifier,
      // Waking the agent is the ONLY expensive step, and it happens only after
      // the deterministic job found a delta AND the classifier said "wake".
      onWake: ({ delta }) => {
        // Registered so shutdown can wait for it: closing the database while a
        // wake-run is mid-flight throws "database connection is not open".
        const goal = `Investigate and act on this detected change:\n\n${delta.summary}`;
        const run = runner.createRun({
          factoryId: config.name,
          goal,
          tier: config.tier,
          poolId,
          systemPrompt: delta.summary,
        });
        pendingRuns.add(run.id);
        void runner
          .startExisting(run.id, {
            factoryId: config.name,
            goal,
            tier: config.tier,
            poolId,
            systemPrompt: delta.summary,
            maxTurns: 6,
          })
          .catch((err: unknown) => console.error('[proactive] wake failed', err))
          .finally(() => pendingRuns.delete(run.id));
      },
    });
    harnesses.push(proactive);
    bus.registerAll(proactive.commands);
    registerDefaultJobs(proactive);
  }

  return {
    db,
    config,
    bus,
    runner,
    ledger,
    budget,
    poolId,
    harnesses,
    router,
    provider,
    price,
    proactive,
    /** Resolves once no wake-run is executing. */
    drain: async () => {
      const deadline = Date.now() + 10_000;
      while (pendingRuns.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
    },
  };
}

/**
 * Jobs shipped with every factory. Each is deterministic: no model calls, so a
 * run that finds nothing costs exactly $0.
 */
export function registerDefaultJobs(proactive: ProactiveHarness): void {
  proactive.registerJob({
    id: 'workspace-scan',
    name: 'Workspace file scan',
    modulePath: 'jobs/workspace-scan.ts',
    async run(ctx) {
      const state = ctx.state.get<number>('count') ?? 0;
      const event = ctx.event as { count?: number } | null;
      const count = typeof event?.count === 'number' ? event.count : state;
      if (count === state) return { changed: false, summary: 'workspace unchanged' };
      ctx.state.set('count', count);
      return { changed: true, summary: `${count - state} new file(s) appeared in the workspace`, payload: { count } };
    },
  });

  proactive.registerJob({
    id: 'note-count',
    name: 'Note count watch',
    modulePath: 'jobs/note-count.ts',
    async run(ctx) {
      // The count arrives with the trigger event (e.g. a webhook payload).
      // No event means no observation, so no delta and no spend.
      const event = ctx.event as { noteCount?: number } | null;
      if (typeof event?.noteCount !== 'number') return { changed: false, summary: 'no note count supplied' };
      const seen = ctx.state.get<number>('noteCount') ?? 0;
      if (event.noteCount === seen) return { changed: false, summary: 'note count unchanged' };
      ctx.state.set('noteCount', event.noteCount);
      return {
        changed: true,
        summary: `note count changed from ${seen} to ${event.noteCount}`,
        payload: { from: seen, to: event.noteCount },
      };
    },
  });
}

/** Absolute workspace root for a factory config. */
export function resolveWorkspaceRoot(dir: string, config: FactoryConfig): string {
  return resolve(dir, config.workspaceRoot);
}

/**
 * Builds the tool summarizer, or returns undefined when summaries are disabled.
 *
 * `MF_TOOL_SUMMARY_EVERY` controls batching; `0` disables summarization
 * entirely (useful for a zero-cost demo or when the owner is paying per token
 * and does not want observability spend).
 */
export function toolSummarizerFor(args: {
  db: Db;
  ledger: TokenLedger;
  useFake: boolean;
  fakeProvider: LlmProvider;
  router: LlmRouter | null;
  env: NodeJS.ProcessEnv;
}): ToolSummarizer | undefined {
  const every = Number(args.env['MF_TOOL_SUMMARY_EVERY'] ?? 3);
  if (!Number.isFinite(every) || every <= 0) return undefined;

  const tier: Tier = 'D';
  const model = resolveTierModel(tier, args.env);
  const provider = args.useFake ? args.fakeProvider : args.router!.providerFor(tier);
  const price = args.useFake ? { in: 0, out: 0 } : getModelPrice(model);

  return new ToolSummarizer({
    db: args.db,
    ledger: args.ledger,
    provider,
    tier,
    price: { in: price.in, out: price.out },
    every,
  });
}







