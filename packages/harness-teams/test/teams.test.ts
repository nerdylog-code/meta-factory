import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandBus, SqliteGateStore, openDb, type Db } from '@mf/core';
import { SOCIAL_CONTRACT, createTeamsHarness, shouldSpeak, type TeamsHarness } from '../src/index.js';

let db: Db;
let bus: CommandBus;
let teams: TeamsHarness;

const human = { kind: 'human' } as const;

/**
 * A run row for agent actors to reference.
 *
 * approval_gates.run_id is a real foreign key, so an agent actor claiming
 * `runId: 'r'` requires that run to exist. In production the DurableRunner
 * always creates the run before dispatching; tests must do the same.
 */
function seedRun(id = 'r'): void {
  db.prepare(
    `INSERT OR IGNORE INTO runs
       (id, factory_id, agent_id, goal, status, tier, pool_id, turn, created_at, updated_at)
     VALUES (?, 'f1', 'a', 'g', 'running', 'B', NULL, 0, 0, 0)`,
  ).run(id);
}

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  bus = new CommandBus(db);
  bus.setGateStore(new SqliteGateStore(db));
  teams = createTeamsHarness({ db, factoryId: 'f1' });
  bus.registerAll(teams.commands);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
});

describe('agents have their own Core Four', () => {
  it('creates a lead and specialists with independent settings', async () => {
    await bus.dispatch('team.createAgent', { name: 'Lead', role: 'lead', topic: 'coordination' }, human);
    await bus.dispatch(
      'team.createAgent',
      { name: 'Writer', role: 'specialist', topic: 'documentation', tier: 'C', persona: 'terse' },
      human,
    );

    expect(teams.store.list()).toHaveLength(2);
    const writer = teams.store.byName('Writer')!;
    expect(writer.coreFour.model.tier).toBe('C');
    expect(writer.coreFour.prompt.persona).toBe('terse');
    expect(writer.coreFour.prompt.topic).toBe('documentation');

    // The lead's own Core Four is untouched by the specialist's settings.
    expect(teams.store.byName('Lead')!.coreFour.model.tier).toBe('B');
  });

  it('refuses a second lead', async () => {
    await bus.dispatch('team.createAgent', { name: 'Lead', role: 'lead' }, human);
    await expect(bus.dispatch('team.createAgent', { name: 'Lead2', role: 'lead' }, human)).rejects.toMatchObject({
      code: 'LEAD_EXISTS',
    });
  });

  it('refuses duplicate agent names (mentions would be ambiguous)', async () => {
    await bus.dispatch('team.createAgent', { name: 'Writer' }, human);
    await expect(bus.dispatch('team.createAgent', { name: 'writer' }, human)).rejects.toMatchObject({
      code: 'NAME_TAKEN',
    });
  });

  it('Lead Control: the lead reconfigures a specialist', async () => {
    seedRun();
    const lead = (await bus.dispatch('team.createAgent', { name: 'Lead', role: 'lead' }, human)) as {
      result: { agent: { id: string } };
    };
    await bus.dispatch('team.createAgent', { name: 'Writer', tier: 'B' }, human);
    const writer = teams.store.byName('Writer')!;

    await bus.dispatch(
      'team.updateAgent',
      { agentId: writer.id, tier: 'A', thinking: 'high', topic: 'release notes' },
      { kind: 'agent', role: 'lead', agentId: lead.result.agent.id, runId: 'r', toolCallId: 't' },
    );

    const updated = teams.store.get(writer.id)!;
    expect(updated.coreFour.model.tier).toBe('A');
    expect(updated.coreFour.model.thinking).toBe('high');
    expect(updated.coreFour.prompt.topic).toBe('release notes');
  });

  it('a specialist cannot create agents or change others', async () => {
    seedRun();
    const spec = (await bus.dispatch('team.createAgent', { name: 'Writer' }, human)) as {
      result: { agent: { id: string } };
    };
    const specActor = {
      kind: 'agent',
      role: 'specialist',
      agentId: spec.result.agent.id,
      runId: 'r',
      toolCallId: 't',
    } as const;
    await expect(bus.dispatch('team.createAgent', { name: 'Other' }, specActor)).rejects.toThrow(/may not call/);
    await expect(bus.dispatch('team.updateAgent', { agentId: 'x', tier: 'S' }, specActor)).rejects.toThrow(
      /may not call/,
    );
  });

  it('deleting an agent requires a human gate for an agent', async () => {
    seedRun();
    await bus.dispatch('team.createAgent', { name: 'Lead', role: 'lead' }, human);
    const w = (await bus.dispatch('team.createAgent', { name: 'Writer' }, human)) as {
      result: { agent: { id: string } };
    };

    const res = await bus.dispatch(
      'team.deleteAgent',
      { agentId: w.result.agent.id },
      { kind: 'agent', role: 'lead', agentId: 'a', runId: 'r', toolCallId: 't1' },
      { factoryId: 'f1', idempotencyKey: 'k' },
    );
    expect(res.status).toBe('pending_approval');
    expect(teams.store.list()).toHaveLength(2);
  });

  it('deleting an agent is immediate for a human', async () => {
    await bus.dispatch('team.createAgent', { name: 'Writer' }, human);
    const w = teams.store.byName('Writer')!;
    await bus.dispatch('team.deleteAgent', { agentId: w.id }, human);
    expect(teams.store.list()).toHaveLength(0);
  });
});

