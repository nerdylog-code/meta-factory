import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CommandBus } from '../src/bus/command-bus.js';
import { BudgetEnforcer } from '../src/budget/enforcer.js';
import { TokenLedger } from '../src/budget/ledger.js';
import { openDb } from '../src/db/client.js';
import { FakeLLMProvider } from '../src/llm/fake.js';
import { DurableRunner } from '../src/runner/durable-runner.js';
import type { CommandDefinition } from '../src/types.js';

interface Ctx {
  db: ReturnType<typeof openDb>;
  bus: CommandBus;
  ledger: TokenLedger;
  budget: BudgetEnforcer;
  runner: DurableRunner;
  poolId: string;
}

function setup(provider: FakeLLMProvider, extra: CommandDefinition[] = [], budgetUsd = 1): Ctx {
  const db = openDb({ path: ':memory:' });
  const bus = new CommandBus(db);
  const ledger = new TokenLedger(db);
  const budget = new BudgetEnforcer(db);
  bus.registerAll(extra);
  const runner = new DurableRunner({ db, bus, ledger, budget, provider, price: { in: 0.1, out: 0.1 } });
  const pool = budget.createPool({ ownerKind: 'run', ownerId: 'r', amountUsd: budgetUsd });
  return { db, bus, ledger, budget, runner, poolId: pool.id };
}

const startArgs = (poolId: string) => ({
  factoryId: 'sandbox',
  goal: 'do the thing',
  tier: 'B' as const,
  poolId,
  systemPrompt: 'You are a test agent.',
  maxTurns: 5,
});

