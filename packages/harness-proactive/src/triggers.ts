import { createHmac, timingSafeEqual } from 'node:crypto';
import { statSync, existsSync, readFileSync } from 'node:fs';
import type { Hono } from 'hono';
import type { Env } from '@mf/core';
import { StateStore, type ProactiveHarness, type TriggerKind } from './index.js';

/**
 * Minimal cron expression support (5 fields: m h dom mon dow).
 *
 * Deliberately small rather than a dependency: the factory needs "run this job
 * on a schedule", and a 60-line evaluator with tests is easier to audit than a
 * library whose edge cases we would not read.
 */
export function parseCron(expr: string): { minutes: Set<number>; hours: Set<number>; doms: Set<number>; months: Set<number>; dows: Set<number> } {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron needs 5 fields, got ${fields.length}: '${expr}'`);
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  return {
    minutes: expand(m, 0, 59),
    hours: expand(h, 0, 23),
    doms: expand(dom, 1, 31),
    months: expand(mon, 1, 12),
    dows: expand(dow, 0, 6),
  };
}

function expand(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const stepMatch = /^(.+)\/(\d+)$/.exec(part);
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    const range = stepMatch ? stepMatch[1]! : part;
    let lo = min;
    let hi = max;
    if (range !== '*') {
      if (range.includes('-')) {
        const [a, b] = range.split('-');
        lo = Number(a);
        hi = Number(b);
      } else {
        lo = Number(range);
        hi = range === '*' ? max : Number(range);
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max) {
      throw new Error(`invalid cron field '${field}' (bounds ${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** True when `date` matches the expression (minute resolution). */
export function cronMatches(expr: string, date: Date): boolean {
  const c = parseCron(expr);
  return (
    c.minutes.has(date.getMinutes()) &&
    c.hours.has(date.getHours()) &&
    c.doms.has(date.getDate()) &&
    c.months.has(date.getMonth() + 1) &&
    c.dows.has(date.getDay())
  );
}

/**
 * Fires cron triggers once per matching minute.
 *
 * Not a tick-per-minute loop over a growing set: each trigger stores the
 * minute it last fired, so a slow job cannot cause a double fire and a restart
 * cannot replay a minute.
 */
export class CronScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly state: StateStore;
  private stopped = false;

  constructor(
    private readonly proactive: ProactiveHarness,
    private readonly db: import('@mf/core').Db,
    private readonly factoryId: string,
    private readonly onFire: (triggerId: string, jobId: string) => Promise<void>,
  ) {
    this.state = new StateStore(db, `${factoryId}:cron`);
  }

  start(intervalMs = 30_000): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      // A tick must not touch the database after shutdown: a closed sqlite
      // handle is a native assertion on Windows, not a catchable error.
      if (this.stopped) return;
      void this.tick().catch(() => {});
    }, intervalMs);
    if (!this.stopped) void this.tick().catch(() => {});
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<Array<{ triggerId: string; jobId: string }>> {
    if (this.stopped) return [];
    const fired: Array<{ triggerId: string; jobId: string }> = [];
    const minuteKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

    for (const trigger of this.proactive.listTriggers()) {
      if (trigger.kind !== 'cron' || !trigger.enabled) continue;
      const expr = trigger.config['cron'];
      if (typeof expr !== 'string') continue;
      let matches: boolean;
      try {
        matches = cronMatches(expr, now);
      } catch {
        continue; // an invalid expression must not break the scheduler
      }
      if (!matches) continue;

      const last = this.state.get<string>(trigger.id);
      if (last === minuteKey) continue; // already fired this minute
      this.state.set(trigger.id, minuteKey);

      const jobId = trigger.config['jobId'];
      if (typeof jobId !== 'string') continue;
      this.db
        .prepare(`UPDATE triggers_and_jobs SET last_fire_at = ?, updated_at = ? WHERE id = ?`)
        .run(now.getTime(), Date.now(), trigger.id);
      await this.onFire(trigger.id, jobId);
      fired.push({ triggerId: trigger.id, jobId });
    }
    return fired;
  }
}

/**
 * Authenticated webhook endpoint.
 *
 * Authentication is an HMAC of the raw body with the trigger's secret, sent in
 * `x-mf-signature`. A shared bearer token would be replayable; an HMAC binds
 * the signature to the payload.
 */
export function registerWebhookRoute(
  app: Hono<Env>,
  args: {
    proactive: ProactiveHarness;
    onFire: (triggerId: string, jobId: string, event: unknown) => Promise<void>;
  },
): void {
  app.post('/api/triggers/webhook/:id', async (c) => {
    const id = c.req.param('id');
    const trigger = args.proactive.listTriggers().find((t) => t.id === id);
    if (!trigger || trigger.kind !== 'webhook' || !trigger.enabled) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'No such webhook trigger' } }, 404);
    }
    const secret = trigger.secret;
    if (!secret) {
      return c.json({ error: { code: 'MISCONFIGURED', message: 'Trigger has no secret' } }, 500);
    }

    const raw = await c.req.text();
    const provided = c.req.header('x-mf-signature') ?? '';
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return c.json({ error: { code: 'BAD_SIGNATURE', message: 'Invalid signature' } }, 401);
    }

    const jobId = trigger.config['jobId'];
    if (typeof jobId !== 'string') {
      return c.json({ error: { code: 'MISCONFIGURED', message: 'Trigger has no jobId' } }, 500);
    }

    let payload: unknown = raw;
    try {
      payload = JSON.parse(raw);
    } catch {
      /* keep the raw string */
    }

    void args.onFire(trigger.id, jobId, payload);
    return c.json({ accepted: true, triggerId: trigger.id, jobId }, 202);
  });
}

