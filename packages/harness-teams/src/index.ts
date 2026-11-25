import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  FactoryError,
  NotFoundError,
  type Actor,
  type CommandDefinition,
  type Db,
  type HarnessModule,
  type Tier,
} from '@mf/core';

/**
 * Small agent teams.
 *
 * A factory can host several durable agents. Each has its own Core Four
 * (context, model, prompt, tools) stored in `agents`; the Lead is the human's
 * single interface and holds `Lead Control` over the specialists' settings.
 *
 * Coordination happens in named chat rooms under an explicit SOCIAL CONTRACT:
 * an agent speaks when mentioned or when it owns the topic, and stays silent
 * when a message is addressed to someone else. Loud silence is the failure mode
 * this contract exists to prevent — four agents all answering every message is
 * noise, not teamwork.
 */

export const AgentRowSchema = z.object({
  id: z.string(),
  factoryId: z.string(),
  role: z.enum(['lead', 'specialist']),
  name: z.string(),
  coreFour: z.object({
    context: z.record(z.string(), z.unknown()).default({}),
    model: z
      .object({
        tier: z.enum(['S+', 'S', 'A', 'B', 'C', 'D']).default('B'),
        thinking: z.enum(['off', 'low', 'medium', 'high']).default('off'),
        temperature: z.number().min(0).max(2).default(0.2),
      })
      .prefault({}),
    prompt: z
      .object({
        persona: z.string().max(8000).default(''),
        topic: z.string().max(500).default(''),
      })
      .prefault({}),
    tools: z
      .object({
        disabled: z.array(z.string()).default([]),
      })
      .prefault({}),
  }),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type AgentRow = z.infer<typeof AgentRowSchema> & {
  coreFour: {
    context: Record<string, unknown>;
    model: { tier: Tier; thinking: 'off' | 'low' | 'medium' | 'high'; temperature: number };
    prompt: { persona: string; topic: string };
    tools: { disabled: string[] };
  };
};

export const SOCIAL_CONTRACT = `## Team contract
You are one agent among several in this factory.
- Speak when you are @mentioned, or when the message is squarely in your topic.
- Stay silent when a message is addressed to another agent: another agent answering does not oblige you to answer.
- If you disagree with a teammate, say so plainly and briefly; do not repeat their point.
- Do not restate what was just said. Add information or ask a question.
- The human talks to the Lead. Specialists answer the Lead unless the human mentions them directly.`;

const CreateAgentInput = z.object({
  name: z.string().min(1).max(60),
  role: z.enum(['lead', 'specialist']).default('specialist'),
  persona: z.string().max(8000).default(''),
  topic: z.string().max(500).default(''),
  tier: z.enum(['S+', 'S', 'A', 'B', 'C', 'D']).default('B'),
});

const UpdateAgentInput = z.object({
  agentId: z.string().min(1),
  name: z.string().min(1).max(60).optional(),
  persona: z.string().max(8000).optional(),
  topic: z.string().max(500).optional(),
  tier: z.enum(['S+', 'S', 'A', 'B', 'C', 'D']).optional(),
  thinking: z.enum(['off', 'low', 'medium', 'high']).optional(),
  disabledTools: z.array(z.string()).optional(),
});

const PostInput = z.object({
  room: z.string().min(1).max(80),
  body: z.string().min(1).max(20_000),
  mentions: z.array(z.string()).max(20).default([]),
});

const ReadInput = z.object({
  room: z.string().min(1).max(80),
  limit: z.number().int().min(1).max(500).default(50),
});

export class TeamStore {
  constructor(
    private readonly db: Db,
    private readonly factoryId: string,
  ) {}

  list(): AgentRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM agents WHERE factory_id = ? ORDER BY role ASC, created_at ASC`)
      .all(this.factoryId) as RawAgent[];
    return rows.map(mapAgent);
  }

  get(id: string): AgentRow | null {
    const row = this.db.prepare(`SELECT * FROM agents WHERE id = ? AND factory_id = ?`).get(id, this.factoryId) as
      | RawAgent
      | undefined;
    return row ? mapAgent(row) : null;
  }

  byName(name: string): AgentRow | null {
    const row = this.db
      .prepare(`SELECT * FROM agents WHERE factory_id = ? AND lower(name) = lower(?)`)
      .get(this.factoryId, name) as RawAgent | undefined;
    return row ? mapAgent(row) : null;
  }

  lead(): AgentRow | null {
    return this.list().find((a) => a.role === 'lead') ?? null;
  }

  create(input: z.infer<typeof CreateAgentInput>): AgentRow {
    if (input.role === 'lead' && this.lead()) {
      throw new FactoryError('This factory already has a lead agent', 'LEAD_EXISTS', 409);
    }
    if (this.byName(input.name)) {
      throw new FactoryError(`Agent name '${input.name}' is taken`, 'NAME_TAKEN', 409);
    }
    const id = randomUUID();
    const now = Date.now();
    const coreFour = AgentRowSchema.shape.coreFour.parse({
      prompt: { persona: input.persona, topic: input.topic },
      model: { tier: input.tier },
    });
    this.db
      .prepare(
        `INSERT INTO agents (id, factory_id, role, name, context_config_json, model_config_json, prompt_json, tools_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        this.factoryId,
        input.role,
        input.name,
        JSON.stringify(coreFour.context),
        JSON.stringify(coreFour.model),
        JSON.stringify(coreFour.prompt),
        JSON.stringify(coreFour.tools),
        now,
        now,
      );
    return this.get(id)!;
  }

  update(input: z.infer<typeof UpdateAgentInput>): AgentRow {
    const existing = this.get(input.agentId);
    if (!existing) throw new NotFoundError(`Agent ${input.agentId} not found`);
    const cf = structuredClone(existing.coreFour);
    if (input.persona !== undefined) cf.prompt.persona = input.persona;
    if (input.topic !== undefined) cf.prompt.topic = input.topic;
    if (input.tier !== undefined) cf.model.tier = input.tier;
    if (input.thinking !== undefined) cf.model.thinking = input.thinking;
    if (input.disabledTools !== undefined) cf.tools.disabled = input.disabledTools;

    this.db
      .prepare(
        `UPDATE agents SET name = ?, model_config_json = ?, prompt_json = ?, tools_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        input.name ?? existing.name,
        JSON.stringify(cf.model),
        JSON.stringify(cf.prompt),
        JSON.stringify(cf.tools),
        Date.now(),
        input.agentId,
      );
    return this.get(input.agentId)!;
  }

  delete(id: string): boolean {
    const info = this.db.prepare(`DELETE FROM agents WHERE id = ? AND factory_id = ?`).run(id, this.factoryId);
    return info.changes > 0;
  }

  // ------------------------------------------------------------- rooms
  ensureRoom(name: string): string {
    const existing = this.db
      .prepare(`SELECT id FROM chat_rooms WHERE factory_id = ? AND name = ?`)
      .get(this.factoryId, name) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO chat_rooms (id, factory_id, name, created_at) VALUES (?,?,?,?)`)
      .run(id, this.factoryId, name, Date.now());
    return id;
  }

  post(args: { room: string; author: string; authorKind: string; body: string; mentions: string[] }): RoomMessage {
    const roomId = this.ensureRoom(args.room);
    const info = this.db
      .prepare(
        `INSERT INTO room_messages (room_id, author, author_kind, mentions, body, created_at) VALUES (?,?,?,?,?,?)`,
      )
      .run(roomId, args.author, args.authorKind, JSON.stringify(args.mentions), args.body, Date.now());
    return {
      id: Number(info.lastInsertRowid),
      room: args.room,
      author: args.author,
      authorKind: args.authorKind,
      mentions: args.mentions,
      body: args.body,
      createdAt: Date.now(),
    };
  }

  messages(room: string, limit: number): RoomMessage[] {
    const roomRow = this.db
      .prepare(`SELECT id FROM chat_rooms WHERE factory_id = ? AND name = ?`)
      .get(this.factoryId, room) as { id: string } | undefined;
    if (!roomRow) return [];
    const rows = this.db
      .prepare(`SELECT * FROM room_messages WHERE room_id = ? ORDER BY id DESC LIMIT ?`)
      .all(roomRow.id, limit) as RawMessage[];
    return rows.reverse().map((r) => mapMessage(r, room));
  }

  rooms(): Array<{ name: string; messages: number }> {
    const rows = this.db
      .prepare(
        `SELECT r.name AS name, COUNT(m.id) AS n
           FROM chat_rooms r LEFT JOIN room_messages m ON m.room_id = r.id
          WHERE r.factory_id = ? GROUP BY r.id ORDER BY r.created_at DESC`,
      )
      .all(this.factoryId) as Array<{ name: string; n: number }>;
    return rows.map((r) => ({ name: r.name, messages: r.n }));
  }
}

export interface RoomMessage {
  id: number;
  room: string;
  author: string;
  authorKind: string;
  mentions: string[];
  body: string;
  createdAt: number;
}

/**
 * Decides whether an agent should speak. This is the contract in code, so the
 * rule is testable instead of being a paragraph the model may ignore.
 */
export function shouldSpeak(args: {
  agentName: string;
  agentRole: 'lead' | 'specialist';
  message: { author: string; authorKind: string; mentions: string[] };
  /** True when the message is a direct human message in a private-ish room. */
  directToAgent?: boolean;
}): { speak: boolean; reason: string } {
  const { agentName, agentRole, message } = args;
  const mentioned = message.mentions.some((m) => m.toLowerCase() === agentName.toLowerCase());

  if (mentioned) return { speak: true, reason: 'explicitly mentioned' };

  // A message addressed to someone else (by mention) is not for us.
  if (message.mentions.length > 0) {
    return { speak: false, reason: `addressed to ${message.mentions.join(', ')}` };
  }

  if (message.authorKind === 'human') {
    // The human talks to the Lead by default.
    return agentRole === 'lead'
      ? { speak: true, reason: 'human message; lead is the interface' }
      : { speak: false, reason: 'human message with no mention: lead answers' };
  }

  if (message.authorKind === 'agent') {
    // Agent-to-agent without a mention: nobody should pile on.
    return { speak: false, reason: 'agent message with no mention: stay silent' };
  }

  return { speak: false, reason: 'unrecognised author kind' };
}

export interface TeamsHarnessOptions {
  db: Db;
  factoryId: string;
  /** Called when the human asks the team something; starts the real work. */
  onTeamAsk?: (args: { room: string; prompt: string; asker: string }) => Promise<void> | void;
}

export interface TeamsHarness extends HarnessModule {
  store: TeamStore;
}

export function createTeamsHarness(opts: TeamsHarnessOptions): TeamsHarness {
  const store = new TeamStore(opts.db, opts.factoryId);

  const listAgents: CommandDefinition<z.ZodObject<Record<string, never>>> = {
    name: 'team.listAgents',
    description: 'List the agents in this factory with their role, topic and model tier.',
    inputSchema: z.object({}),
    allowedActors: ['human', 'lead', 'specialist'],
    idempotent: true,
    execute: () => ({
      agents: store.list().map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        topic: a.coreFour.prompt.topic,
        tier: a.coreFour.model.tier,
      })),
    }),
  };

  const createAgent: CommandDefinition<typeof CreateAgentInput> = {
    name: 'team.createAgent',
    description: 'Add an agent to this factory. Only the lead (or a human) may add agents.',
    inputSchema: CreateAgentInput,
    allowedActors: ['human', 'lead'],
    idempotent: false,
    execute: (input) => ({ agent: store.create(input) }),
  };

  const updateAgent: CommandDefinition<typeof UpdateAgentInput> = {
    name: 'team.updateAgent',
    description: "Lead Control: change a specialist's persona, topic, tier, thinking or tools.",
    inputSchema: UpdateAgentInput,
    allowedActors: ['human', 'lead'],
    idempotent: true,
    execute: (input) => ({ agent: store.update(input) }),
  };

  const deleteAgent: CommandDefinition<z.ZodObject<{ agentId: z.ZodString }>> = {
    name: 'team.deleteAgent',
    description: 'Remove an agent. Requires human approval.',
    inputSchema: z.object({ agentId: z.string().min(1) }),
    allowedActors: ['human', 'lead'],
    idempotent: true,
    requiresGate: true,
    execute: (input) => ({ deleted: store.delete(input.agentId), agentId: input.agentId }),
  };

  const post: CommandDefinition<typeof PostInput> = {
    name: 'team.post',
    description: 'Post a message to a chat room. Mention agents by name to address them.',
    inputSchema: PostInput,
    allowedActors: ['human', 'lead', 'specialist'],
    idempotent: false,
    execute: (input, actor) => {
      const author = authorName(actor, store);
      // Normalise mentions to known agent names so typos cannot silently
      // address nobody.
      const known = store.list().map((a) => a.name.toLowerCase());
      const mentions = input.mentions.filter((m) => known.includes(m.toLowerCase()));
      return { message: store.post({ room: input.room, author, authorKind: kindOf(actor), body: input.body, mentions }) };
    },
  };

  const read: CommandDefinition<typeof ReadInput> = {
    name: 'team.read',
    description: 'Read the most recent messages in a chat room.',
    inputSchema: ReadInput,
    allowedActors: ['human', 'lead', 'specialist'],
    idempotent: true,
    execute: (input) => ({ messages: store.messages(input.room, input.limit) }),
  };

  const ASK_INPUT = z.object({
    room: z.string().min(1).max(80).default('general'),
    prompt: z.string().min(1).max(8000),
  });
  const ask: CommandDefinition<typeof ASK_INPUT> = {
    name: 'team.ask',
    description:
      'Ask the team a question. Integrates with ApprovalGate: the human sees and approves the question before the team spends anything.',
    inputSchema: ASK_INPUT,
    allowedActors: ['human', 'lead'],
    idempotent: false,
    // Asking the team starts runs; it is a spend decision, so it is gated for
    // agents and immediate for the human who is doing the asking.
    requiresGate: true,
    execute: async (input, actor) => {
      const message = store.post({
        room: input.room,
        author: authorName(actor, store),
        authorKind: kindOf(actor),
        body: input.prompt,
        mentions: [],
      });
      await opts.onTeamAsk?.({ room: input.room, prompt: input.prompt, asker: message.author });
      return { message, dispatched: true };
    },
  };

  return {
    id: 'teams',
    name: 'Teams',
    store,
    commands: [listAgents, createAgent, updateAgent, deleteAgent, post, read, ask],
    renderPromptSection(ctx) {
      const agents = store.list();
      if (agents.length === 0) return '';
      const lines = [SOCIAL_CONTRACT, '### Agents in this factory'];
      for (const a of agents) {
        lines.push(
          `- ${a.name} (${a.role})${a.coreFour.prompt.topic ? ` — ${a.coreFour.prompt.topic}` : ''} [tier ${a.coreFour.model.tier}]`,
        );
      }
      if (ctx.toolNames.includes('team.createAgent')) {
        lines.push('You may add or reconfigure specialists with team.createAgent / team.updateAgent.');
      }
      return lines.join('\n');
    },
  };
}

