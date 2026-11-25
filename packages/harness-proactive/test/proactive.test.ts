import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  CommandBus,
  FakeLLMProvider,
  TokenLedger,
  openDb,
  type Db,
  type Env,
} from '@mf/core';
import {
  Classifier,
  CronScheduler,
  FileWatcher,
  LogTailer,  createProactiveHarness,
  cronMatches,
  parseCron,
  registerWebhookRoute,
  type ProactiveHarness,
} from '../src/index.js';

let db: Db;
let ledger: TokenLedger;
let provider: FakeLLMProvider;
let proactive: ProactiveHarness;
let wakes: Array<{ jobId: string; summary: string }>;
/** Watchers/schedulers created by a test; stopped before the db is closed. */
const cleanups: Array<{ stop(): void }> = [];

/**
 * Closes the db only after every timer is stopped.
 *
 * A live setInterval still touching better-sqlite3 when the worker exits trips
 * a native assertion inside the Statement destructor ("env != nullptr") and
 * kills the worker, which surfaces as a random "Worker exited unexpectedly".
 * Ordering here is the fix: timers first, then the database.
 */
function teardown(): void {
  while (cleanups.length > 0) {
    try {
      cleanups.pop()!.stop();
    } catch {
      /* ignore */
    }
  }
  // First call happens before `build()` has opened a database.
  if (db && (db as { open?: boolean }).open !== false) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Stops watchers and waits one turn of the event loop before the db is closed.
 *
 * Watchers fire `void onFire(...)` from a timer; an already-dispatched callback
 * can still be queued when stop() returns. Closing the database before that
 * callback runs is what produced the intermittent worker death.
 */
async function settleThenTeardown(): Promise<void> {
  while (cleanups.length > 0) {
    try {
      cleanups.pop()!.stop();
    } catch {
      /* ignore */
    }
  }
  await new Promise((r) => setTimeout(r, 50));
  if (db && (db as { open?: boolean }).open !== false) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

function watch<T extends { stop(): void }>(w: T): T {
  cleanups.push(w);
  return w;
}

function build(classifierScript: Array<{ type: 'text'; content: string }>) {
  teardown();
  db = openDb({ path: ':memory:' });
  ledger = new TokenLedger(db);
  provider = new FakeLLMProvider({
    script: classifierScript,
    tokensIn: 500,
    tokensOut: 20,
    providerName: 'mistral',
    model: 'ministral-3b-latest',
  });
  wakes = [];
  const classifier = new Classifier(db, { provider, ledger, price: { in: 0.04, out: 0.04 } });
  proactive = createProactiveHarness({
    db,
    factoryId: 'f1',
    classifier,
    onWake: ({ job, delta }) => {
      wakes.push({ jobId: job.id, summary: delta.summary });
    },
  });
  const bus = new CommandBus(db);
  bus.registerAll(proactive.commands);
  return bus;
}

beforeEach(() => {
  build([{ type: 'text', content: '{"decision":"wake","reason":"needs attention"}' }]);
});

afterEach(async () => {
  // Stop every timer BEFORE the db is closed (see `teardown` for why).
  await settleThenTeardown();
});

describe('code-first pipeline: $0 when there is no delta', () => {
  it('a job reporting no delta costs exactly zero and never calls a model', async () => {
    proactive.registerJob({
      id: 'quiet-job',
      name: 'Quiet',
      modulePath: 'jobs/quiet.ts',
      run: async () => ({ changed: false, summary: 'nothing changed' }),
    });

    const res = await proactive.fireJob('quiet-job');

    expect(res.stage).toBe('no_delta');
    expect(res.costUsd).toBe(0);
    expect(res.shouldWake).toBe(false);
    // THE economic guarantee: the model was never invoked.
    expect(provider.requests).toHaveLength(0);
    expect(ledger.summary().totalCostUsd).toBe(0);
    expect(wakes).toHaveLength(0);
  });

  it('the discard is still recorded for audit', async () => {
    proactive.registerJob({
      id: 'quiet-job',
      name: 'Quiet',
      modulePath: 'jobs/quiet.ts',
      run: async () => ({ changed: false, summary: 'nothing changed' }),
    });
    await proactive.fireJob('quiet-job');

    const logs = proactive.listClassifierLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.decision).toBe('discard');
    expect(logs[0]!.reason).toContain('nothing changed');
    expect(logs[0]!.costUsd).toBe(0);
    // model 'none' marks "no model was consulted", distinct from a cheap model.
    expect(logs[0]!.model).toBe('none');
  });

  it('a delta DOES invoke the classifier and records its cost', async () => {
    proactive.registerJob({
      id: 'noisy-job',
      name: 'Noisy',
      modulePath: 'jobs/noisy.ts',
      run: async () => ({ changed: true, summary: 'a build failed' }),
    });

    const res = await proactive.fireJob('noisy-job');
    expect(res.stage).toBe('woke');
    expect(res.costUsd).toBeGreaterThan(0);
    expect(res.shouldWake).toBe(true);
    expect(provider.requests).toHaveLength(1);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.summary).toBe('a build failed');
  });

  it('a delta the classifier discards wakes nobody but is logged', async () => {
    build([{ type: 'text', content: '{"decision":"discard","reason":"routine commit"}' }]);
    proactive.registerJob({
      id: 'routine-job',
      name: 'Routine',
      modulePath: 'jobs/r.ts',
      run: async () => ({ changed: true, summary: 'commit pushed' }),
    });

    const res = await proactive.fireJob('routine-job');
    expect(res.stage).toBe('discarded');
    expect(res.shouldWake).toBe(false);
    expect(wakes).toHaveLength(0);

    const logs = proactive.listClassifierLogs();
    expect(logs[0]!.decision).toBe('discard');
    expect(logs[0]!.costUsd).toBeGreaterThan(0); // the classifier did run
  });

  it('an unparseable classifier answer is an ERROR, not a silent discard', async () => {
    build([{ type: 'text', content: 'I think you should probably look at it?' }]);
    proactive.registerJob({
      id: 'j',
      name: 'J',
      modulePath: 'jobs/j.ts',
      run: async () => ({ changed: true, summary: 'something' }),
    });
    const res = await proactive.fireJob('j');
    expect(res.stage).toBe('error');
    expect(res.shouldWake).toBe(false);
    // A filter that fails closed hides exactly what it was meant to surface.
    const logs = proactive.listClassifierLogs();
    expect(logs[0]!.decision).toBe('error');
  });

  it('a crash in the job is an error with $0, never a wake', async () => {
    proactive.registerJob({
      id: 'broken',
      name: 'Broken',
      modulePath: 'jobs/broken.ts',
      run: async () => {
        throw new Error('boom');
      },
    });
    const res = await proactive.fireJob('broken');
    expect(res.stage).toBe('error');
    expect(res.costUsd).toBe(0);
    expect(provider.requests).toHaveLength(0);
    expect(proactive.listClassifierLogs()[0]!.reason).toContain('boom');
  });

  it('the classifier can parse JSON wrapped in prose or code fences', async () => {
    build([{ type: 'text', content: 'Sure:\n```json\n{"decision":"wake","reason":"x"}\n```\nthat is my answer' }]);
    proactive.registerJob({ id: 'j', name: 'J', modulePath: 'p', run: async () => ({ changed: true, summary: 's' }) });
    const res = await proactive.fireJob('j');
    expect(res.stage).toBe('woke');
  });

  it('jobs can persist state between runs', async () => {
    let runs = 0;
    proactive.registerJob({
      id: 'counter',
      name: 'Counter',
      modulePath: 'p',
      run: async (ctx) => {
        runs += 1;
        const seen = ctx.state.get<number>('seen') ?? 0;
        ctx.state.set('seen', seen + 1);
        return { changed: false, summary: `run ${runs}, seen ${seen}` };
      },
    });
    await proactive.fireJob('counter');
    await proactive.fireJob('counter');
    const logs = proactive.listClassifierLogs();
    expect(logs.some((l) => l.reason.includes('seen 1'))).toBe(true);
  });
});

