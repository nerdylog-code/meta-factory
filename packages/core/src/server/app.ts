import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { CommandBus } from '../bus/command-bus.js';
import { FactoryError } from '../errors.js';
import type { DurableRunner, RunPromptProvider } from '../runner/durable-runner.js';
import type { TokenLedger } from '../budget/ledger.js';
import type { LedgerQueries } from '../budget/ledger-queries.js';
import { type Actor, type HarnessModule, type ResolvedActorKind } from '../types.js';
import { EventBroker } from './sse.js';
import { HumanToken, bearerAuth, hostGuard, originGuard, securityHeaders } from './security.js';

export interface AppDeps {
  /** Composes the system prompt used when a run resumes after approval. */
  promptForResume?: RunPromptProvider;
  db: Db;
  bus: CommandBus;
  runner: DurableRunner;
  ledger: TokenLedger;
  /** Drizzle-backed reads for the UI (see `budget/ledger-queries.ts`). */
  ledgerQueries: LedgerQueries;
  port: number;
  humanToken?: HumanToken;
  /** UI origin exactly as the browser will send it. */
  uiOrigin?: string;
  harnesses?: HarnessModule[];
  factoryId?: string;
  /** Read-model extensions registered by harnesses (pages, chat, mailbox...). */
  readModels?: ReadModelExtension[];
  /** Extra routes (isolated PageStage server lives elsewhere, not here). */
  extraRoutes?: (app: Hono<Env>) => void;
}

export interface ReadModelExtension {
  path: string;
  handler: (ctx: { db: Db; bus: CommandBus; factoryId: string; query: (k: string) => string | undefined }) => unknown;
}

export interface Env {
  Variables: {
    actor: Actor;
  };
}

export interface AppBundle {
  app: Hono<Env>;
  broker: EventBroker;
  token: HumanToken;
  url: string;
}

/**
 * Builds the local HTTP app.
 *
 * Middleware order matters and is deliberate:
 *   hostGuard -> securityHeaders -> originGuard -> bearerAuth
 * so a DNS-rebound request is refused before it can reach any handler, and an
 * unauthenticated request is refused before it can touch SQLite.
 */