function kindOf(actor: Actor): string {
  return actor.kind === 'agent' ? 'agent' : actor.kind;
}

function authorName(actor: Actor, store: TeamStore): string {
  if (actor.kind === 'human') return 'human';
  if (actor.kind === 'trigger') return `trigger:${actor.triggerId}`;
  const agent = store.get(actor.agentId) ?? store.list().find((a) => a.role === actor.role);
  return agent?.name ?? actor.role;
}

interface RawAgent {
  id: string;
  factory_id: string;
  role: string;
  name: string;
  context_config_json: string;
  model_config_json: string;
  prompt_json: string;
  tools_json: string;
  created_at: number;
  updated_at: number;
}

function mapAgent(r: RawAgent): AgentRow {
  return {
    id: r.id,
    factoryId: r.factory_id,
    role: r.role as 'lead' | 'specialist',
    name: r.name,
    coreFour: {
      context: safeJson(r.context_config_json, {}),
      model: safeJson(r.model_config_json, { tier: 'B', thinking: 'off', temperature: 0.2 }),
      prompt: safeJson(r.prompt_json, { persona: '', topic: '' }),
      tools: safeJson(r.tools_json, { disabled: [] }),
    } as AgentRow['coreFour'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

interface RawMessage {
  id: number;
  room_id: string;
  author: string;
  author_kind: string;
  mentions: string;
  body: string;
  created_at: number;
}

function mapMessage(r: RawMessage, room: string): RoomMessage {
  return {
    id: r.id,
    room,
    author: r.author,
    authorKind: r.author_kind,
    mentions: safeJson<string[]>(r.mentions, []),
    body: r.body,
    createdAt: r.created_at,
  };
}