describe('DurableRunner durability', () => {
  it('appends events with gap-free per-run seq numbers', async () => {
    const provider = new FakeLLMProvider({ script: [{ type: 'text', content: 'done' }] });
    const c = setup(provider);
    const run = await c.runner.startRun(startArgs(c.poolId));

    const events = c.runner.getEvents(run.id);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    expect(events.map((e) => e.type)).toContain('run_created');
    expect(events.map((e) => e.type)).toContain('llm_responded');
  });

  it('run status update and event append are in the same transaction', async () => {
    const provider = new FakeLLMProvider({ script: [{ type: 'text', content: 'ok' }] });
    const c = setup(provider);

    // Force a failure inside appendEvents AFTER the insert but before the
    // status update, and assert NOTHING was committed.
    const run = c.runner.createRun(startArgs(c.poolId));
    const before = c.runner.getEvents(run.id).length;

    vi_spy_bad_update(c);

    expect(() => c.runner.appendEvents(run.id, [{ type: 'turn_started' }], { status: 'running' })).toThrow();

    const after = c.runner.getEvents(run.id).length;
    expect(after).toBe(before); // the event rolled back with the status
    expect(c.runner.getRun(run.id)!.status).toBe('pending');
  });

  it('recovery re-executes an idempotent tool that was left dangling', async () => {
    let calls = 0;
    const readTool: CommandDefinition<z.ZodObject<{ path: z.ZodString }>> = {
      name: 'fs.read',
      description: 'read a file',
      inputSchema: z.object({ path: z.string() }),
      allowedActors: ['human', 'lead'],
      idempotent: true,
      execute: (i) => {
        calls += 1;
        return { content: `contents of ${i.path}` };
      },
    };

    // The model asks for the tool, then the process "dies": no second script
    // step exists, so the next model call would throw.
    const provider = new FakeLLMProvider({
      script: [{ type: 'tool_call', name: 'fs.read', args: { path: '/a.txt' }, callId: 'tc-read' }],
    });
    const c = setup(provider, [readTool]);
    const run = c.runner.createRun(startArgs(c.poolId));

    // Simulate a crash exactly after tool_call_started: append that event by
    // hand, skipping the execution.
    c.runner.appendEvents(run.id, [
      {
        type: 'tool_call_started',
        payload: { toolCallId: 'tc-read', name: 'fs.read', input: { path: '/a.txt' }, idempotent: true },
      },
    ]);

    const state = c.runner.recoverRun(run.id);
    expect(state.dangling).toHaveLength(1);

    const results = await c.runner.reconcileDanglingTools(run.id);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('ok');
    expect(calls).toBe(1);

    // Append-only: the replay is recorded, and the dangling call is resolved.
    const types = c.runner.getEvents(run.id).map((e) => e.type);
    expect(types).toContain('tool_call_replayed');
    expect(types).toContain('tool_result');
    expect(c.runner.recoverRun(run.id).dangling).toHaveLength(0);
  });

  it('recovery NEVER re-executes a non-idempotent tool and records unknown_after_crash', async () => {
    let calls = 0;
    const createTool: CommandDefinition<z.ZodObject<{ name: z.ZodString }>> = {
      name: 'notes.create',
      description: 'create a note',
      inputSchema: z.object({ name: z.string() }),
      allowedActors: ['human', 'lead'],
      idempotent: false,
      execute: (i) => {
        calls += 1;
        return { id: 'n1', name: i.name };
      },
    };
    const provider = new FakeLLMProvider({ script: [] });
    const c = setup(provider, [createTool]);
    const run = c.runner.createRun(startArgs(c.poolId));

    c.runner.appendEvents(run.id, [
      {
        type: 'tool_call_started',
        payload: { toolCallId: 'tc-create', name: 'notes.create', input: { name: 'x' }, idempotent: false },
      },
    ]);

    const results = await c.runner.reconcileDanglingTools(run.id);
    expect(calls).toBe(0);
    expect(results[0]!.status).toBe('unknown_after_crash');

    const ev = c.runner.getEvents(run.id).find((e) => e.type === 'tool_result')!;
    expect((ev.payload as { status: string }).status).toBe('unknown_after_crash');
    // The note text warns the model/human rather than pretending it succeeded.
    expect(JSON.stringify(ev.payload)).toMatch(/NOT re-run/);
  });

  it('a completed tool call is not treated as dangling', async () => {
    const provider = new FakeLLMProvider({ script: [{ type: 'text', content: 'hi' }] });
    const c = setup(provider);
    const run = c.runner.createRun(startArgs(c.poolId));
    c.runner.appendEvents(run.id, [
      { type: 'tool_call_started', payload: { toolCallId: 'x', name: 'notes.list', input: {}, idempotent: true } },
      { type: 'tool_result', payload: { toolCallId: 'x', name: 'notes.list', status: 'ok', result: {} } },
    ]);
    expect(c.runner.recoverRun(run.id).dangling).toHaveLength(0);
  });

  it('reports every non-terminal run as resumable after a restart', async () => {
    const provider = new FakeLLMProvider({ script: [{ type: 'text', content: 'x' }] });
    const c = setup(provider);
    const run = c.runner.createRun(startArgs(c.poolId));
    c.runner.appendEvents(run.id, [{ type: 'run_started' }], { status: 'running' });
    const resumable = c.runner.listResumable().map((r) => r.id);
    expect(resumable).toContain(run.id);
  });
});

describe('DurableRunner run identity', () => {
  it('startExisting does NOT create a second run for the same request', async () => {
    const provider = new FakeLLMProvider({ script: [{ type: 'text', content: 'done' }] });
    const c = setup(provider);

    const created = c.runner.createRun(startArgs(c.poolId));
    await c.runner.startExisting(created.id, startArgs(c.poolId));

    // Regression: startRun() creates a run internally, so calling it after
    // createRun() used to leave an orphaned duplicate and split the event log.
    const runs = c.db.prepare(`SELECT COUNT(*) c FROM runs`).get() as { c: number };
    expect(runs.c).toBe(1);
    expect(c.runner.getRun(created.id)!.status).toBe('completed');
  });

  it('startExisting refuses a run that already finished', async () => {
    const provider = new FakeLLMProvider({ script: [{ type: 'text', content: 'a' }] });
    const c = setup(provider);
    const run = await c.runner.startRun(startArgs(c.poolId));
    await expect(c.runner.startExisting(run.id, startArgs(c.poolId))).rejects.toThrow(/cannot be started/);
  });

  it('startExisting refuses an unknown run', async () => {
    const provider = new FakeLLMProvider({ script: [] });
    const c = setup(provider);
    await expect(c.runner.startExisting('nope', startArgs(c.poolId))).rejects.toThrow(/not found/);
  });

  it('resolves the provider from the run tier when providerFor is supplied', async () => {
    const cheap = new FakeLLMProvider({ script: [{ type: 'text', content: 'cheap' }], model: 'cheap-model' });
    const strong = new FakeLLMProvider({ script: [{ type: 'text', content: 'strong' }], model: 'strong-model' });
    const db = openDb({ path: ':memory:' });
    const bus = new CommandBus(db);
    const budget = new BudgetEnforcer(db);
    const runner = new DurableRunner({
      db,
      bus,
      ledger: new TokenLedger(db),
      budget,
      provider: strong,
      price: { in: 1, out: 1 },
      providerFor: (tier) => (tier === 'D' ? { provider: cheap, price: { in: 0.01, out: 0.01 } } : { provider: strong, price: { in: 1, out: 1 } }),
    });
    const pool = budget.createPool({ ownerKind: 'run', ownerId: 'r', amountUsd: 1 });

    const run = await runner.startRun({ ...startArgs(pool.id), tier: 'D' });
    const responded = runner.getEvents(run.id).find((e) => e.type === 'llm_responded')!;
    expect((responded.payload as { content: string }).content).toBe('cheap');

    const ledgerRow = runner.getEvents(run.id);
    expect(ledgerRow.length).toBeGreaterThan(0);
    const row = new TokenLedger(db).listForRun(run.id)[0]!;
    expect(row.model).toBe('cheap-model');
    expect(row.unitPriceInUsd).toBe(0.01);
  });
});