export function createApp(deps: AppDeps): AppBundle {
  const token = deps.humanToken ?? new HumanToken();
  const broker = new EventBroker();
  const uiOrigin = deps.uiOrigin ?? `http://127.0.0.1:${deps.port}`;
  const factoryId = deps.factoryId ?? 'sandbox';

  const app = new Hono<Env>();

  app.use('*', hostGuard({ port: deps.port }));
  app.use('*', securityHeaders());

  // The SSE stream and API are all under /api; static UI is served separately.
  app.use('/api/*', originGuard({ allowedOrigins: [uiOrigin] }));
  app.use('/api/*', bearerAuth(token));
  app.use('/api/*', async (c, next) => {
    // The ONLY place a human actor is manufactured. It never comes from input.
    c.set('actor', { kind: 'human' } satisfies Actor);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof FactoryError) {
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            ...(err instanceof Error && 'issues' in err ? { issues: (err as { issues: unknown }).issues } : {}),
          },
        },
        err.httpStatus as 400,
      );
    }
    // Never leak a stack trace to the client; log server-side only.
    console.error('[unhandled]', err);
    return c.json({ error: { code: 'INTERNAL', message: 'Internal server error' } }, 500);
  });

  // ------------------------------------------------------------- health
  app.get('/api/health', (c) => c.json({ ok: true, factoryId, ts: Date.now() }));

  // -------------------------------------------------------- read models
  app.get('/api/commands', (c) => c.json({ commands: deps.bus.listCommandMeta() }));
  app.get('/api/tools', (c) => {
    const role = (c.req.query('role') ?? 'human') as ResolvedActorKind;
    return c.json({ tools: deps.bus.listToolsForActor(role) });
  });

  app.get('/api/runs', (c) => c.json({ runs: deps.runner.listRuns(Number(c.req.query('limit') ?? 50)) }));

  app.get('/api/runs/:id', (c) => {
    const run = deps.runner.getRun(c.req.param('id'));
    if (!run) return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, 404);
    return c.json({
      run,
      events: deps.runner.getEvents(run.id, Number(c.req.query('after') ?? 0)),
    });
  });

  app.get('/api/gates', (c) => c.json({ gates: deps.runner.listPendingGates() }));

  app.get('/api/tokenomics', (c) => {
    const runId = c.req.query('runId');
    // Reads go through the Drizzle query layer; the ledger still WRITES with raw
    // SQL inside runner transactions. A test asserts both views agree, which is
    // what makes a mixed-driver schema safe.
    return c.json({ tokenomics: deps.ledgerQueries.summary(runId ? { runId } : {}) });
  });

  for (const ext of deps.readModels ?? []) {
    app.get(ext.path, (c) =>
      c.json(
        ext.handler({
          db: deps.db,
          bus: deps.bus,
          factoryId,
          query: (k) => c.req.query(k),
        }) as Record<string, unknown>,
      ),
    );
  }

  // --------------------------------------------------------------- SSE
  app.get('/api/events', (c) => {
    let clientId: string | null = null;
    let hb: ReturnType<typeof setInterval> | null = null;
    // One teardown, many callers. The previous version could call
    // controller.close() from three places (abort listener, cancel(), and the
    // broker's close callback) on a connection that was already dying, which
    // trips libuv/node asserts on Windows.
    let tornDown = false;
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

    const teardown = () => {
      if (tornDown) return;
      tornDown = true;
      if (hb) {
        clearInterval(hb);
        hb = null;
      }
      if (clientId) {
        broker.removeClient(clientId);
        clientId = null;
      }
      const ctrl = controllerRef;
      controllerRef = null;
      if (!ctrl) return;
      try {
        ctrl.close();
      } catch {
        /* already closed by the runtime */
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        const enc = new TextEncoder();
        const write = (chunk: string) => {
          if (tornDown) return;
          controller.enqueue(enc.encode(chunk));
        };
        clientId = broker.addClient({
          write,
          close: teardown,
          // Last resort on shutdown: aborting the request signal makes the
          // runtime end the response even if the consumer is gone.
          destroy: teardown,
        });
        write(`event: ready\ndata: ${JSON.stringify({ clientId, ts: Date.now() })}\n\n`);

        hb = setInterval(() => {
          try {
            write(formatHeartbeat());
          } catch {
            teardown();
          }
        }, 15_000);

        c.req.raw.signal.addEventListener('abort', teardown, { once: true });
      },
      cancel() {
        // The consumer went away: stop writing, but do not close a controller
        // the runtime is already tearing down.
        if (tornDown) return;
        tornDown = true;
        if (hb) {
          clearInterval(hb);
          hb = null;
        }
        if (clientId) {
          broker.removeClient(clientId);
          clientId = null;
        }
        controllerRef = null;
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  });

  // --------------------------------------------------------- mutations
  /**
   * Single command endpoint: POST /api/commands/:name
   * Body is the command input. The actor is ALWAYS `human` here — the value in
   * the body is ignored because only `c.get('actor')` is passed on.
   */
  app.post('/api/commands/:name', async (c) => {
    const name = c.req.param('name');
    let body: unknown = {};
    const text = await c.req.text();
    if (text.trim().length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        return c.json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON' } }, 400);
      }
    }
    const actor = c.get('actor');
    const res = await deps.bus.dispatch(name, stripActor(body), actor, { factoryId });
    return c.json(res, res.status === 'pending_approval' ? 202 : 200);
  });

  const GateActionSchema = z.object({ reason: z.string().max(2000).optional() });

  app.post('/api/gates/:id/approve', async (c) => {
    const { gate, result } = await deps.runner.approveGate(c.req.param('id'));
    broker.broadcast({ kind: 'gate', payload: { ...gate, status: 'approved', result } });

    // Approving must ADVANCE the run, not just close the ticket. Found by driving
    // the live UI: the gate disappeared while the run sat in paused_gate forever.
    // Resuming is fire-and-forget so the HTTP response is not held hostage to a
    // slow model turn, and a resume failure is reported rather than swallowed.
    let resumed = false;
    if (gate.runId) {
      try {
        const run = await deps.runner.resumeIfPaused(gate.runId, deps.promptForResume);
        resumed = run !== null && run.status !== 'paused_gate' && run.status !== 'paused_human';
      } catch (err) {
        console.warn('[gate] approved but could not resume run:', (err as Error).message);
      }
    }

    return c.json({
      status: 'approved',
      gateId: gate.id,
      commandName: gate.commandName,
      result,
      resumed,
    });
  });

  app.post('/api/gates/:id/reject', async (c) => {
    const raw = await c.req.text();
    const parsed = GateActionSchema.safeParse(raw.trim() ? JSON.parse(raw) : {});
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_FAILED', message: 'Invalid body', issues: parsed.error.issues } }, 400);
    }
    const gate = await deps.runner.rejectGate(c.req.param('id'), parsed.data.reason);
    broker.broadcast({ kind: 'gate', payload: { ...gate, status: 'rejected' } });
    return c.json({ status: 'rejected', gateId: gate.id, commandName: gate.commandName });
  });

  app.post('/api/runs/:id/stop', async (c) => {
    const id = c.req.param('id');
    const res = deps.runner.stopRun(id, 'stopped from the UI');
    if (res.status === 'not_found') {
      return c.json({ error: { code: 'NOT_FOUND', message: `Run ${id} not found` } }, 404);
    }
    if (res.status === 'not_running') {
      // Honest answer: nothing to cancel. Do not pretend the stop worked.
      return c.json(
        {
          status: 'not_running',
          run: res.run,
          spentUsd: res.spentUsd,
          note: 'This run is not executing, so there is nothing to stop.',
        },
        409,
      );
    }
    // No extra broadcast needed: stopRun appends a real event, and the runner's
    // subscriber fans it out to SSE.
    return c.json({ status: 'stopped', run: res.run, spentUsd: res.spentUsd }, 202);
  });

  app.get('/api/harnesses', (c) =>
    c.json({
      harnesses: (deps.harnesses ?? []).map((h) => ({
        id: h.id,
        name: h.name,
        commands: h.commands.map((cmd) => cmd.name),
      })),
    }),
  );

  deps.extraRoutes?.(app);

  // Wire run events into SSE.
  deps.runner.subscribe((ev) => {
    broker.broadcast({ kind: 'run_event', event: ev });
    if (ev.type === 'gate_opened') {
      broker.broadcast({ kind: 'gate', payload: { id: (ev.payload as { gateId: string }).gateId, status: 'pending' } });
    }
    if (ev.type === 'llm_responded' || ev.type === 'run_completed' || ev.type === 'tool_result') {
      broker.broadcast({ kind: 'tokenomics', payload: { ts: Date.now() } });
    }
  });

  const url = `http://127.0.0.1:${deps.port}/#token=${token.value}`;
  return { app, broker, token, url };
}

function formatHeartbeat(): string {
  return `event: heartbeat\ndata: ${JSON.stringify({ kind: 'heartbeat', ts: Date.now() })}\n\n`;
}

/**
 * Defence in depth: even if a client sends `{ actor: { kind: 'human' } }`, it is
 * removed before dispatch. The bus signature already makes payload identity
 * impossible to use, but stripping means it cannot end up in validated input
 * and be persisted into a gate either.
 */
function stripActor(body: unknown): unknown {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const { actor: _dropped, ...rest } = body as Record<string, unknown>;
    return rest;
  }
  return body;
}





