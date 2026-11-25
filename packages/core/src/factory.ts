import { BudgetEnforcer } from './budget/enforcer.js';
import { TokenLedger } from './budget/ledger.js';
import { LedgerQueries } from './budget/ledger-queries.js';
import { CommandBus } from './bus/command-bus.js';
import { openDb, type Db } from './db/client.js';
import { HumanToken } from './server/security.js';
import { DurableRunner, type RunnerDeps } from './runner/durable-runner.js';
import { createApp, type AppBundle, type ReadModelExtension } from './server/app.js';
import type { LlmProvider } from './llm/types.js';
import type { HarnessModule, Tier } from './types.js';

export interface BootstrapOptions {
  factoryId: string;
  dbPath: string;
  port: number;
  /** Agent harnesses to register. Empty is valid (core-only factory). */
  harnesses?: HarnessModule[];
  /** Provider that serves the run loop. */
  provider: LlmProvider;
  price?: { in: number; out: number };
  tier?: Tier;
  /** Starting pool. Use a tiny number in demo factories to exercise the enforcer. */
  budgetUsd?: number;
  humanToken?: HumanToken;
  uiOrigin?: string;
  readModels?: ReadModelExtension[];
  /** Replaces the auto-rendered system prompt. */
  renderSystemPrompt?: (args: unknown) => string;
}

export interface Factory {
  db: Db;
  bus: CommandBus;
  ledger: TokenLedger;
  budget: BudgetEnforcer;
  runner: DurableRunner;
  /** Hono app (the bundle also carries the broker + token). */
  app: AppBundle['app'];
  /** HTTP server bundle: `{ app, broker, token, url }`. */
  bundle: AppBundle;
  token: HumanToken;
  factoryId: string;
  poolId: string;
  close(): void;
}

/**
 * Wires a factory: db -> ledger/budget -> bus -> runner -> http app.
 * Kept in one place so tests and the real server cannot drift apart.
 */
export function bootstrapFactory(opts: BootstrapOptions): Factory {
  const db = openDb({ path: opts.dbPath });
  const ledger = new TokenLedger(db);
  const budget = new BudgetEnforcer(db);
  const bus = new CommandBus(db);

  for (const h of opts.harnesses ?? []) {
    bus.registerAll(h.commands);
  }

  const pool = budget.createPool({
    ownerKind: 'factory',
    ownerId: opts.factoryId,
    amountUsd: opts.budgetUsd ?? 5,
  });

  const runnerDeps: RunnerDeps = {
    db,
    bus,
    ledger,
    budget,
    provider: opts.provider,
    price: opts.price ?? { in: 0, out: 0 },
  };
  const runner = new DurableRunner(runnerDeps);

  // renderPromptSection is composed here so every harness sees the same actor
  // and the same (capability-filtered) tool list.
  if (opts.harnesses && opts.harnesses.length > 0) {
    runnerDeps.renderSystemPrompt = (args) => {
      const a = args as { factoryId: string };
      const toolNames = bus.listToolsForActor('lead').map((t) => t.name);
      const sections = opts.harnesses!.map((h) =>
        h.renderPromptSection({ actor: { kind: 'agent', role: 'lead', agentId: 'lead', runId: '', toolCallId: '' }, toolNames, factoryName: a.factoryId }),
      );
      return sections.join('\n\n');
    };
  }
  if (opts.renderSystemPrompt) {
    runnerDeps.renderSystemPrompt = opts.renderSystemPrompt as (args: unknown) => string;
  }

  for (const h of opts.harnesses ?? []) {
    void h.onRegister?.(bus);
  }

  const ledgerQueries = new LedgerQueries(db);
  const app = createApp({
    db,
    bus,
    runner,
    ledger,
    ledgerQueries,
    port: opts.port,
    humanToken: opts.humanToken,
    uiOrigin: opts.uiOrigin,
    harnesses: opts.harnesses,
    factoryId: opts.factoryId,
    readModels: opts.readModels,
  });

  return {
    db,
    bus,
    ledger,
    budget,
    runner,
    app: app.app,
    bundle: app,
    token: app.token,
    factoryId: opts.factoryId,
    poolId: pool.id,
    close: () => {
      // Close SSE streams FIRST: an open stream keeps the HTTP server alive,
      // so shutting the db down before terminating streams makes close() hang.
      app.broker.closeAll();
      db.close();
    },
  };
}

