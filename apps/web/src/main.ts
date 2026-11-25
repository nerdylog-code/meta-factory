/**
 * Factory boot entrypoint.
 *
 * Usage:  MISTRAL_API_KEY=... pnpm --filter @mf/app dev [factoryDir]
 *
 * Prints the URL with the ephemeral token in the fragment. The token exists
 * only in this process's memory.
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { FactoryConfigSchema, LedgerQueries, createApp, type FactoryConfig } from '@mf/core';
import { buildFactory, resolveTierModel } from './factory-builder.js';
import { registerRunRoutes, composeSystemPrompt } from './run-routes.js';
import { startPageStage } from '@mf/harness-pages';
import { phase2ReadModels } from './read-models.js';

async function loadConfigAsync(dir: string): Promise<FactoryConfig> {
  const cfgPath = join(dir, 'factory.config.ts');
  if (!existsSync(cfgPath)) throw new Error(`No factory.config.ts in ${dir}`);
  const mod = (await import(new URL(`file://${cfgPath.replace(/\\/g, '/')}`).href)) as {
    default: unknown;
  };
  return FactoryConfigSchema.parse(mod.default);
}

async function main(): Promise<void> {
  const repoRoot = resolve(process.argv[2] ?? process.cwd());
  const factoriesDir = join(repoRoot, 'factories');
  if (!existsSync(factoriesDir)) {
    throw new Error(`Expected a factories/ directory at ${repoRoot}`);
  }

  const available = readdirSync(factoriesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const which = process.env['MF_FACTORY'] ?? 'sandbox';
  if (!available.includes(which)) {
    throw new Error(`Factory '${which}' not found. Available: ${available.join(', ')}`);
  }

  const dir = join(factoriesDir, which);
  const config = await loadConfigAsync(dir);
  const port = Number(process.env['MF_PORT'] ?? config.port);
  const pageStagePort = Number(process.env['MF_PAGESTAGE_PORT'] ?? config.pageStagePort ?? port + 1);

  const built = buildFactory({
    dir,
    config,
    port,
    pageStagePort,
    env: process.env,
    useFakeProvider: process.env['MF_FAKE'] === '1',
  });
  const uiOrigin = process.env['MF_UI_ORIGIN'] ?? `http://127.0.0.1:${port}`;

  // PageStage starts BEFORE the shell so its URL is available to the shell's
  // read models. It runs on its own origin: different port means different
  // origin, which is what makes the postMessage whitelist meaningful.
  const pageStage = await startPageStage({ db: built.db, port: pageStagePort });
  process.env['MF_PORT'] = String(port);

  const bundle = createApp({
    db: built.db,
    bus: built.bus,
    runner: built.runner,
    ledger: built.ledger,
    ledgerQueries: new LedgerQueries(built.db),
    // Resuming after approval needs the SAME prompt composition the run started
    // with, or the agent wakes up with amnesia about its own instructions.
    promptForResume: {
      forRun: () =>
        composeSystemPrompt(
          config,
          built.harnesses,
          built.bus.listToolsForActor('lead').map((t) => t.name),
          config.agents.find((a) => a.id === 'lead')?.prompt ?? '',
        ),
    },
    port,
    uiOrigin,
    harnesses: built.harnesses,
    factoryId: config.name,
    readModels: phase2ReadModels({
      db: built.db,
      factoryId: config.name,
      pageStageUrl: pageStage.url,
      proactive: built.proactive,
    }),
    extraRoutes: (app) => {
      registerRunRoutes(app, {
        runner: built.runner,
        bus: built.bus,
        harnesses: built.harnesses,
        config,
        defaultPoolId: built.poolId,
      });
      // Model transparency: the UI must be able to show the REAL model name
      // behind the configured tier, not a friendly alias.
      app.get('/api/model-info', (c) =>
        c.json({
          route: { tier: config.tier, model: resolveTierModel(config.tier, process.env), provider: built.provider.name },
          price: built.price,
          cheapModelFlag: process.env['MF_CHEAP_MODEL'] ?? null,
        }),
      );
    },
  });

  const uiIndex = join(repoRoot, 'apps', 'web', 'public', 'index.html');
  bundle.app.get('/', (c) => {
    if (!existsSync(uiIndex)) {
      return c.html(
        `<pre>UI not built yet. Run: pnpm --filter @mf/app build\n\nAPI ready at http://127.0.0.1:${port}/api/health</pre>`,
      );
    }
    return c.html(readFileSync(uiIndex, 'utf8'));
  });

  const server = serve({ fetch: bundle.app.fetch, port, hostname: '127.0.0.1' });
  await new Promise<void>((r) => server.once('listening', () => r()));
  const actualPort = (server.address() as AddressInfo).port;

  const token = bundle.token.value;
  console.log('');
  console.log(`  ${config.title} (${config.name})`);
  console.log(`  provider: ${built.provider.name}/${built.provider.model}`);
  console.log(`  harnesses: ${built.harnesses.map((h) => h.id).join(', ') || '(none)'}`);
  console.log(`  page stage: ${pageStage.url}`);
  console.log('');
  console.log(`  open: http://127.0.0.1:${actualPort}/#token=${token}`);
  console.log('');

  const shutdown = async () => {
    // Order matters, and each step exists because skipping it broke something:
    //  1. tell the runner to stop at the next turn boundary;
    //  2. wait for wake-runs and in-flight loops to finish (they write to the
    //     db; a statement finalized during teardown is a NATIVE assertion that
    //     kills the process, not an exception);
    //  3. end SSE streams, which otherwise keep the HTTP server listening.
    built.runner.beginShutdown();
    await built.drain().catch(() => {});
    const drained = await built.runner.drain(5000).catch(() => false);
    bundle.broker.closeAll();
    void pageStage.close();

    if (!drained) {
      // Closing the db now would crash the process. Leave it open, exit, and let
      // the OS reclaim it: the event log is durable, so nothing is lost.
      console.warn('[shutdown] runs still executing; exiting without closing the database');
      process.exit(0);
    }

    const timer = setTimeout(() => {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      process.exit(0);
    }, 2000);
    server.close(() => {
      clearTimeout(timer);
      try {
        built.db.close();
      } catch {
        /* already closed */
      }
      process.exit(0);
    });
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});