describe('cron expressions', () => {
  it('matches every minute for * * * * *', () => {
    expect(cronMatches('* * * * *', new Date(2026, 0, 1, 10, 30))).toBe(true);
  });

  it('matches a specific minute and hour', () => {
    const expr = '15 3 * * *';
    expect(cronMatches(expr, new Date(2026, 0, 1, 3, 15))).toBe(true);
    expect(cronMatches(expr, new Date(2026, 0, 1, 3, 16))).toBe(false);
    expect(cronMatches(expr, new Date(2026, 0, 1, 4, 15))).toBe(false);
  });

  it('supports steps', () => {
    const c = parseCron('*/15 * * * *');
    expect([...c.minutes].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  it('supports ranges and lists', () => {
    const c = parseCron('0 9-17 * * 1-5');
    expect(c.hours.has(9)).toBe(true);
    expect(c.hours.has(17)).toBe(true);
    expect(c.hours.has(18)).toBe(false);
    expect(c.dows.has(1)).toBe(true);
    expect(c.dows.has(0)).toBe(false);
    expect([...parseCron('0,30 * * * *').minutes].sort((a, b) => a - b)).toEqual([0, 30]);
  });

  it('rejects malformed expressions loudly', () => {
    expect(() => parseCron('* * *')).toThrow(/needs 5 fields/);
    expect(() => parseCron('99 * * * *')).toThrow(/invalid cron field/);
  });
});

describe('CronScheduler', () => {
  it('fires a matching trigger once per minute, not twice', async () => {
    proactive.registerJob({ id: 'j', name: 'J', modulePath: 'p', run: async () => ({ changed: false, summary: '' }) });
    proactive.addTrigger({ kind: 'cron', name: 'every minute', config: { cron: '* * * * *', jobId: 'j' } });

    const fired: string[] = [];
    const sched = watch(
      new CronScheduler(proactive, db, 'f1', async (triggerId) => {
        fired.push(triggerId);
      }),
    );

    const at = new Date(2026, 0, 1, 10, 30, 5);
    await sched.tick(at);
    await sched.tick(at); // same minute
    expect(fired).toHaveLength(1);

    await sched.tick(new Date(2026, 0, 1, 10, 31, 5));
    expect(fired).toHaveLength(2);
    sched.stop();
  });

  it('ignores a non-matching minute', async () => {
    proactive.registerJob({ id: 'j', name: 'J', modulePath: 'p', run: async () => ({ changed: false, summary: '' }) });
    proactive.addTrigger({ kind: 'cron', name: 'daily', config: { cron: '0 3 * * *', jobId: 'j' } });
    const fired: string[] = [];
    const sched = watch(new CronScheduler(proactive, db, 'f1', async (t) => void fired.push(t)));
    await sched.tick(new Date(2026, 0, 1, 10, 30));
    expect(fired).toHaveLength(0);
    sched.stop();
  });

  it('an invalid cron expression does not break the scheduler', async () => {
    proactive.registerJob({ id: 'j', name: 'J', modulePath: 'p', run: async () => ({ changed: false, summary: '' }) });
    proactive.addTrigger({ kind: 'cron', name: 'bad', config: { cron: 'not a cron', jobId: 'j' } });
    proactive.addTrigger({ kind: 'cron', name: 'good', config: { cron: '* * * * *', jobId: 'j' } });
    const fired: string[] = [];
    const sched = watch(new CronScheduler(proactive, db, 'f1', async (t) => void fired.push(t)));
    await sched.tick(new Date(2026, 0, 1, 10, 30));
    expect(fired).toHaveLength(1);
    sched.stop();
  });
});

describe('webhook trigger', () => {
  let stage: Hono<Env>;

  beforeEach(() => {
    stage = new Hono<Env>();
    registerWebhookRoute(stage, {
      proactive,
      onFire: async (triggerId, jobId, event) => {
        wakes.push({ jobId, summary: JSON.stringify(event) });
        void triggerId;
      },
    });
  });

  const post = (id: string, body: string, sig?: string) =>
    stage.request(`/api/triggers/webhook/${id}`, {
      method: 'POST',
      body,
      headers: sig ? { 'x-mf-signature': sig } : {},
    });

  it('rejects an unsigned request (401)', async () => {
    const t = proactive.addTrigger({ kind: 'webhook', name: 'hook', config: { jobId: 'j' }, secret: 's'.repeat(32) });
    const res = await post(t.id, '{"build":"failed"}');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong signature (401)', async () => {
    const t = proactive.addTrigger({ kind: 'webhook', name: 'hook', config: { jobId: 'j' }, secret: 's'.repeat(32) });
    const res = await post(t.id, '{"x":1}', 'deadbeef');
    expect(res.status).toBe(401);
  });

  it('accepts a correctly signed payload (202) and fires the job', async () => {
    const secret = 'k'.repeat(32);
    const t = proactive.addTrigger({ kind: 'webhook', name: 'hook', config: { jobId: 'j' }, secret });
    const body = '{"build":"failed"}';
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    const res = await post(t.id, body, sig);
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(wakes).toHaveLength(1);
  });

  it('the signature is bound to the body: a valid sig for another body fails', async () => {
    const secret = 'k'.repeat(32);
    const t = proactive.addTrigger({ kind: 'webhook', name: 'hook', config: { jobId: 'j' }, secret });
    const sigForA = createHmac('sha256', secret).update('A').digest('hex');
    const res = await post(t.id, 'B', sigForA);
    expect(res.status).toBe(401);
  });

  it('404s for an unknown trigger', async () => {
    const res = await post('nope', '{}', 'x');
    expect(res.status).toBe(404);
  });

  it('refuses to create a webhook trigger without a secret', async () => {
    const bus = new CommandBus(db);
    bus.registerAll(proactive.commands);
    await expect(
      bus.dispatch('proactive.addTrigger', { kind: 'webhook', name: 'n', config: {} }, { kind: 'human' }),
    ).rejects.toMatchObject({ code: 'SECRET_REQUIRED' });
  });
});

describe('file watcher and log tailer', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('fires only when the watched file changes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mf-watch-'));
    const file = join(dir, 'data.txt');
    writeFileSync(file, 'v1');

    const fired: unknown[] = [];
    const w = watch(
      new FileWatcher(proactive, db, 'f1', async (_t, _j, event) => {
        fired.push(event);
      }),
    );
    proactive.addTrigger({ kind: 'file_watcher', name: 'w', config: { path: file, jobId: 'j' } });
    w.start(20);
    await new Promise((r) => setTimeout(r, 120));
    // The first poll records the current mtime (no "change" for existing state).
    const baseline = fired.length;
    writeFileSync(file, 'v2-changed');
    await new Promise((r) => setTimeout(r, 200));
    w.stop();
    expect(fired.length).toBeGreaterThan(baseline);
  });

  it('log tailer starts at EOF and delivers only new matching lines', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mf-tail-'));
    const file = join(dir, 'app.log');
    writeFileSync(file, 'old line ERROR should be ignored\n');

    const delivered: Array<{ lines: string[] }> = [];
    const tailer = watch(
      new LogTailer(proactive, db, 'f1', async (_t, _j, event) => {
        delivered.push(event as { lines: string[] });
      }),
    );
    proactive.addTrigger({ kind: 'log_event', name: 't', config: { path: file, jobId: 'j', pattern: 'ERROR' } });
    tailer.start(25);
    await new Promise((r) => setTimeout(r, 120));

    writeFileSync(file, 'old line ERROR should be ignored\nnew INFO ignored\nnew ERROR relevant\n');
    await new Promise((r) => setTimeout(r, 250));
    tailer.stop();

    expect(delivered.length).toBeGreaterThan(0);
    const all = delivered.flatMap((d) => d.lines);
    expect(all.some((l) => l.includes('relevant'))).toBe(true);
    expect(all.some((l) => l.includes('INFO'))).toBe(false);
  });
});

