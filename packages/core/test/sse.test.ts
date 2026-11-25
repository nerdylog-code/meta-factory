import { afterEach, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { bootstrapFactory, type Factory } from '../src/factory.js';
import { FakeLLMProvider } from '../src/llm/fake.js';
import { HumanToken } from '../src/server/security.js';

const TOKEN = new HumanToken('b'.repeat(64));
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

async function start(): Promise<{ factory: Factory; port: number; base: string }> {
  const port = await freePort();
  const factory = bootstrapFactory({
    factoryId: 'sse-test',
    dbPath: ':memory:',
    port,
    provider: new FakeLLMProvider({ script: [{ type: 'text', content: 'ok' }] }),
    humanToken: TOKEN,
    harnesses: [],
  });
  const server = serve({ fetch: factory.app.fetch, port, hostname: '127.0.0.1' });
  await new Promise<void>((r) => server.once('listening', () => r()));
  open.push(async () => {
    // End SSE streams first: an open stream keeps the socket alive and makes
    // server.close() wait forever.
    factory.bundle.broker.closeAll();
    await new Promise<void>((r) => {
      const timer = setTimeout(() => {
        // Never let a wedged connection hang the suite.
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        r();
      }, 2000);
      server.close(() => {
        clearTimeout(timer);
        r();
      });
    });
    factory.close();
  });
  return { factory, port, base: `http://127.0.0.1:${port}` };
}

const auth = { authorization: `Bearer ${TOKEN.value}` };

/** Sends a raw request and returns the status line. */
function rawStatus(port: number, host: string, path: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      const extra = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('');
      sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`);
    });
    let data = '';
    sock.on('data', (d) => (data += d.toString()));
    sock.on('end', () => resolve(data.split('\r\n')[0] ?? ''));
    sock.on('error', reject);
  });
}

describe('SSE stream lifecycle', () => {
  it('delivers a ready frame and stays open', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/events`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('event: ready');
    await reader.cancel();
  });

  it('a client that vanishes does not take the server down', async () => {
    const { base, port } = await start();

    // Open the stream with a raw socket and destroy it abruptly, which is what
    // an abandoned browser tab or a killed script looks like from the server.
    await new Promise<void>((resolve) => {
      const sock = connect(port, '127.0.0.1', () => {
        sock.write(
          `GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${TOKEN.value}\r\n\r\n`,
        );
        setTimeout(() => {
          sock.destroy();
          resolve();
        }, 150);
      });
      sock.on('error', () => resolve());
    });

    // Give the server a moment to observe the abort.
    await new Promise((r) => setTimeout(r, 300));

    // The server must still serve ordinary requests.
    const health = await fetch(`${base}/api/health`, { headers: auth });
    expect(health.status).toBe(200);
  });

  it('many concurrent connects and disconnects leave the server healthy', async () => {
    const { base } = await start();
    for (let i = 0; i < 8; i++) {
      const res = await fetch(`${base}/api/events`, { headers: auth });
      const reader = res.body!.getReader();
      await reader.read();
      if (i % 2 === 0) await reader.cancel();
      else await reader.releaseLock();
    }
    await new Promise((r) => setTimeout(r, 200));
    const health = await fetch(`${base}/api/health`, { headers: auth });
    expect(health.status).toBe(200);
  });

  it('broadcasts run events to a connected client', async () => {
    const { base, factory } = await start();
    const res = await fetch(`${base}/api/events`, { headers: auth });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();

    // drain the ready frame
    await reader.read();

    const run = factory.runner.createRun({
      factoryId: 'sse-test',
      goal: 'g',
      tier: 'B',
      poolId: factory.poolId,
      systemPrompt: '',
    });
    factory.runner.appendEvents(run.id, [{ type: 'turn_started', payload: { turn: 1 } }]);

    const { value } = await reader.read();
    expect(dec.decode(value)).toContain('event: run_event');
    await reader.cancel();
  });
});

describe('Host guard still applies to SSE', () => {
  it('refuses a rebound Host on the stream endpoint', async () => {
    const { port } = await start();
    const status = await rawStatus(port, `evil.example:${port}`, '/api/events', {
      Authorization: `Bearer ${TOKEN.value}`,
    });
    expect(status).toContain('403');
  });
});
