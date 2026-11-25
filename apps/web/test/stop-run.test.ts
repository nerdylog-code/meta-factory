import { afterEach, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from '@mf/core';
import { bootstrapFactory, createApp, type Factory } from '@mf/core';
import { registerRunRoutes, composeSystemPrompt } from '../src/run-routes.js';
import { FactoryConfigSchema } from '@mf/core';
import { FakeLLMProvider } from '@mf/core';
import { HumanToken, LedgerQueries } from '@mf/core';
import type { LlmProvider, LlmRequest, LlmResponse } from '@mf/core';

const TOKEN = new HumanToken('e'.repeat(64));
const open: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()!();
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

/**
 * A provider whose calls hang until aborted.
 *
 * `stopRun` has to work against a call that is genuinely IN FLIGHT. A provider
 * that returns instantly cannot prove cancellation, because the loop would
 * finish on its own.
 */
function slowProvider(): LlmProvider {
  return {
    name: 'slow',
    model: 'slow-model',
    complete(req: LlmRequest): Promise<LlmResponse> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve({
            content: 'should not get here',
            toolCalls: [],
            usage: { tokensIn: 10, tokensOut: 10, estimated: false },
            aborted: false,
            finishReason: 'stop',
            model: 'slow-model',
            provider: 'slow',
          });
        }, 10_000);
        req.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          // Mirrors a real provider: partial usage is reported, flagged aborted.
          resolve({
            content: '',
            toolCalls: [],
            usage: { tokensIn: 42, tokensOut: 3, estimated: true },
            aborted: true,
            finishReason: 'aborted',
            model: 'slow-model',
            provider: 'slow',
          });
          void reject;
        });
      });
    },
  };
}

