import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CommandDefinition, Db, HarnessModule } from '@mf/core';
import { describeActor } from '@mf/core';

/**
 * Notes harness: the reference implementation used to validate capabilities
 * and gates. Deliberately small, and deliberately mixed:
 *
 *   notes.list   idempotent,  no gate   -> any lead/specialist may read
 *   notes.create idempotent:false       -> creation is not safely repeatable
 *   notes.delete idempotent,  GATE      -> destructive, needs a human
 *
 * `notes.delete` being idempotent-but-gated is the interesting case: crash
 * recovery may re-run it safely, but an agent may not run it at all without a
 * human decision.
 */

export interface NoteRow {
  id: string;
  factoryId: string;
  title: string;
  body: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

const NoteSchema = z.object({
  id: z.string(),
  factoryId: z.string(),
  title: z.string(),
  body: z.string(),
  createdBy: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const CreateInput = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(20_000).default(''),
});

const UpdateInput = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(20_000).optional(),
});

const IdInput = z.object({ id: z.string().min(1) });

function actorLabel(actor: Parameters<typeof describeActor>[0]): string {
  return describeActor(actor);
}

export class NotesStore {
  constructor(private readonly db: Db) {}

  list(factoryId: string): NoteRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM factory_notes WHERE factory_id = ? ORDER BY created_at DESC`)
      .all(factoryId) as RawNote[];
    return rows.map(mapNote);
  }

  get(factoryId: string, id: string): NoteRow | null {
    const row = this.db
      .prepare(`SELECT * FROM factory_notes WHERE factory_id = ? AND id = ?`)
      .get(factoryId, id) as RawNote | undefined;
    return row ? mapNote(row) : null;
  }

  create(factoryId: string, input: { title: string; body: string }, createdBy: string): NoteRow {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO factory_notes (id, factory_id, title, body, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(id, factoryId, input.title, input.body, createdBy, now, now);
    return this.get(factoryId, id)!;
  }

  update(factoryId: string, input: { id: string; title?: string; body?: string }): NoteRow | null {
    const existing = this.get(factoryId, input.id);
    if (!existing) return null;
    this.db
      .prepare(`UPDATE factory_notes SET title = ?, body = ?, updated_at = ? WHERE id = ? AND factory_id = ?`)
      .run(
        input.title ?? existing.title,
        input.body ?? existing.body,
        Date.now(),
        input.id,
        factoryId,
      );
    return this.get(factoryId, input.id);
  }

  delete(factoryId: string, id: string): boolean {
    const info = this.db
      .prepare(`DELETE FROM factory_notes WHERE id = ? AND factory_id = ?`)
      .run(id, factoryId);
    return info.changes > 0;
  }
}

export function ensureNotesTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_notes (
      id         TEXT PRIMARY KEY,
      factory_id TEXT NOT NULL,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notes_factory ON factory_notes(factory_id, created_at DESC);
  `);
}

export function createNotesHarness(db: Db, factoryId: string): HarnessModule {
  ensureNotesTable(db);
  const store = new NotesStore(db);

  const list: CommandDefinition<z.ZodObject<Record<string, never>>> = {
    name: 'notes.list',
    description: 'List all notes in this factory, newest first.',
    inputSchema: z.object({}),
    allowedActors: ['human', 'lead', 'specialist'],
    idempotent: true,
    execute: () => ({ notes: store.list(factoryId).map(({ body: _b, ...rest }) => rest) }),
  };

  const read: CommandDefinition<typeof IdInput> = {
    name: 'notes.read',
    description: 'Read one note in full by id.',
    inputSchema: IdInput,
    allowedActors: ['human', 'lead', 'specialist'],
    idempotent: true,
    execute: (input) => {
      const note = store.get(factoryId, input.id);
      return note ? { note } : { note: null, error: 'not found' };
    },
  };

  const create: CommandDefinition<typeof CreateInput> = {
    name: 'notes.create',
    description: 'Create a note with a title and optional body.',
    inputSchema: CreateInput,
    allowedActors: ['human', 'lead', 'specialist'],
    // Not idempotent: repeating it makes a second note. After a crash the
    // effect is genuinely unknown, so recovery must not re-run it.
    idempotent: false,
    execute: (input, actor) => ({ note: store.create(factoryId, input, actorLabel(actor)) }),
  };

  const update: CommandDefinition<typeof UpdateInput> = {
    name: 'notes.update',
    description: 'Update the title and/or body of an existing note.',
    inputSchema: UpdateInput,
    allowedActors: ['human', 'lead', 'specialist'],
    idempotent: true,
    execute: (input) => {
      const note = store.update(factoryId, input);
      return note ? { note } : { note: null, error: 'not found' };
    },
  };

  const del: CommandDefinition<typeof IdInput> = {
    name: 'notes.delete',
    description: 'Delete a note permanently. Requires explicit human approval.',
    inputSchema: IdInput,
    allowedActors: ['human', 'lead'],
    idempotent: true,
    // Destructive: even though replaying is safe, an agent may not do it alone.
    requiresGate: true,
    execute: (input) => ({ deleted: store.delete(factoryId, input.id), id: input.id }),
  };

  return {
    id: 'notes',
    name: 'Notes',
    commands: [list, read, create, update, del],
    renderPromptSection(ctx) {
      const available = ['notes.list', 'notes.read', 'notes.update'].filter((n) => ctx.toolNames.includes(n));
      const gated = ctx.toolNames.includes('notes.delete') ? 'notes.delete' : null;
      return [
        '## Notes',
        'You can keep short working notes for this factory.',
        available.length > 0 ? `Direct tools: ${available.join(', ')}.` : '',
        gated
          ? `${gated} is destructive and will PAUSE the run until a human approves it. Do not call it casually.`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  };
}

export { NoteSchema };

interface RawNote {
  id: string;
  factory_id: string;
  title: string;
  body: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

function mapNote(r: RawNote): NoteRow {
  return {
    id: r.id,
    factoryId: r.factory_id,
    title: r.title,
    body: r.body,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