/**
 * Shared body for the polling watchers.
 *
 * A tick can be in flight when stop() is called. Rather than rely on the timer
 * never firing again, every tick checks `stopped` before touching the database:
 * a tick that lands after shutdown would otherwise hit a closed better-sqlite3
 * handle, which is a native assertion (not a catchable JS error) on Windows.
 */
abstract class PollingWatcher {
  protected readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  protected stopped = false;
  /** Ticks currently executing; teardown waits or gives up on them. */
  private inFlight = 0;

  protected runSafely(fn: () => void): void {
    if (this.stopped) return;
    this.inFlight += 1;
    try {
      fn();
    } catch {
      /* transient FS/db errors must never kill the process */
    } finally {
      this.inFlight -= 1;
    }
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    void this.inFlight;
  }
}
/**
 * Polls files for changes. Uses stat polling rather than fs.watch because
 * fs.watch is unreliable on network drives and on Windows for editors that
 * write-to-rename (the common case).
 */
export class FileWatcher extends PollingWatcher {
  constructor(
    private readonly proactive: ProactiveHarness,
    private readonly db: import('@mf/core').Db,
    private readonly factoryId: string,
    private readonly onFire: (triggerId: string, jobId: string, event: unknown) => Promise<void>,
  ) {
    super();
  }

  /** Idempotent: calling start() again only adds watchers for new triggers. */
  start(intervalMs = 15_000): void {
    if (this.stopped) return;
    for (const trigger of this.proactive.listTriggers()) {
      if (trigger.kind !== 'file_watcher' || !trigger.enabled) continue;
      const path = trigger.config['path'];
      const jobId = trigger.config['jobId'];
      if (typeof path !== 'string' || typeof jobId !== 'string') continue;
      if (this.timers.has(trigger.id)) continue;

      const state = new StateStore(this.db, `${this.factoryId}:watcher:${trigger.id}`);
      const timer = setInterval(() => {
        this.runSafely(() => {
          if (this.stopped) return;
          if (!existsSync(path)) return;
          const mtime = statSync(path).mtimeMs;
          const last = state.get<number>('mtime') ?? 0;
          if (mtime <= last) return;
          state.set('mtime', mtime);
          void this.onFire(trigger.id, jobId, { path, mtime });
        });
      }, intervalMs);
      this.timers.set(trigger.id, timer);
    }
  }
}

/**
 * Tails a log file and fires the job with newly appended lines.
 * Keeps a byte offset per trigger so lines are delivered exactly once.
 */
export class LogTailer extends PollingWatcher {
  constructor(
    private readonly proactive: ProactiveHarness,
    private readonly db: import('@mf/core').Db,
    private readonly factoryId: string,
    private readonly onFire: (triggerId: string, jobId: string, event: unknown) => Promise<void>,
  ) {
    super();
  }

  start(intervalMs = 10_000): void {
    if (this.stopped) return;
    for (const trigger of this.proactive.listTriggers()) {
      if (trigger.kind !== 'log_event' || !trigger.enabled) continue;
      const path = trigger.config['path'];
      const jobId = trigger.config['jobId'];
      const pattern = typeof trigger.config['pattern'] === 'string' ? trigger.config['pattern'] : null;
      if (typeof path !== 'string' || typeof jobId !== 'string') continue;
      if (this.timers.has(trigger.id)) continue;

      const state = new StateStore(this.db, `${this.factoryId}:logtail:${trigger.id}`);

      // Baseline captured NOW, synchronously. If the baseline were only set on
      // the first tick, anything appended between start() and that tick would
      // be either swallowed or replayed. Neither is acceptable.
      if (state.get<number>('offset') === null) {
        try {
          if (existsSync(path)) state.set('offset', readFileSync(path).length);
        } catch {
          /* file may not exist yet; the first tick will baseline it */
        }
      }

      const timer = setInterval(() => {
        this.runSafely(() => {
          if (this.stopped) return;
          if (!existsSync(path)) return;
          const buf = readFileSync(path); // bytes, so offsets match fs sizes
          const size = buf.length;
          const stored = state.get<number>('offset');
          if (stored === null) {
            state.set('offset', size);
            return;
          }
          if (size < stored) {
            state.set('offset', size); // file was truncated: resync
            return;
          }
          if (size === stored) return;
          const chunk = buf.subarray(stored).toString('utf8');
          state.set('offset', size);
          const lines = chunk.split('\n').filter((l) => l.trim().length > 0);
          const matching = pattern ? lines.filter((l) => l.includes(pattern)) : lines;
          if (matching.length === 0) return;
          void this.onFire(trigger.id, jobId, { path, lines: matching, count: matching.length });
        });
      }, intervalMs);
      this.timers.set(trigger.id, timer);
    }
  }
}

/** Stops every watcher created by this module. */
export function stopAllWatchers(watchers: Array<{ stop(): void }>): void {
  for (const w of watchers) w.stop();
}

export type { TriggerKind };

