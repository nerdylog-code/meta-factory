import { afterEach, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { bootstrapFactory, type Factory } from '../src/factory.js';
import { FakeLLMProvider } from '../src/llm/fake.js';
import { HumanToken } from '../src/server/security.js';
import type { CommandDefinition } from '../src/types.js';

const TOKEN = new HumanToken('a'.repeat(64));

interface Harness {
  factory: Factory;
  port: number;
  server: ReturnType<typeof serve>;
  close(): Promise<void>;
}

const openServers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (openServers.length > 0) await openServers.pop()!.close();
});

/** Grabs a free port so the app's hostGuard can be built with the real one. */
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

function noteCommands() {
  const noteCreate: CommandDefinition<z.ZodObject<{ body: z.ZodString }>> = {
    name: 'notes.create',
    description: 'Create a note',
    inputSchema: z.object({ body: z.string() }),
    allowedActors: ['human', 'lead'],
    idempotent: false,
    execute: (i) => ({ created: i.body }),
  };
  return noteCreate;
}

async function start(): Promise<Harness> {
  const port = await freePort();

  const factory = bootstrapFactory({
    factoryId: 'test',
    dbPath: ':memory:',
    port,
    provider: new FakeLLMProvider({ script: [{ type: 'text', content: 'ok' }] }),
    humanToken: TOKEN,
    harnesses: [],
  });
  factory.bus.register(noteCommands());

  const server = serve({ fetch: factory.app.fetch, port, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));

  const h: Harness = {
    factory,
    port,
    server,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      factory.close();
    },
  };
  openServers.push(h);
  return h;
}

const url = (h: Harness, path: string) => `http://127.0.0.1:${h.port}${path}`;
const auth = { authorization: `Bearer ${TOKEN.value}` };
const origin = (h: Harness) => ({ origin: `http://127.0.0.1:${h.port}` });

/**
 * Sends a raw request with a forged Host header. `fetch`/undici refuses to let
 * you set Host, so we use a raw socket — which is exactly what a DNS-rebound
 * browser produces.
 */
function rawRequest(port: number, hostHeader: string, path = '/api/health'): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nAuthorization: Bearer ${TOKEN.value}\r\nConnection: close\r\n\r\n`,
      );
    });
    let data = '';
    sock.on('data', (d) => (data += d.toString()));
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
}

describe('anti-DNS-rebinding', () => {
  it('rejects a request whose Host is not 127.0.0.1:port or localhost:port (403)', async () => {
    const h = await start();
    const res = await rawRequest(h.port, `evil.example:${h.port}`);
    expect(res).toMatch(/^HTTP\/1\.1 403/);
    expect(res).toContain('BAD_HOST');
  });

  it('rejects a correct host name on the WRONG port', async () => {
    const h = await start();
    const res = await rawRequest(h.port, '127.0.0.1:1');
    expect(res).toMatch(/^HTTP\/1\.1 403/);
  });

  it('accepts 127.0.0.1:port', async () => {
    const h = await start();
    const res = await rawRequest(h.port, `127.0.0.1:${h.port}`);
    expect(res).toMatch(/^HTTP\/1\.1 200/);
  });

  it('accepts localhost:port', async () => {
    const h = await start();
    const res = await rawRequest(h.port, `localhost:${h.port}`);
    expect(res).toMatch(/^HTTP\/1\.1 200/);
  });
});

describe('authentication', () => {
  it('rejects a request with no Bearer token (401)', async () => {
    const h = await start();
    const res = await fetch(url(h, '/api/health'));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a wrong token (401)', async () => {
    const h = await start();
    const res = await fetch(url(h, '/api/health'), { headers: { authorization: 'Bearer wrong' } });
    expect(res.status).toBe(401);
  });

  it('rejects a token supplied in the query string, even a valid one', async () => {
    const h = await start();
    const res = await fetch(url(h, `/api/health?token=${TOKEN.value}`));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('TOKEN_IN_QUERY');
  });

  it('never exposes the token through a read model', async () => {
    const h = await start();
    const res = await fetch(url(h, '/api/commands'), { headers: auth });
    const text = await res.text();
    expect(text).not.toContain(TOKEN.value);
  });

  it('the bundle URL carries the token in the fragment, not the path', async () => {
    const h = await start();
    expect(h.factory.bundle.url).toMatch(/#token=[0-9a-f]+$/);
    expect(h.factory.bundle.url.split('#')[0]).not.toContain(TOKEN.value);
  });
});

describe('origin enforcement on mutations', () => {
  it('accepts a mutation from the UI origin', async () => {
    const h = await start();
    const res = await fetch(url(h, '/api/commands/notes.create'), {
      method: 'POST',
      headers: { ...auth, ...origin(h), 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'hello' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', result: { created: 'hello' } });
  });

  it('rejects a mutation from a foreign Origin (403)', async () => {
    const h = await start();
    const res = await fetch(url(h, '/api/commands/notes.create'), {
      method: 'POST',
      headers: { ...auth, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'hello' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('BAD_ORIGIN');
  });

  it('rejects a mutation with no Origin at all', async () => {
    const h = await start();
    const res = await fetch(url(h, '/api/commands/notes.create'), {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'hello' }),
    });
    expect(res.status).toBe(403);
  });

  it('does not reflect an unknown origin in CORS headers', async () => {
    const h = await start();
    const res = await fetch(url(h, '/api/health'), { headers: { ...auth, origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('actor identity cannot be spoofed from the payload', () => {
  it('ignores an actor field in the body and uses the server-resolved human', async () => {
    const h = await start();
    const calls: string[] = [];
    const whoAmI: CommandDefinition<z.ZodObject<Record<string, never>>> = {
      name: 'debug.whoami',
      description: 'returns the resolved actor kind',
      inputSchema: z.object({}),
      allowedActors: ['human'], // agents must NOT be able to call this
      idempotent: true,
      execute: (_i, actor) => {
        calls.push(actor.kind);
        return { kind: actor.kind };
      },
    };
    h.factory.bus.register(whoAmI);

    const res = await fetch(url(h, '/api/commands/debug.whoami'), {
      method: 'POST',
      headers: { ...auth, ...origin(h), 'content-type': 'application/json' },
      // attacker-supplied identity in the payload
      body: JSON.stringify({ actor: { kind: 'agent', role: 'lead', agentId: 'x', runId: 'y', toolCallId: 'z' } }),
    });
    expect(res.status).toBe(200);
    // Server-resolved, not payload-controlled.
    expect(await res.json()).toEqual({ status: 'ok', result: { kind: 'human' } });
    expect(calls).toEqual(['human']);
  });
});
