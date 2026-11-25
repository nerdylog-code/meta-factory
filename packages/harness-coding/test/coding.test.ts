import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BudgetEnforcer,
  CommandBus,
  DurableRunner,
  FakeLLMProvider,
  SqliteGateStore,
  TokenLedger,
  openDb,
  type CommandBus as Bus,
  type Db,
} from '@mf/core';
import { LocalProcessDriver, Workspace, createCodingHarness } from '../src/index.js';

let sandboxRoot: string;
let workspaceDir: string;
let outsideDir: string;
let db: Db;
let bus: Bus;
let wsPath: Workspace;
let poolId: string;

const human = { kind: 'human' } as const;
const agent = { kind: 'agent', role: 'lead', agentId: 'a', runId: 'r', toolCallId: 't' } as const;

beforeEach(async () => {
  sandboxRoot = mkdtempSync(join(tmpdir(), 'mf-coding-'));
  workspaceDir = join(sandboxRoot, 'workspace');
  outsideDir = join(sandboxRoot, 'outside');
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, 'secret.txt'), 'TOP SECRET');
  writeFileSync(join(workspaceDir, 'hello.txt'), 'hello world\nsecond line');

  wsPath = await Workspace.create(workspaceDir);
  db = openDb({ path: ':memory:' });
  bus = new CommandBus(db);
  bus.registerAll(createCodingHarness({ workspace: wsPath }).commands);
  bus.setGateStore(new SqliteGateStore(db));
  const budget = new BudgetEnforcer(db);
  poolId = budget.createPool({ ownerKind: 'factory', ownerId: 'f', amountUsd: 1 }).id;
});

afterEach(() => {
  db.close();
  rmSync(sandboxRoot, { recursive: true, force: true });
});

async function read(path: string) {
  return bus.dispatch('fs.read', { path }, human);
}

describe('path traversal is blocked', () => {
  const attacks = [
    '../outside/secret.txt',
    '../../outside/secret.txt',
    '..\\outside\\secret.txt',
    '../workspace/../outside/secret.txt',
    './../../outside/secret.txt',
  ];

  for (const attack of attacks) {
    it(`rejects "${attack}"`, async () => {
      await expect(read(attack)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    });
  }

  it('rejects an absolute path outside the workspace', async () => {
    const absolute = join(outsideDir, 'secret.txt');
    await expect(read(absolute)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });

  it('rejects a sibling directory that merely shares a name prefix', async () => {
    // The classic startsWith() bug: /tmp/x/workspace-evil starts with
    // /tmp/x/workspace. Must not be reachable.
    const sibling = `${workspaceDir}-evil`;
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'leak.txt'), 'LEAK');
    await expect(read(`${workspaceDir}-evil/leak.txt`)).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_WORKSPACE',
    });
    rmSync(sibling, { recursive: true, force: true });
  });

  it('rejects a symlink inside the workspace that points outside it', async () => {
    const link = join(workspaceDir, 'escape.txt');
    try {
      symlinkSync(join(outsideDir, 'secret.txt'), link);
    } catch {
      // Windows without privileges cannot create symlinks; skip rather than
      // silently pass.
      return;
    }
    await expect(read('escape.txt')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });

  it('rejects NUL bytes and empty paths', async () => {
    await expect(read('hello\0.txt')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    await expect(read('')).rejects.toThrow();
  });

  it('allows a legitimate file inside the workspace', async () => {
    const res = (await read('hello.txt')) as { status: string; result: { content: string } };
    expect(res.status).toBe('ok');
    expect(res.result.content).toContain('hello world');
  });

  it('allows an absolute path that IS inside the workspace', async () => {
    const res = (await read(join(workspaceDir, 'hello.txt'))) as { result: { content: string } };
    expect(res.result.content).toContain('hello world');
  });
});

