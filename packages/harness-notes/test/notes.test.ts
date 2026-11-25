import { describe, expect, it, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  BudgetEnforcer,
  CommandBus,
  DurableRunner,
  FakeLLMProvider,
  ForbiddenError,
  SqliteGateStore,
  TokenLedger,
  openDb,
  type Db,
} from '@mf/core';
import { createNotesHarness, NotesStore } from '../src/index.js';

let db: Db;
let bus: CommandBus;
let runner: DurableRunner;
let poolId: string;

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  bus = new CommandBus(db);
  const ledger = new TokenLedger(db);
  const budget = new BudgetEnforcer(db);
  const harness = createNotesHarness(db, 'f1');
  bus.registerAll(harness.commands);
  bus.setGateStore(new SqliteGateStore(db));
  runner = new DurableRunner({
    db,
    bus,
    ledger,
    budget,
    provider: new FakeLLMProvider({ script: [{ type: 'text', content: 'ok' }] }),
    price: { in: 0, out: 0 },
  });
  poolId = budget.createPool({ ownerKind: 'factory', ownerId: 'f1', amountUsd: 1 }).id;
});

const human = { kind: 'human' } as const;
const lead = { kind: 'agent', role: 'lead', agentId: 'lead-1', runId: 'r1', toolCallId: 't1' } as const;

describe('notes harness capabilities', () => {
  it('notes.list is idempotent and ungated', async () => {
    const res = await bus.dispatch('notes.list', {}, lead);
    expect(res.status).toBe('ok');
    expect((res as { result: { notes: unknown[] } }).result.notes).toEqual([]);
  });

  it('notes.create is marked non-idempotent', () => {
    expect(bus.get('notes.create').idempotent).toBe(false);
  });

  it('notes.delete requires a gate and is idempotent', () => {
    const cmd = bus.get('notes.delete');
    expect(cmd.requiresGate).toBe(true);
    expect(cmd.idempotent).toBe(true);
  });

  it('a trigger actor cannot touch notes at all', async () => {
    await expect(
      bus.dispatch('notes.list', {}, { kind: 'trigger', triggerId: 't', jobId: 'j' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('a specialist cannot delete (only lead and human may)', async () => {
    const note = new NotesStore(db).create('f1', { title: 'x', body: '' }, 'test');
    await expect(
      bus.dispatch(
        'notes.delete',
        { id: note.id },
        { kind: 'agent', role: 'specialist', agentId: 's1', runId: 'r1', toolCallId: 't2' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('notes harness end-to-end through the runner', () => {
  it('creates, lists and reads a note produced by the agent', async () => {
    const provider = new FakeLLMProvider({
      script: [
        { type: 'tool_call', name: 'notes.create', args: { title: 'Plan', body: 'do it' }, callId: 'c1' },
        { type: 'tool_call', name: 'notes.list', args: {}, callId: 'c2' },
        { type: 'text', content: 'noted' },
      ],
    });
    const ledger = new TokenLedger(db);
    const runner2 = new DurableRunner({
      db,
      bus,
      ledger,
      budget: new BudgetEnforcer(db),
      provider,
      price: { in: 0, out: 0 },
    });

    const run = await runner2.startRun({
      factoryId: 'f1',
      goal: 'make a plan',
      tier: 'B',
      poolId,
      systemPrompt: 'sys',
      maxTurns: 5,
    });

    expect(run.status).toBe('completed');
    const notes = new NotesStore(db).list('f1');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe('Plan');
    expect(notes[0]!.createdBy).toBe('lead:lead');
  });

  it('a delete by the agent pauses the run, and approval executes it', async () => {
    const store = new NotesStore(db);
    const note = store.create('f1', { title: 'doomed', body: '' }, 'human');

    const provider = new FakeLLMProvider({
      script: [
        { type: 'tool_call', name: 'notes.delete', args: { id: note.id }, callId: 'c-del' },
        { type: 'text', content: 'deleted' },
      ],
    });
    const ledger = new TokenLedger(db);
    const runner2 = new DurableRunner({
      db,
      bus,
      ledger,
      budget: new BudgetEnforcer(db),
      provider,
      price: { in: 0, out: 0 },
    });

    const run = await runner2.startRun({
      factoryId: 'f1',
      goal: 'delete the note',
      tier: 'B',
      poolId,
      systemPrompt: 'sys',
      maxTurns: 5,
    });
    expect(run.status).toBe('paused_gate');
    expect(store.get('f1', note.id)).not.toBeNull(); // still there

    const gate = runner2.listPendingGates()[0]!;
    expect(gate.commandName).toBe('notes.delete');
    // The stored validated input is exactly what the model asked for.
    expect(JSON.parse(gate.validatedInputJson)).toEqual({ id: note.id });

    await runner2.approveGate(gate.id);
    expect(store.get('f1', note.id)).toBeNull(); // now gone

    const resumed = await runner2.resumeRun(run.id, { systemPrompt: 'sys' });
    expect(resumed.status).toBe('completed');
  });

  it('never leaks bodies in notes.list (only metadata)', async () => {
    new NotesStore(db).create('f1', { title: 't', body: 'SECRET' }, 'human');
    const res = await bus.dispatch('notes.list', {}, human);
    expect(JSON.stringify(res)).not.toContain('SECRET');
  });

  it('scopes notes per factory', async () => {
    new NotesStore(db).create('f1', { title: 'a', body: '' }, 'human');
    const other = createNotesHarness(db, 'f2');
    const otherList = other.commands.find((c) => c.name === 'notes.list')!;
    const res = await otherList.execute({}, human);
    expect((res as { notes: unknown[] }).notes).toEqual([]);
  });

  it('rejects an over-long title at the schema boundary', async () => {
    await expect(bus.dispatch('notes.create', { title: 'x'.repeat(201) }, human)).rejects.toThrow(/Invalid input/);
  });

  it('renders a prompt section that mentions the gate', () => {
    const harness = createNotesHarness(db, 'f1');
    const section = harness.renderPromptSection({
      actor: lead,
      toolNames: ['notes.list', 'notes.delete'],
      factoryName: 'f1',
    });
    expect(section).toContain('notes.list');
    expect(section).toContain('PAUSE');
  });

  it('exports zod schemas as JSON Schema for the model', () => {
    const tool = bus.listToolsForActor('lead').find((t) => t.name === 'notes.create')!;
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' } },
    });
    void z;
  });
});
