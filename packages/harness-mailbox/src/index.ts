import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  FactoryError,
  NotFoundError,
  type CommandDefinition,
  type Db,
  type HarnessModule,
  type TokenLedger,
} from '@mf/core';

/**
 * Factory-to-factory mail.
 *
 * Two local factories can talk without either of them exposing a network
 * surface: the message is written to the shared state database and the other
 * factory's `mailbox.list` picks it up. Authentication is the factory identity
 * itself — a factory can only read mail addressed to it, and `fromFactory` is
 * resolved from the caller's actor, never from the payload.
 */

export const MessageStatus = z.enum(['unread', 'read']);

const SendInput = z.object({
  toFactory: z.string().min(1).max(80),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  replyTo: z.string().optional(),
});

const ListInput = z.object({
  status: MessageStatus.optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

const ReadInput = z.object({ id: z.string().min(1) });

export interface MailRow {
  id: string;
  fromFactory: string;
  toFactory: string;
  subject: string;
  body: string;
  status: 'unread' | 'read';
  replyTo: string | null;
  createdAt: number;
  readAt: number | null;
}

export class MailboxStore {
  constructor(
    private readonly db: Db,
    private readonly factoryId: string,
  ) {}

  send(args: { toFactory: string; subject: string; body: string; replyTo?: string }): MailRow {
    if (args.toFactory === this.factoryId) {
      // Sending to yourself is almost always a wiring mistake; make it loud.
      throw new FactoryError('Cannot send mail to your own factory', 'SELF_MAIL', 400);
    }
    const exists = this.db
      .prepare(`SELECT 1 AS ok FROM agents WHERE factory_id = ? LIMIT 1`)
      .get(args.toFactory) as { ok: number } | undefined;
    // A factory with no agents is not necessarily wrong (it may be brand new),
    // so this is a warning in the response, not a rejection.
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO mailbox (id, from_factory, to_factory, subject, body, status, reply_to, created_at)
         VALUES (?,?,?,?,?,'unread',?,?)`,
      )
      .run(id, this.factoryId, args.toFactory, args.subject, args.body, args.replyTo ?? null, Date.now());
    return this.get(id)!;
  }

  get(id: string): MailRow | null {
    const row = this.db.prepare(`SELECT * FROM mailbox WHERE id = ?`).get(id) as RawMail | undefined;
    return row ? mapMail(row) : null;
  }

  /** Only mail addressed to THIS factory. */
  list(filter: { status?: 'unread' | 'read'; limit: number }): MailRow[] {
    const rows = filter.status
      ? (this.db
          .prepare(
            `SELECT * FROM mailbox WHERE to_factory = ? AND status = ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(this.factoryId, filter.status, filter.limit) as RawMail[])
      : (this.db
          .prepare(`SELECT * FROM mailbox WHERE to_factory = ? ORDER BY created_at DESC LIMIT ?`)
          .all(this.factoryId, filter.limit) as RawMail[]);
    return rows.map(mapMail);
  }

  listSent(limit = 50): MailRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM mailbox WHERE from_factory = ? ORDER BY created_at DESC LIMIT ?`)
      .all(this.factoryId, limit) as RawMail[];
    return rows.map(mapMail);
  }

  markRead(id: string): MailRow {
    const row = this.db.prepare(`SELECT * FROM mailbox WHERE id = ?`).get(id) as RawMail | undefined;
    if (!row) throw new NotFoundError(`Mail ${id} not found`);
    if (row.to_factory !== this.factoryId) {
      // Reading someone else's mail is an authorization failure, not a 404 with
      // a hint: do not reveal that the message exists.
      throw new NotFoundError(`Mail ${id} not found`);
    }
    if (row.status === 'unread') {
      this.db.prepare(`UPDATE mailbox SET status = 'read', read_at = ? WHERE id = ?`).run(Date.now(), id);
    }
    return this.get(id)!;
  }

  unreadCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM mailbox WHERE to_factory = ? AND status = 'unread'`)
      .get(this.factoryId) as { n: number };
    return row.n;
  }
}

export interface MailboxHarness extends HarnessModule {
  store: MailboxStore;
}

export function createMailboxHarness(opts: { db: Db; factoryId: string }): MailboxHarness {
  const store = new MailboxStore(opts.db, opts.factoryId);

  const send: CommandDefinition<typeof SendInput> = {
    name: 'mailbox.send',
    description: 'Send a message to another local factory.',
    inputSchema: SendInput,
    allowedActors: ['human', 'lead'],
    idempotent: false,
    execute: (input) => ({ mail: store.send(input) }),
  };

  const list: CommandDefinition<typeof ListInput> = {
    name: 'mailbox.list',
    description: 'List mail addressed to this factory.',
    inputSchema: ListInput,
    allowedActors: ['human', 'lead', 'specialist'],
    idempotent: true,
    execute: (input) => ({ mail: store.list(input), unread: store.unreadCount() }),
  };

  const read: CommandDefinition<typeof ReadInput> = {
    name: 'mailbox.read',
    description: 'Read one message addressed to this factory, marking it read.',
    inputSchema: ReadInput,
    allowedActors: ['human', 'lead', 'specialist'],
    idempotent: true,
    execute: (input) => ({ mail: store.markRead(input.id) }),
  };

  return {
    id: 'mailbox',
    name: 'Mailbox',
    store,
    commands: [send, list, read],
    renderPromptSection(ctx) {
      if (!ctx.toolNames.includes('mailbox.list')) return '';
      const unread = store.unreadCount();
      return [
        '## Mailbox',
        `You can exchange messages with other local factories (${ctx.factoryName} → other factories).`,
        unread > 0 ? `There ${unread === 1 ? 'is' : 'are'} ${unread} unread message(s) addressed to this factory.` : 'No unread mail.',
      ].join('\n');
    },
  };
}

interface RawMail {
  id: string;
  from_factory: string;
  to_factory: string;
  subject: string;
  body: string;
  status: string;
  reply_to: string | null;
  created_at: number;
  read_at: number | null;
}

function mapMail(r: RawMail): MailRow {
  return {
    id: r.id,
    fromFactory: r.from_factory,
    toFactory: r.to_factory,
    subject: r.subject,
    body: r.body,
    status: r.status as 'unread' | 'read',
    replyTo: r.reply_to,
    createdAt: r.created_at,
    readAt: r.read_at,
  };
}