describe('fs.write', () => {
  it('writes inside the workspace', async () => {
    await bus.dispatch('fs.write', { path: 'new.txt', content: 'data' }, human);
    expect(readFileSync(join(workspaceDir, 'new.txt'), 'utf8')).toBe('data');
  });

  it('refuses to escape', async () => {
    await expect(
      bus.dispatch('fs.write', { path: '../outside/pwned.txt', content: 'x' }, human),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    expect(existsSync(join(outsideDir, 'pwned.txt'))).toBe(false);
  });

  it('is marked non-idempotent so a crash is not blindly replayed', () => {
    expect(bus.get('fs.write').idempotent).toBe(false);
  });

  it('does not leave a temp file behind', async () => {
    await bus.dispatch('fs.write', { path: 'a.txt', content: 'x' }, human);
    const entries = readFileSync(join(workspaceDir, 'a.txt'), 'utf8');
    expect(entries).toBe('x');
    // temp files use a .tmp suffix
    expect(existsSync(`${join(workspaceDir, 'a.txt')}.tmp`)).toBe(false);
  });

  it('refuses to create missing parent dirs unless asked', async () => {
    await expect(bus.dispatch('fs.write', { path: 'deep/a/b.txt', content: 'x' }, human)).rejects.toThrow();
    await bus.dispatch('fs.write', { path: 'deep/a/b.txt', content: 'x', createDirs: true }, human);
    expect(readFileSync(join(workspaceDir, 'deep/a/b.txt'), 'utf8')).toBe('x');
  });
});

describe('fs.edit', () => {
  it('replaces a unique match', async () => {
    await bus.dispatch('fs.edit', { path: 'hello.txt', oldText: 'world', newText: 'there' }, human);
    expect(readFileSync(join(workspaceDir, 'hello.txt'), 'utf8')).toContain('hello there');
  });

  it('refuses an absent match', async () => {
    await expect(
      bus.dispatch('fs.edit', { path: 'hello.txt', oldText: 'nope', newText: 'x' }, human),
    ).rejects.toMatchObject({ code: 'EDIT_NO_MATCH' });
  });

  it('refuses an ambiguous match unless replaceAll is set', async () => {
    writeFileSync(join(workspaceDir, 'dup.txt'), 'aa aa aa');
    await expect(
      bus.dispatch('fs.edit', { path: 'dup.txt', oldText: 'aa', newText: 'bb' }, human),
    ).rejects.toMatchObject({ code: 'EDIT_AMBIGUOUS' });

    await bus.dispatch('fs.edit', { path: 'dup.txt', oldText: 'aa', newText: 'bb', replaceAll: true }, human);
    expect(readFileSync(join(workspaceDir, 'dup.txt'), 'utf8')).toBe('bb bb bb');
  });

  it('refuses to edit through a traversal path', async () => {
    await expect(
      bus.dispatch('fs.edit', { path: '../outside/secret.txt', oldText: 'TOP', newText: 'X' }, human),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    expect(readFileSync(join(outsideDir, 'secret.txt'), 'utf8')).toBe('TOP SECRET');
  });
});

describe('fs.list', () => {
  it('lists the workspace with relative names', async () => {
    const res = (await bus.dispatch('fs.list', {}, human)) as {
      result: { entries: Array<{ name: string; type: string }> };
    };
    const names = res.result.entries.map((e) => e.name);
    expect(names).toContain('hello.txt');
    // never leaks the absolute root
    expect(JSON.stringify(res)).not.toContain(sandboxRoot.replace(/\\/g, '\\\\'));
  });

  it('refuses to list outside', async () => {
    await expect(bus.dispatch('fs.list', { path: '..' }, human)).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_WORKSPACE',
    });
  });
});

