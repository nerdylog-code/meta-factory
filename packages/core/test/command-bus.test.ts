import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CommandBus, SqliteGateStore } from '../src/bus/command-bus.js';
import { openDb } from '../src/db/client.js';
import { ForbiddenError, UnknownCommandError, ValidationError } from '../src/errors.js';
import type { Actor, CommandDefinition } from '../src/types.js';

function makeBus() {
  const db = openDb({ path: ':memory:' });
  const bus = new CommandBus(db);
  const gates = new SqliteGateStore(db);
  bus.setGateStore(gates);
  // Gates reference runs by FK, so the run the agent claims to belong to must
  // actually exist — that constraint is what stops a forged runId from landing
  // in approval_gates.
  db.prepare(
    `INSERT INTO runs (id, factory_id, agent_id, goal, status, tier, pool_id, turn, created_at, updated_at)
     VALUES ('run-1','f1','a1','goal','running','B',NULL,0,0,0)`,
  ).run();
  return { db, bus, gates };
}

const notesList: CommandDefinition = {
  name: 'notes.list',
  description: 'List notes',
  inputSchema: z.object({}),
  allowedActors: ['human', 'lead', 'specialist'],
  idempotent: true,
  execute: () => ({ notes: [] }),
};

const notesDelete: CommandDefinition<z.ZodObject<{ id: z.ZodString }>> = {
  name: 'notes.delete',
  description: 'Delete a note',
  inputSchema: z.object({ id: z.string().min(1) }),
  allowedActors: ['human', 'lead'],
  idempotent: true,
  requiresGate: true,
  execute: (input) => ({ deleted: input.id }),
};

const humanOnly: CommandDefinition<z.ZodObject<{ value: z.ZodNumber }>> = {
  name: 'factory.secret',
  description: 'Human-only command',
  inputSchema: z.object({ value: z.number() }),
  allowedActors: ['human'],
  idempotent: false,
  execute: (input) => ({ echoed: input.value }),
};

const agent: Actor = { kind: 'agent', role: 'lead', agentId: 'a1', runId: 'run-1', toolCallId: 'tc-1' };

describe('CommandBus capabilities', () => {
  it('blocks an actor not listed in allowedActors with ForbiddenError', async () => {
    const { bus } = makeBus();
    bus.registerAll([notesList, notesDelete, humanOnly]);
    await expect(bus.dispatch('factory.secret', { value: 1 }, agent)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('legacy capability rule: allowedActors is checked BEFORE schema validation', async () => {
    const { bus } = makeBus();
    bus.register(humanOnly);
    // Malformed input from a forbidden actor must still be a 403, not a 400:
    // an unauthorized caller learns nothing about the schema.
    await expect(bus.dispatch('factory.secret', { value: 'not-a-number' }, agent)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('throws UnknownCommandError for an unregistered command', () => {
    const { bus } = makeBus();
    expect(() => bus.get('nope.nope')).toThrow(UnknownCommandError);
  });

  it('rejects invalid input with ValidationError carrying issues', async () => {
    const { bus } = makeBus();
    bus.register(notesDelete);
    try {
      await bus.dispatch('notes.delete', {}, { kind: 'human' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).issues).toBeInstanceOf(Array);
    }
  });

  it('duplicate registration is a programming error, not silently overwritten', () => {
    const { bus } = makeBus();
    bus.register(notesList);
    expect(() => bus.register(notesList)).toThrow(/Duplicate command registration/);
  });

  it('listToolsForActor exports only permitted commands with JSON Schema', () => {
    const { bus } = makeBus();
    bus.registerAll([notesList, notesDelete, humanOnly]);

    const lead = bus.listToolsForActor('lead').map((t) => t.name);
    expect(lead).toContain('notes.list');
    expect(lead).toContain('notes.delete');
    expect(lead).not.toContain('factory.secret');

    const human = bus.listToolsForActor('human').map((t) => t.name);
    expect(human).toContain('factory.secret');

    const list = bus.listToolsForActor('lead').find((t) => t.name === 'notes.delete')!;
    expect(list.inputSchema).toMatchObject({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    });
  });

  it('a trigger actor respects declared capabilities', async () => {
    const { bus } = makeBus();
    bus.register(notesList);
    const trigger: Actor = { kind: 'trigger', triggerId: 't1', jobId: 'j1' };
    // notesList allows lead/specialist/human but not trigger.
    await expect(bus.dispatch('notes.list', {}, trigger)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('ApprovalGate', () => {
  it('intercepts a gated command from an agent and persists it without executing', async () => {
    const { bus, gates } = makeBus();
    let executed = false;
    const cmd: CommandDefinition<z.ZodObject<{ id: z.ZodString }>> = {
      ...notesDelete,
      execute: (i) => {
        executed = true;
        return { deleted: i.id };
      },
    };
    bus.register(cmd);

    const res = await bus.dispatch('notes.delete', { id: 'n1' }, agent, { factoryId: 'f1' });
    expect(res.status).toBe('pending_approval');
    expect(executed).toBe(false);

    const gateId = (res as { gateId: string }).gateId;
    const gate = gates.get(gateId)!;
    expect(gate.commandName).toBe('notes.delete');
    expect(gate.runId).toBe('run-1');
    expect(gate.toolCallId).toBe('tc-1');
    // The stored input is the POST-Zod value.
    expect(JSON.parse(gate.validatedInputJson)).toEqual({ id: 'n1' });
    // The requester is recorded server-side.
    expect(JSON.parse(gate.requestedByJson)).toMatchObject({ kind: 'agent', role: 'lead' });
  });

  it('executes immediately for a human actor (no gate)', async () => {
    const { bus } = makeBus();
    bus.register(notesDelete);
    const res = await bus.dispatch('notes.delete', { id: 'n2' }, { kind: 'human' });
    expect(res).toEqual({ status: 'ok', result: { deleted: 'n2' } });
  });

  it('the same idempotency key does not open a second gate', async () => {
    const { bus, gates } = makeBus();
    bus.register(notesDelete);
    const a = await bus.dispatch('notes.delete', { id: 'x' }, agent, {
      factoryId: 'f1',
      idempotencyKey: 'run-1:tc-1',
    });
    const b = await bus.dispatch('notes.delete', { id: 'x' }, agent, {
      factoryId: 'f1',
      idempotencyKey: 'run-1:tc-1',
    });
    expect((a as { gateId: string }).gateId).toBe((b as { gateId: string }).gateId);
    expect(gates.listPending()).toHaveLength(1);
  });

  it('refuses to open a gate when no GateStore is configured', async () => {
    const { bus } = makeBus();
    bus.register(notesDelete);
    const bare = new CommandBus();
    bare.register(notesDelete);
    await expect(bare.dispatch('notes.delete', { id: 'z' }, agent)).rejects.toThrow(/no GateStore/);
    expect(bus).toBeDefined();
  });
});
