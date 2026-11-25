import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandBus, SqliteGateStore, openDb, type Db } from '@mf/core';
import { MetaFactory, createMetaFactoryHarness } from '../src/index.js';

let root: string;
let db: Db;
let bus: CommandBus;

const human = { kind: 'human' } as const;

/** Stands in for a real workspace: packages/core/tsconfig.build.json must exist. */
function seedWorkspace(): void {
  mkdirSync(join(root, 'factories'), { recursive: true });
  mkdirSync(join(root, 'packages', 'core'), { recursive: true });
  writeFileSync(join(root, 'packages', 'core', 'tsconfig.build.json'), '{\n  "extends": "../../tsconfig.base.json"\n}\n');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mf-meta-'));
  seedWorkspace();
  db = openDb({ path: ':memory:' });
  bus = new CommandBus(db);
  bus.setGateStore(new SqliteGateStore(db));
  bus.registerAll(createMetaFactoryHarness({ root }).commands);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(root, { recursive: true, force: true });
});

describe('factory.spinUp', () => {
  it('creates a thin factory: config, package.json, state.db, workspace, README', async () => {
    const res = (await bus.dispatch(
      'factory.spinUp',
      { name: 'reports', title: 'Reports Factory', harnesses: ['notes', 'coding'] },
      human,
    )) as { result: { manifest: { port: number }; files: string[] } };

    const dir = join(root, 'factories', 'reports');
    expect(existsSync(join(dir, 'factory.config.ts'))).toBe(true);
    expect(existsSync(join(dir, 'package.json'))).toBe(true);
    expect(existsSync(join(dir, 'state.db'))).toBe(true);
    expect(existsSync(join(dir, 'workspace'))).toBe(true);
    expect(existsSync(join(dir, 'README.md'))).toBe(true);
    expect(res.result.manifest.port).toBeGreaterThanOrEqual(4970);
  });

  it('the generated config is valid and uses the requested settings', () => {
    const meta = new MetaFactory(root);
    meta.spinUp({ name: 'alpha', title: 'Alpha', description: 'd', harnesses: ['notes'], tier: 'A', budgetUsd: 3 });
    const cfg = readFileSync(join(root, 'factories', 'alpha', 'factory.config.ts'), 'utf8');
    expect(cfg).toContain("name: 'alpha'");
    expect(cfg).toContain('title: "Alpha"');
    expect(cfg).toContain("tier: 'A'");
    expect(cfg).toContain('budgetUsd: 3');
    expect(cfg).toContain('pageStagePort');
  });

  it('allocates distinct port pairs for each factory', async () => {
    const a = (await bus.dispatch('factory.spinUp', { name: 'aa', title: 'A', harnesses: ['notes'] }, human)) as {
      result: { manifest: { port: number; pageStagePort: number } };
    };
    const b = (await bus.dispatch('factory.spinUp', { name: 'bb', title: 'B', harnesses: ['notes'] }, human)) as {
      result: { manifest: { port: number; pageStagePort: number } };
    };
    expect(a.result.manifest.port).not.toBe(b.result.manifest.port);
    expect(a.result.manifest.pageStagePort).toBe(a.result.manifest.port + 1);
    // PageStage must never collide with any shell port.
    expect(a.result.manifest.pageStagePort).not.toBe(b.result.manifest.port);
    expect(b.result.manifest.pageStagePort).not.toBe(a.result.manifest.port);
  });

  it('refuses to overwrite an existing factory', async () => {
    await bus.dispatch('factory.spinUp', { name: 'dup', title: 'D', harnesses: ['notes'] }, human);
    await expect(
      bus.dispatch('factory.spinUp', { name: 'dup', title: 'D2', harnesses: ['notes'] }, human),
    ).rejects.toMatchObject({ code: 'FACTORY_EXISTS' });
    // The original config is untouched.
    expect(readFileSync(join(root, 'factories', 'dup', 'factory.config.ts'), 'utf8')).toContain('title: "D"');
  });

  it('rejects an invalid factory name at the schema boundary', async () => {
    await expect(
      bus.dispatch('factory.spinUp', { name: 'Bad Name!', title: 'X', harnesses: ['notes'] }, human),
    ).rejects.toThrow(/Invalid input/);
  });

  it('requires at least one harness', async () => {
    await expect(
      bus.dispatch('factory.spinUp', { name: 'noh', title: 'X', harnesses: [] }, human),
    ).rejects.toThrow(/Invalid input/);
  });

  it('lists factories it created', async () => {
    await bus.dispatch('factory.spinUp', { name: 'one', title: 'One', harnesses: ['notes'] }, human);
    await bus.dispatch('factory.spinUp', { name: 'two', title: 'Two', harnesses: ['notes'] }, human);
    const res = (await bus.dispatch('meta.listFactories', {}, human)) as {
      result: { factories: Array<{ name: string; title: string }> };
    };
    expect(res.result.factories.map((f) => f.name)).toEqual(['one', 'two']);
    expect(res.result.factories.find((f) => f.name === 'two')!.title).toBe('Two');
  });

  it('a spun-up factory is not a copy of the engine', async () => {
    await bus.dispatch('factory.spinUp', { name: 'thin', title: 'Thin', harnesses: ['notes'] }, human);
    const pkg = JSON.parse(readFileSync(join(root, 'factories', 'thin', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    // It depends on core; it does not vendor it.
    expect(pkg.dependencies['@mf/core']).toBe('workspace:*');
    expect(existsSync(join(root, 'factories', 'thin', 'src'))).toBe(false);
  });

  it('is non-idempotent (a crash must not silently re-run it)', () => {
    expect(bus.get('factory.spinUp').idempotent).toBe(false);
    expect(bus.get('factory.spinUp').requiresGate).toBeFalsy();
  });
});

describe('module.promote', () => {
  const setupModule = () => {
    const factoryDir = join(root, 'factories', 'src-factory');
    mkdirSync(join(factoryDir, 'harness'), { recursive: true });
    writeFileSync(join(factoryDir, 'factory.config.ts'), "import { defineFactory } from '@mf/core';\nexport default {};\n");
    writeFileSync(
      join(factoryDir, 'harness', 'index.ts'),
      'export function createReportingHarness() { return { id: "reporting" }; }\n',
    );
    return factoryDir;
  };

  it('promotes a module into a versioned package with a changelog', async () => {
    setupModule();
    const res = (await bus.dispatch(
      'module.promote',
      {
        factory: 'src-factory',
        module: 'harness',
        packageName: 'reporting',
        changelog: 'Reporting harness validated in three runs before promotion.',
      },
      human,
    )) as { result: { version: string; files: string[] } };

    const pkgDir = join(root, 'packages', 'harness-reporting');
    expect(existsSync(join(pkgDir, 'src', 'index.ts'))).toBe(true);
    expect(existsSync(join(pkgDir, 'CHANGELOG', '0.1.0.md'))).toBe(true);
    expect(res.result.version).toBe('0.1.0');

    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      mf: { promotedFrom: string };
    };
    expect(pkg.name).toBe('@mf/harness-reporting');
    expect(pkg.mf.promotedFrom).toBe('src-factory/harness');

    const changelog = readFileSync(join(pkgDir, 'CHANGELOG', '0.1.0.md'), 'utf8');
    expect(changelog).toContain('src-factory/harness');
    expect(changelog).toContain('validated in three runs');
  });

  it('requires a human gate for an agent', async () => {
    setupModule();
    db.prepare(
      `INSERT OR IGNORE INTO runs (id, factory_id, agent_id, goal, status, tier, pool_id, turn, created_at, updated_at)
       VALUES ('r','m','a','g','running','B',NULL,0,0,0)`,
    ).run();
    const res = await bus.dispatch(
      'module.promote',
      { factory: 'src-factory', module: 'harness', packageName: 'reporting', changelog: 'long enough text' },
      { kind: 'agent', role: 'lead', agentId: 'a', runId: 'r', toolCallId: 't' },
      { factoryId: 'm', idempotencyKey: 'p1' },
    );
    expect(res.status).toBe('pending_approval');
    // Nothing was created before approval.
    expect(existsSync(join(root, 'packages', 'harness-reporting'))).toBe(false);
  });

  it('refuses to reuse an existing version', async () => {
    setupModule();
    await bus.dispatch(
      'module.promote',
      { factory: 'src-factory', module: 'harness', packageName: 'reporting', changelog: 'first promotion here' },
      human,
    );
    await expect(
      bus.dispatch(
        'module.promote',
        { factory: 'src-factory', module: 'harness', packageName: 'reporting', changelog: 'second promotion here' },
        human,
      ),
    ).rejects.toMatchObject({ code: 'VERSION_EXISTS' });
  });

  it('a new version is allowed and gets its own changelog', async () => {
    setupModule();
    await bus.dispatch(
      'module.promote',
      { factory: 'src-factory', module: 'harness', packageName: 'reporting', changelog: 'first promotion here' },
      human,
    );
    await bus.dispatch(
      'module.promote',
      {
        factory: 'src-factory',
        module: 'harness',
        packageName: 'reporting',
        changelog: 'second promotion here',
        version: '0.2.0',
      },
      human,
    );
    expect(existsSync(join(root, 'packages', 'harness-reporting', 'CHANGELOG', '0.1.0.md'))).toBe(true);
    expect(existsSync(join(root, 'packages', 'harness-reporting', 'CHANGELOG', '0.2.0.md'))).toBe(true);
  });

  it('refuses a module path that escapes its factory', async () => {
    setupModule();
    await expect(
      bus.dispatch(
        'module.promote',
        { factory: 'src-factory', module: '../../packages/core', packageName: 'stolen', changelog: 'bad path attempt' },
        human,
      ),
    ).rejects.toMatchObject({ code: 'MODULE_OUTSIDE_FACTORY' });
    expect(existsSync(join(root, 'packages', 'harness-stolen'))).toBe(false);
  });

  it('404s for a factory that does not exist', async () => {
    await expect(
      bus.dispatch(
        'module.promote',
        { factory: 'ghost', module: 'x', packageName: 'yy', changelog: 'irrelevant but long enough' },
        human,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('404s for a module that does not exist', async () => {
    setupModule();
    await expect(
      bus.dispatch(
        'module.promote',
        { factory: 'src-factory', module: 'nope', packageName: 'xx', changelog: 'irrelevant but long enough' },
        human,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rewrites the factory config to consume the promoted package', async () => {
    const factoryDir = setupModule();
    await bus.dispatch(
      'module.promote',
      { factory: 'src-factory', module: 'harness', packageName: 'reporting', changelog: 'promote for backport' },
      human,
    );
    const cfg = readFileSync(join(factoryDir, 'factory.config.ts'), 'utf8');
    expect(cfg).toContain("from '@mf/harness-reporting'");
  });

  it('the capability metadata is honest', () => {
    expect(bus.get('module.promote').requiresGate).toBe(true);
    expect(bus.get('module.promote').idempotent).toBe(false);
  });
});