describe('proactive commands', () => {
  it('proactive.fire is non-idempotent and listed for lead', () => {
    const bus = new CommandBus(db);
    bus.registerAll(proactive.commands);
    expect(bus.get('proactive.fire').idempotent).toBe(false);
    expect(bus.listToolsForActor('lead').map((t) => t.name)).toContain('proactive.fire');
  });

  it('proactive.jobs lists registered jobs', async () => {
    const bus = new CommandBus(db);
    bus.registerAll(proactive.commands);
    proactive.registerJob({ id: 'job-a', name: 'A', modulePath: 'jobs/a.ts', run: async () => ({ changed: false, summary: '' }) });
    const res = (await bus.dispatch('proactive.jobs', {}, { kind: 'human' })) as {
      result: { jobs: Array<{ id: string; modulePath: string }> };
    };
    expect(res.result.jobs.find((j) => j.id === 'job-a')!.modulePath).toBe('jobs/a.ts');
  });

  it('firing an unknown job reports a clear error', async () => {
    await expect(proactive.fireJob('nope')).rejects.toThrow(/not registered/);
  });

  it('duplicate job ids are refused', () => {
    proactive.registerJob({ id: 'dup', name: 'D', modulePath: 'p', run: async () => ({ changed: false, summary: '' }) });
    expect(() =>
      proactive.registerJob({ id: 'dup', name: 'D2', modulePath: 'p2', run: async () => ({ changed: false, summary: '' }) }),
    ).toThrow(/already registered/);
  });
});