describe('DurableRunner budgeting', () => {
  it('kills the run with killed_budget when input alone exceeds the pool', async () => {
    const provider = new FakeLLMProvider({ script: [{ type: 'text', content: 'never' }], tokensIn: 1000 });
    // $0.000001 pool: even the smallest call cannot be afforded.
    const c = setup(provider, [], 0.000_001);
    const run = await c.runner.startRun(startArgs(c.poolId));
    expect(run.status).toBe('killed_budget');
    expect(c.runner.getEvents(run.id).map((e) => e.type)).toContain('budget_killed');
    // The model was never called: no wasted spend.
    expect(provider.requests).toHaveLength(0);
  });

  it('records each turn in the ledger with a price snapshot', async () => {
    const provider = new FakeLLMProvider({
      script: [
        { type: 'tool_call', name: 'notes.list', args: {}, callId: 'c1' },
        { type: 'text', content: 'finished' },
      ],
      tokensIn: 1000,
      tokensOut: 500,
    });
    const listTool: CommandDefinition<z.ZodObject<Record<string, never>>> = {
      name: 'notes.list',
      description: 'list',
      inputSchema: z.object({}),
      allowedActors: ['human', 'lead'],
      idempotent: true,
      execute: () => ({ notes: [] }),
    };
    const c = setup(provider, [listTool]);
    const run = await c.runner.startRun(startArgs(c.poolId));

    expect(run.status).toBe('completed');
    const rows = c.ledger.listForRun(run.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.unitPriceInUsd).toBe(0.1);
    expect(rows[0]!.tokensIn).toBe(1000);
    expect(rows[0]!.costUsd).toBeCloseTo((1000 / 1e6) * 0.1 + (500 / 1e6) * 0.1, 12);
  });
});