describe('social contract', () => {
  it('is included in the prompt section', () => {
    teams.store.create({ name: 'Lead', role: 'lead', persona: '', topic: '', tier: 'B' });
    const section = teams.renderPromptSection({ actor: human, toolNames: ['team.post'], factoryName: 'f1' });
    expect(section).toContain('Stay silent when a message is addressed to another agent');
    expect(section).toContain('Lead');
  });

  it('an explicitly mentioned agent speaks', () => {
    const r = shouldSpeak({
      agentName: 'Writer',
      agentRole: 'specialist',
      message: { author: 'human', authorKind: 'human', mentions: ['Writer'] },
    });
    expect(r.speak).toBe(true);
    expect(r.reason).toMatch(/mentioned/);
  });

  it('an agent addressed through another mention stays silent', () => {
    const r = shouldSpeak({
      agentName: 'Writer',
      agentRole: 'specialist',
      message: { author: 'human', authorKind: 'human', mentions: ['Reviewer'] },
    });
    expect(r.speak).toBe(false);
    expect(r.reason).toContain('Reviewer');
  });

  it('the lead answers a human message with no mention; specialists do not', () => {
    const msg = { author: 'human', authorKind: 'human', mentions: [] };
    expect(shouldSpeak({ agentName: 'Lead', agentRole: 'lead', message: msg }).speak).toBe(true);
    expect(shouldSpeak({ agentName: 'Writer', agentRole: 'specialist', message: msg }).speak).toBe(false);
  });

  it('agent-to-agent chatter without a mention wakes nobody (no piling on)', () => {
    const msg = { author: 'Writer', authorKind: 'agent', mentions: [] };
    expect(shouldSpeak({ agentName: 'Lead', agentRole: 'lead', message: msg }).speak).toBe(false);
    expect(shouldSpeak({ agentName: 'Reviewer', agentRole: 'specialist', message: msg }).speak).toBe(false);
  });

  it('the contract text names the failure it prevents', () => {
    expect(SOCIAL_CONTRACT).toContain('another agent answering does not oblige you to answer');
  });
});