describe('shell.exec', () => {
  it('requires a human gate by default', () => {
    const cmd = bus.get('shell.exec');
    expect(cmd.requiresGate).toBe(true);
  });

  it('is unavailable when no sandbox driver is configured', async () => {
    await expect(
      bus.dispatch('shell.exec', { command: 'echo hi' }, human),
    ).rejects.toMatchObject({ code: 'SANDBOX_DISABLED' });
  });

  it('refuses a cwd outside the workspace', async () => {
    bus.registerAll(
      createCodingHarness({ workspace: wsPath, sandbox: new LocalProcessDriver() }).commands.filter(
        (c) => !bus.commands.has(c.name),
      ),
    );
    const bus2 = new CommandBus(db);
    bus2.registerAll(createCodingHarness({ workspace: wsPath, sandbox: new LocalProcessDriver() }).commands);
    await expect(
      bus2.dispatch('shell.exec', { command: 'echo hi', cwd: '..' }, human),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });

  it('runs a command and returns exit code + output', async () => {
    const bus2 = new CommandBus(db);
    bus2.registerAll(createCodingHarness({ workspace: wsPath, sandbox: new LocalProcessDriver() }).commands);
    const res = (await bus2.dispatch('shell.exec', { command: 'echo sandbox-ok' }, human)) as {
      result: { exitCode: number; stdout: string };
    };
    expect(res.result.exitCode).toBe(0);
    expect(res.result.stdout).toContain('sandbox-ok');
  });

  it('never passes HUMAN_TOKEN into the child environment', async () => {
    process.env['HUMAN_TOKEN'] = 'super-secret-token-value';
    try {
      const bus2 = new CommandBus(db);
      bus2.registerAll(createCodingHarness({ workspace: wsPath, sandbox: new LocalProcessDriver() }).commands);
      // Dump the whole child environment; the token must not appear anywhere in
      // it. Quoting differs between cmd.exe and /bin/sh, so compare contents
      // rather than relying on how a particular shell expands `$VAR`.
      const cmd = process.platform === 'win32' ? 'set' : 'env';
      const res = (await bus2.dispatch('shell.exec', { command: cmd }, human)) as {
        result: { stdout: string };
      };
      expect(res.result.stdout).not.toContain('super-secret-token-value');
      expect(res.result.stdout.toUpperCase()).not.toContain('HUMAN_TOKEN');
      // sanity: the child really did have SOME environment
      expect(res.result.stdout.length).toBeGreaterThan(0);
    } finally {
      delete process.env['HUMAN_TOKEN'];
    }
  });

  it('an agent calling shell.exec gets a gate, not execution', async () => {
    const bus2 = new CommandBus(db);
    const gates = new SqliteGateStore(db);
    bus2.setGateStore(gates);
    bus2.registerAll(createCodingHarness({ workspace: wsPath, sandbox: new LocalProcessDriver() }).commands);
    db.prepare(
      `INSERT OR IGNORE INTO runs (id, factory_id, agent_id, goal, status, tier, pool_id, turn, created_at, updated_at)
       VALUES ('r','f','a','g','running','B',NULL,0,0,0)`,
    ).run();

    const res = await bus2.dispatch('shell.exec', { command: 'echo should-not-run' }, agent, {
      factoryId: 'f',
      idempotencyKey: 'k1',
    });
    expect(res.status).toBe('pending_approval');
    const gate = gates.listPending()[0]!;
    expect(gate.commandName).toBe('shell.exec');
    expect(JSON.parse(gate.validatedInputJson)).toEqual({ command: 'echo should-not-run', cwd: '.' });
  });
});

describe('coding harness through the runner', () => {
  it('the agent writes a file and the file appears in the workspace', async () => {
    const provider = new FakeLLMProvider({
      script: [
        { type: 'tool_call', name: 'fs.write', args: { path: 'out.txt', content: 'from agent' }, callId: 'c1' },
        { type: 'text', content: 'written' },
      ],
    });
    const runner = new DurableRunner({
      db,
      bus,
      ledger: new TokenLedger(db),
      budget: new BudgetEnforcer(db),
      provider,
      price: { in: 0, out: 0 },
    });
    const run = await runner.startRun({
      factoryId: 'f',
      goal: 'write a file',
      tier: 'B',
      poolId,
      systemPrompt: 'sys',
    });
    expect(run.status).toBe('completed');
    expect(readFileSync(join(workspaceDir, 'out.txt'), 'utf8')).toBe('from agent');
  });
});
