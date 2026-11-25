import { afterEach, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FactoryConfigSchema, FakeLLMProvider, createApp, z, type Factory } from '@mf/core';
import { bootstrapFactory } from '@mf/core';
import { HumanToken } from '@mf/core';
import { registerRunRoutes, composeSystemPrompt } from '../src/run-routes.js';

/**
 * Approval must ADVANCE the run, not merely close the gate.
 *
 * Found by driving the live UI over CDP: clicking Approve removed the gate card
 * while the run stayed `paused_gate` forever. Unit tests missed it because they
 * asserted the gate's lifecycle and never the run's, and because the resume path
 * lives in the app layer (`POST /api/runs` + `/api/gates/:id/approve`), which
 * only this suite exercises together.
 */

const TOKEN = new HumanToken('d'.repeat(64));
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

const gateTool = {
  name: 'notes.delete',
  description: 'delete a note',
  inputSchema: z.object({ id: z.string() }),
  allowedActors: ['human', 'lead'] as const,
  idempotent: true,
  requiresGate: true,
  execute: (i: { id: string }) => ({ deleted: i.id }),
};

async function boot(script: Parameters<typeof FakeLLMProvider>[0]['script']) {
  const port = await freePort();
  const config = FactoryConfigSchema.parse({
    name: 'gate-resume',
    title: 'Gate Resume',
    port,
    pageStagePort: port + 1,
    harnesses: [],
    agents: [{ id: 'lead', role: 'lead', name: 'Lead', prompt: 'Be brief.' }],
  });

  const factory: Factory = bootstrapFactory({
    factoryId: config.name,
    dbPath: ':memory:',
    port,
    provider: new FakeLLMProvider({ script }),
    humanToken: TOKEN,
    harnesses: [],
    uiOrigin: 'http://127.0.0.1:' + port,
  });
  factory.bus.register(gateTool as never);

  const bundle = createApp({
    db: factory.db,
    bus: factory.bus,
    runner: factory.runner,
    ledger: factory.ledger,
    ledgerQueries: factory.ledgerQueries,
    port,
    uiOrigin: 'http://127.0.0.1:' + port,
    harnesses: [],
    factoryId: config.name,
    humanToken: TOKEN,
    // The same prompt the run started with must be used on resume.
    promptForResume: {
      forRun: () =>
        composeSystemPrompt(
          config,
          [],
          factory.bus.listToolsForActor('lead').map((t) => t.name),
          'Be brief.',
        ),
    },
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
  const headers = {
    authorization: `Bearer ${TOKEN.value}`,
    origin: base,
    'content-type': 'application/json',
  };
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(base + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }
  return { factory, call };
}

async function waitForGateId(call: <T>(m: string, p: string, b?: unknown) => Promise<T>) {
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const res = await call<{ gates: Array<{ id: string }> }>('GET', '/api/gates');
    if (res.gates.length > 0) return res.gates[0]!.id;
  }
  return undefined;
}

describe('approving a gate advances the run', () => {
  it('the run leaves paused_gate and the response reports resumed', async () => {
    const { factory, call } = await boot([
      { type: 'tool_call', name: 'notes.delete', args: { id: 'n1' }, callId: 'tc-del' },
      { type: 'text', content: 'deleted, done' },
    ]);

    const created = await call<{ run: { id: string } }>('POST', '/api/runs', { goal: 'delete n1' });
    const runId = created.run.id;

    const gateId = await waitForGateId(call);
    expect(gateId, 'run never opened a gate').toBeTruthy();
    expect(factory.runner.getRun(runId)!.status).toBe('paused_gate');

    const approved = await call<{ status: string; resumed: boolean; result: { deleted: string } }>(
      'POST',
      `/api/gates/${gateId}/approve`,
      {},
    );
    expect(approved.status).toBe('approved');
    // The command ran with exactly the stored input.
    expect(approved.result).toEqual({ deleted: 'n1' });

    let status = factory.runner.getRun(runId)!.status;
    for (let i = 0; i < 60 && status === 'paused_gate'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = factory.runner.getRun(runId)!.status;
    }
    expect(status, 'run stayed paused_gate after approval').not.toBe('paused_gate');
    expect(approved.resumed).toBe(true);

    // And the resumed run really continued: a second turn was recorded.
    const events = factory.runner.getEvents(runId);
    expect(events.filter((e) => e.type === 'turn_started').length).toBeGreaterThanOrEqual(2);
  });

  it('never leaves a run paused with zero pending gates (the stuck state)', async () => {
    const { factory, call } = await boot([
      { type: 'tool_call', name: 'notes.delete', args: { id: 'n1' }, callId: 'tc-1' },
      { type: 'tool_call', name: 'notes.delete', args: { id: 'n2' }, callId: 'tc-2' },
      { type: 'text', content: 'done' },
    ]);

    const created = await call<{ run: { id: string } }>('POST', '/api/runs', { goal: 'delete two' });
    const runId = created.run.id;
    const gateId = await waitForGateId(call);
    expect(gateId).toBeTruthy();

    await call('POST', `/api/gates/${gateId}/approve`, {});
    await new Promise((r) => setTimeout(r, 900));

    const status = factory.runner.getRun(runId)!.status;
    const gates = await call<{ gates: Array<{ id: string }> }>('GET', '/api/gates');
    if (status === 'paused_gate') {
      expect(gates.gates.length, 'paused_gate with no pending gate: stuck run').toBeGreaterThan(0);
    }
  });

  it('rejecting does not resume the run', async () => {
    const { factory, call } = await boot([
      { type: 'tool_call', name: 'notes.delete', args: { id: 'n1' }, callId: 'tc-rej' },
      { type: 'text', content: 'done' },
    ]);
    const created = await call<{ run: { id: string } }>('POST', '/api/runs', { goal: 'delete n1' });
    const gateId = await waitForGateId(call);
    expect(gateId).toBeTruthy();

    await call('POST', `/api/gates/${gateId}/reject`, { reason: 'no' });
    await new Promise((r) => setTimeout(r, 600));

    // Rejection must NOT execute the command nor resume the loop.
    expect(factory.runner.getRun(created.run.id)!.status).toBe('paused_gate');
  });
});