describe('chat rooms: two agents talking', () => {
  beforeEach(async () => {
    await bus.dispatch('team.createAgent', { name: 'Lead', role: 'lead' }, human);
    await bus.dispatch('team.createAgent', { name: 'Writer', topic: 'docs' }, human);
  });

  it('a human message is stored and readable', async () => {
    await bus.dispatch('team.post', { room: 'general', body: 'Ship the release notes.' }, human);
    const res = (await bus.dispatch('team.read', { room: 'general' }, human)) as {
      result: { messages: Array<{ author: string; body: string }> };
    };
    expect(res.result.messages).toHaveLength(1);
    expect(res.result.messages[0]!.author).toBe('human');
  });

  it('an agent posts under its own name and the other agent can read it', async () => {
    const lead = teams.store.byName('Lead')!;
    const writer = teams.store.byName('Writer')!;

    await bus.dispatch(
      'team.post',
      { room: 'general', body: 'Writer, draft it.', mentions: ['Writer'] },
      { kind: 'agent', role: 'lead', agentId: lead.id, runId: 'r', toolCallId: 't' },
    );
    await bus.dispatch(
      'team.post',
      { room: 'general', body: 'On it.', mentions: [] },
      { kind: 'agent', role: 'specialist', agentId: writer.id, runId: 'r', toolCallId: 't' },
    );

    const res = (await bus.dispatch('team.read', { room: 'general' }, human)) as {
      result: { messages: Array<{ author: string; mentions: string[] }> };
    };
    expect(res.result.messages.map((m) => m.author)).toEqual(['Lead', 'Writer']);
    expect(res.result.messages[0]!.mentions).toEqual(['Writer']);
  });

  it('unknown mention names are dropped rather than stored as typos', async () => {
    await bus.dispatch('team.post', { room: 'general', body: 'hi', mentions: ['WriteR', 'Ghost'] }, human);
    const res = (await bus.dispatch('team.read', { room: 'general' }, human)) as {
      result: { messages: Array<{ mentions: string[] }> };
    };
    // 'WriteR' matches Writer case-insensitively; 'Ghost' is not an agent.
    expect(res.result.messages[0]!.mentions).toEqual(['WriteR']);
  });

  it('rooms are isolated from each other', async () => {
    await bus.dispatch('team.post', { room: 'a', body: 'in a' }, human);
    await bus.dispatch('team.post', { room: 'b', body: 'in b' }, human);
    const a = (await bus.dispatch('team.read', { room: 'a' }, human)) as { result: { messages: unknown[] } };
    expect(a.result.messages).toHaveLength(1);
  });

  it('reading an unknown room returns empty instead of erroring', async () => {
    const res = (await bus.dispatch('team.read', { room: 'nope' }, human)) as { result: { messages: unknown[] } };
    expect(res.result.messages).toEqual([]);
  });

  it('rooms are listed with message counts', async () => {
    await bus.dispatch('team.post', { room: 'general', body: 'x' }, human);
    await bus.dispatch('team.post', { room: 'general', body: 'y' }, human);
    await bus.dispatch('team.post', { room: 'design', body: 'z' }, human);
    const rooms = teams.store.rooms();
    expect(rooms.find((r) => r.name === 'general')!.messages).toBe(2);
    expect(rooms.find((r) => r.name === 'design')!.messages).toBe(1);
  });

  it('team.ask is gated for an agent and posts nothing before approval', async () => {
    seedRun();
    const lead = teams.store.byName('Lead')!;
    const res = await bus.dispatch(
      'team.ask',
      { room: 'general', prompt: 'What should we ship?' },
      { kind: 'agent', role: 'lead', agentId: lead.id, runId: 'r', toolCallId: 'ta' },
      { factoryId: 'f1', idempotencyKey: 'ask-1' },
    );
    expect(res.status).toBe('pending_approval');
    expect(bus.get('team.ask').requiresGate).toBe(true);
    // The gate holds the exact question; nothing was posted yet.
    expect(teams.store.messages('general', 10)).toHaveLength(0);
  });

  it('team.ask runs immediately for a human and posts the question', async () => {
    const asked: Array<{ prompt: string }> = [];
    const withAsk = createTeamsHarness({
      db,
      factoryId: 'f1',
      onTeamAsk: (a) => {
        asked.push({ prompt: a.prompt });
      },
    });
    const bus2 = new CommandBus(db);
    bus2.registerAll(withAsk.commands);

    await bus2.dispatch('team.ask', { room: 'general', prompt: 'What next?' }, human);
    expect(asked).toHaveLength(1);
    expect(withAsk.store.messages('general', 10)[0]!.body).toBe('What next?');
  });
});