async function boot(provider: LlmProvider) {
  const port = await freePort();
  const config = FactoryConfigSchema.parse({
    name: 'stop-test', title: 'Stop Test', port, pageStagePort: port + 1,
    harnesses: [], agents: [{ id: 'lead', role: 'lead', name: 'Lead', prompt: '' }],
  });

  const factory: Factory = bootstrapFactory({
    factoryId: config.name,
    dbPath: ':memory:',
    port,
    provider,
    humanToken: TOKEN,
    harnesses: [],
    uiOrigin: 'http://127.0.0.1:' + port,
    // Real prices, so partial spend is a non-zero number worth asserting.
    price: { in: 1, out: 1 },
  });
  factory.bus.register({
    name: 'notes.list',
    description: 'list',
    inputSchema: z.object({}),
    allowedActors: ['human', 'lead'],
    idempotent: true,
    execute: () => ({ notes: [] }),
  } as never);

  // Mount the app-layer run routes so POST /api/runs and /stop exist.
  const bundle = createApp({
    db: factory.db,
    bus: factory.bus,
    runner: factory.runner,
    ledger: factory.ledger,
    ledgerQueries: new LedgerQueries(factory.db),
    port,
    uiOrigin: 'http://127.0.0.1:' + port,
    harnesses: [],
    factoryId: config.name,
    humanToken: TOKEN,
    extraRoutes: (app) =>
      registerRunRoutes(app, {
        runner: factory.runner,
        bus: factory.bus,
        harnesses: [],
        config,
        defaultPoolId: factory.poolId,
      }),
  });

  const server = serve({ fetch: bundle.app.fetch, port, hostname: '127.0.0.1' });
  await new Promise<void>((r) => server.once('listening', () => r()));
  open.push(async () => {
    bundle.broker.closeAll();
    await new Promise<void>((r) => {
      const t = setTimeout(() => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        r();
      }, 2000);
      server.close(() => {
        clearTimeout(t);
        r();
      });
    });
    factory.close();
  });

  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${TOKEN.value}`, origin: base, 'content-type': 'application/json' };
  async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
    const res = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json: json as T };
  }
  return { factory, call, base };
}

describe('POST /api/runs/:id/stop', () => {
  it('cancels a run that is mid-call and records the partial spend', async () => {
    const { factory, call } = await boot(slowProvider());

    const created = await call<{ run: { id: string } }>('POST', '/api/runs', { goal: 'do something slow' });
    expect(created.status).toBe(202);
    const runId = created.json.run.id;

    // Let the loop enter the hanging model call.
    await new Promise((r) => setTimeout(r, 250));
    expect(factory.runner.getRun(runId)!.status).toBe('running');

    const stopped = await call<{ status: string; spentUsd: number }>('POST', `/api/runs/${runId}/stop`, {});
    expect(stopped.status).toBe(202);
    expect(stopped.json.status).toBe('stopped');

    // The loop unwinds to a terminal state rather than hanging.
    let status = factory.runner.getRun(runId)!.status;
    for (let i = 0; i < 40 && (status === 'running' || status === 'pending'); i++) {
      await new Promise((r) => setTimeout(r, 50));
      status = factory.runner.getRun(runId)!.status;
    }
    expect(status, 'run kept running after stop').not.toBe('running');
    expect(status).toBe('cancelled');

    // Partial usage is in the ledger, flagged aborted, so Tokenomics tells the
    // truth instead of showing zero for work that was paid for.
    const rows = factory.ledger.listForRun(runId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.aborted)).toBe(true);
    expect(factory.ledger.summary({ runId }).abortedCostUsd).toBeGreaterThan(0);
    // And the partial token counts, not just the money.
    const aborted = rows.find((r) => r.aborted)!;
    expect(aborted.tokensIn).toBe(42);
    expect(aborted.tokensOut).toBe(3);
  });

  it('reports 409 honestly when the run is not executing', async () => {
    const { factory, call } = await boot(new FakeLLMProvider({ script: [{ type: 'text', content: 'done' }] }));
    const created = await call<{ run: { id: string } }>('POST', '/api/runs', { goal: 'quick' });
    const runId = created.json.run.id;
    // Wait for it to finish.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (factory.runner.getRun(runId)!.status === 'completed') break;
    }

    const stopped = await call<{ status: string; note: string }>('POST', `/api/runs/${runId}/stop`, {});
    expect(stopped.status).toBe(409);
    expect(stopped.json.status).toBe('not_running');
    expect(stopped.json.note).toMatch(/nothing to stop/i);
  });

  it('404s for an unknown run', async () => {
    const { call } = await boot(new FakeLLMProvider({ script: [{ type: 'text', content: 'x' }] }));
    const res = await call('POST', '/api/runs/does-not-exist/stop', {});
    expect(res.status).toBe(404);
  });

  it('records why the run ended in the event log', async () => {
    const { factory, call } = await boot(slowProvider());
    const created = await call<{ run: { id: string } }>('POST', '/api/runs', { goal: 'slow' });
    const runId = created.json.run.id;
    await new Promise((r) => setTimeout(r, 250));
    await call('POST', `/api/runs/${runId}/stop`, {});
    await new Promise((r) => setTimeout(r, 600));

    const events = factory.runner.getEvents(runId);
    const note = events.find(
      (e) => e.type === 'status_changed' && (e.payload as { note?: string }).note === 'stop requested',
    );
    expect(note, 'no stop-requested event recorded').toBeDefined();
  });
});

describe('stop is protected like every other mutation', () => {
  it('rejects a request with no bearer token', async () => {
    const { factory, base } = await boot(slowProvider());
    const created = factory.runner.createRun({
      factoryId: 'stop-test',
      goal: 'slow',
      tier: 'B',
      poolId: factory.poolId,
      systemPrompt: '',
    });
    const url = base;
    const res = await fetch(`${url}/api/runs/${created.id}/stop`, {
      method: 'POST',
      headers: { origin: url, 'content-type': 'application/json' },
      body: '{}',
    });
    // 401, not 202: an unauthenticated caller cannot cancel work.
    expect(res.status).toBe(401);
  });

  it('rejects a mutation from a foreign Origin', async () => {
    const { factory, base } = await boot(slowProvider());
    const created = factory.runner.createRun({
      factoryId: 'stop-test',
      goal: 'slow',
      tier: 'B',
      poolId: factory.poolId,
      systemPrompt: '',
    });
    const url = base;
    const res = await fetch(`${url}/api/runs/${created.id}/stop`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN.value}`,
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });
});




