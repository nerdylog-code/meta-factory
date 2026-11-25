import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandBus, ForbiddenError, openDb, type Db } from '@mf/core';
import { CoreFourSchema, SettingsStore, THEMES, createSettingsHarness } from '../src/index.js';

let dir: string;
let db: Db;
let bus: CommandBus;
let store: SettingsStore;

const human = { kind: 'human' } as const;
const lead = { kind: 'agent', role: 'lead', agentId: 'l', runId: 'r', toolCallId: 't' } as const;
const specialist = { kind: 'agent', role: 'specialist', agentId: 's', runId: 'r', toolCallId: 't' } as const;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mf-settings-'));
  db = openDb({ path: join(dir, 'state.db') });
  bus = new CommandBus(db);
  const harness = createSettingsHarness({ db, factoryId: 'f1' });
  store = harness.store;
  bus.registerAll(harness.commands);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Core Four defaults', () => {
  it('returns a complete Core Four even with nothing stored', () => {
    const cf = store.coreFour();
    expect(cf.model.tier).toBe('S');
    expect(cf.context.windowMessages).toBeGreaterThan(0);
    expect(cf.tools.disabled).toEqual([]);
    expect(cf.prompt.persona).toBe('');
  });

  it('parsing an empty object yields every inner default (regression: Zod4 default() vs prefault())', () => {
    // In Zod 4, `.default({})` returns the literal {} WITHOUT applying inner
    // field defaults, so CoreFourSchema.parse({}).model was {} and
    // model.tier was undefined. `.prefault({})` runs the value through the
    // schema and does apply them. This test pins the correct behaviour.
    const parsed = CoreFourSchema.parse({});
    expect(parsed.model).toEqual({ tier: 'S', thinking: 'off', temperature: 0.2, maxOutputTokens: 4096 });
    expect(parsed.context.windowMessages).toBe(20);
    expect(parsed.tools.summarizeEvery).toBe(3);
    expect(parsed.prompt.extraInstructions).toBe('');
  });

  it('the four keys are exactly context/model/prompt/tools', () => {
    expect(Object.keys(store.coreFour()).sort()).toEqual(['context', 'model', 'prompt', 'tools']);
  });
});

describe('factory.settings', () => {
  it('reads when no patch is given', async () => {
    const res = (await bus.dispatch('factory.settings', {}, human)) as { result: { coreFour: unknown } };
    expect(res.result.coreFour).toBeDefined();
  });

  it('applies a partial patch and leaves other fields intact', async () => {
    await bus.dispatch('factory.settings', { patch: { model: { tier: 'D' } } }, human);
    const cf = store.coreFour();
    expect(cf.model.tier).toBe('D');
    // untouched fields keep their defaults
    expect(cf.model.temperature).toBe(0.2);
    expect(cf.context.windowMessages).toBe(20);
  });

  it('persists across a new store instance (survives restart)', async () => {
    await bus.dispatch('factory.settings', { patch: { prompt: { persona: 'terse engineer' } } }, human);
    const fresh = new SettingsStore(db, 'f1');
    expect(fresh.coreFour().prompt.persona).toBe('terse engineer');
  });

  it('rejects an invalid value instead of storing it', async () => {
    await expect(
      bus.dispatch('factory.settings', { patch: { model: { tier: 'Z' } } }, human),
    ).rejects.toThrow(/Invalid input/);
    expect(store.coreFour().model.tier).toBe('S');
  });

  it('a lead agent may change settings (it is reversible and scoped)', async () => {
    const res = await bus.dispatch('factory.settings', { patch: { tools: { summarizeEvery: 5 } } }, lead);
    expect(res.status).toBe('ok');
    expect(store.coreFour().tools.summarizeEvery).toBe(5);
  });

  it('a specialist may NOT change settings', async () => {
    await expect(
      bus.dispatch('factory.settings', { patch: { model: { tier: 'A' } } }, specialist),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('recovers from a corrupt stored row instead of crashing', () => {
    db.prepare(
      `INSERT INTO factory_settings (factory_id, key, value_json, updated_at) VALUES ('f1','coreFour','{"model":{"tier":123}',0)`,
    ).run();
    expect(() => store.coreFour()).not.toThrow();
    expect(store.coreFour().model.tier).toBe('S');
  });
});

describe('factory.ui', () => {
  it('reads and patches layout settings', async () => {
    const res = (await bus.dispatch('factory.ui', { patch: { density: 'compact', rightPaneWidth: 420 } }, human)) as {
      result: { ui: { density: string; rightPaneWidth: number } };
    };
    expect(res.result.ui.density).toBe('compact');
    expect(res.result.ui.rightPaneWidth).toBe(420);
  });

  it('clamps pane widths to a sane range', async () => {
    await expect(
      bus.dispatch('factory.ui', { patch: { leftPaneWidth: 5000 } }, human),
    ).rejects.toThrow(/Invalid input/);
  });
});

describe('factory.themes', () => {
  it('lists themes without changing the active one', async () => {
    const res = (await bus.dispatch('factory.themes', { list: true }, human)) as {
      result: { theme: string; themes: Array<{ id: string }> };
    };
    expect(res.result.theme).toBe('midnight');
    expect(res.result.themes.map((t) => t.id).sort()).toEqual(Object.keys(THEMES).sort());
  });

  it('sets a known theme', async () => {
    const res = (await bus.dispatch('factory.themes', { name: 'terminal' }, human)) as { result: { theme: string } };
    expect(res.result.theme).toBe('terminal');
    expect(store.theme()).toBe('terminal');
  });

  it('refuses an unknown theme at the schema boundary', async () => {
    await expect(bus.dispatch('factory.themes', { name: 'neon-puke' }, human)).rejects.toThrow(/Invalid input/);
  });

  it('every theme defines the same token keys (so the UI cannot break)', () => {
    const keys = Object.keys(THEMES.midnight).sort();
    for (const [name, theme] of Object.entries(THEMES)) {
      expect(Object.keys(theme).sort(), `theme ${name}`).toEqual(keys);
    }
  });
});

describe('snapshot read model', () => {
  it('returns core four, ui, current theme and the theme catalogue', () => {
    const snap = store.snapshot();
    expect(snap.coreFour).toBeDefined();
    expect(snap.ui).toBeDefined();
    expect(snap.theme).toBe('midnight');
    expect(snap.themes.length).toBeGreaterThanOrEqual(3);
    expect(CoreFourSchema.safeParse(snap.coreFour).success).toBe(true);
  });
});