describe('DurableRunner gates', () => {
  it('pauses the run on a gated tool and resumes only after human approval', async () => {
    const provider = new FakeLLMProvider({
      script: [
        { type: 'tool_call', name: 'notes.delete', args: { id: 'n1' }, callId: 'tc-del' },
        { type: 'text', content: 'deleted, moving on' },
      ],
    });
    const deleted: string[] = [];
    const deleteTool: CommandDefinition<z.ZodObject<{ id: z.ZodString }>> = {
      name: 'notes.delete',
      description: 'delete a note',
      inputSchema: z.object({ id: z.string() }),
      allowedActors: ['human', 'lead'],
      idempotent: true,
      requiresGate: true,
      execute: (i) => {
        deleted.push(i.id);
        return { deleted: i.id };
      },
    };
    const c = setup(provider, [deleteTool]);

    const run = await c.runner.startRun(startArgs(c.poolId));
    expect(run.status).toBe('paused_gate');

    const pending = c.runner.listPendingGates();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.commandName).toBe('notes.delete');
    expect(deleted).toHaveLength(0); // not executed yet

    // Human approves: the stored input is executed exactly.
    const { result } = await c.runner.approveGate(pending[0]!.id);
    expect(deleted).toEqual(['n1']);
    expect(result).toEqual({ deleted: 'n1' });

    // Resume continues the loop from the durable log.
    const resumed = await c.runner.resumeRun(run.id, { systemPrompt: 'sys' });
    expect(resumed.status).toBe('completed');

    const types = c.runner.getEvents(run.id).map((e) => e.type);
    expect(types).toContain('gate_opened');
    expect(types).toContain('gate_resolved');
  });

  it('rejection leaves the command unexecuted and records the decision', async () => {
    const provider = new FakeLLMProvider({
      script: [{ type: 'tool_call', name: 'notes.delete', args: { id: 'n1' }, callId: 'tc-del2' }],
    });
    let executed = false;
    const deleteTool: CommandDefinition<z.ZodObject<{ id: z.ZodString }>> = {
      name: 'notes.delete',
      description: 'delete',
      inputSchema: z.object({ id: z.string() }),
      allowedActors: ['human', 'lead'],
      idempotent: true,
      requiresGate: true,
      execute: () => {
        executed = true;
        return {};
      },
    };
    const c = setup(provider, [deleteTool]);
    const run = await c.runner.startRun(startArgs(c.poolId));
    const gate = c.runner.listPendingGates()[0]!;

    await c.runner.rejectGate(gate.id, 'not now');
    expect(executed).toBe(false);

    const resolved = c.runner.getEvents(run.id).find((e) => e.type === 'gate_resolved')!;
    expect((resolved.payload as { decision: string }).decision).toBe('rejected');
    expect((resolved.payload as { reason: string }).reason).toBe('not now');
  });

  it('cannot approve the same gate twice', async () => {
    const provider = new FakeLLMProvider({
      script: [{ type: 'tool_call', name: 'notes.delete', args: { id: 'n1' }, callId: 'tc-x' }],
    });
    const deleteTool: CommandDefinition<z.ZodObject<{ id: z.ZodString }>> = {
      name: 'notes.delete',
      description: 'd',
      inputSchema: z.object({ id: z.string() }),
      allowedActors: ['human', 'lead'],
      idempotent: true,
      requiresGate: true,
      execute: () => ({ ok: true }),
    };
    const c = setup(provider, [deleteTool]);
    await c.runner.startRun(startArgs(c.poolId));
    const gate = c.runner.listPendingGates()[0]!;

    await c.runner.approveGate(gate.id);
    await expect(c.runner.approveGate(gate.id)).rejects.toThrow(/already approved/);
  });
});

describe('stream abort accounting', () => {
  it('records partial tokens from stream_then_abort and does not complete the run', async () => {
    const provider = new FakeLLMProvider({
      script: [{ type: 'stream_then_abort', partialContent: 'half an ans', partialTokensOut: 250 }],
      tokensIn: 1000,
    });
    const c = setup(provider);
    const run = await c.runner.startRun(startArgs(c.poolId));

    expect(run.status).toBe('cancelled');
    const rows = c.ledger.listForRun(run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.aborted).toBe(true);
    expect(rows[0]!.tokensOut).toBe(250);
    expect(rows[0]!.isEstimated).toBe(true);
    expect(rows[0]!.costUsd).toBeGreaterThan(0);
  });

  it('a provider crash fails the run without losing the event log', async () => {
    const provider = new FakeLLMProvider({ script: [{ type: 'crash_process' }] });
    const c = setup(provider);
    const run = await c.runner.startRun(startArgs(c.poolId));
    expect(run.status).toBe('failed');
    const types = c.runner.getEvents(run.id).map((e) => e.type);
    expect(types).toContain('turn_started');
    expect(types).toContain('error');
  });
});

// Replaces the status UPDATE with a failing one so the transaction must roll
// back. Kept out of the test body for readability.
function vi_spy_bad_update(c: Ctx): void {
  const original = c.db.prepare.bind(c.db);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (c.db as any).prepare = (sql: string) => {
    if (sql.startsWith('UPDATE runs SET status')) {
      return {
        run: () => {
          throw new Error('injected status-update failure');
        },
      };
    }
    return original(sql);
  };
}
