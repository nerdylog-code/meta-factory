import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandBus, openDb, type Db } from '@mf/core';
import { createMailboxHarness, type MailboxHarness } from '../src/index.js';

let db: Db;
let bus: CommandBus;
let alpha: MailboxHarness;
let beta: MailboxHarness;

const human = { kind: 'human' } as const;

function makeBus(h: MailboxHarness): CommandBus {
  const b = new CommandBus(db);
  b.registerAll(h.commands);
  return b;
}

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  alpha = createMailboxHarness({ db, factoryId: 'alpha' });
  beta = createMailboxHarness({ db, factoryId: 'beta' });
  bus = makeBus(alpha);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
});

describe('factory-to-factory mail', () => {
  it('alpha sends and beta receives', async () => {
    await bus.dispatch('mailbox.send', { toFactory: 'beta', subject: 'hello', body: 'from alpha' }, human);

    const betaBus = makeBus(beta);
    const res = (await betaBus.dispatch('mailbox.list', {}, human)) as {
      result: { mail: Array<{ subject: string; body: string; status: string }>; unread: number };
    };
    expect(res.result.mail).toHaveLength(1);
    expect(res.result.mail[0]!.subject).toBe('hello');
    expect(res.result.mail[0]!.body).toBe('from alpha');
    expect(res.result.unread).toBe(1);
  });

  it('the sender is resolved from the actor, not the payload', async () => {
    await bus.dispatch('mailbox.send', { toFactory: 'beta', subject: 's', body: 'b', fromFactory: 'forged' }, human);
    const betaBus = makeBus(beta);
    const res = (await betaBus.dispatch('mailbox.list', {}, human)) as {
      result: { mail: Array<{ fromFactory: string }> };
    };
    expect(res.result.mail[0]!.fromFactory).toBe('alpha');
  });

  it('alpha does not see mail addressed to beta', async () => {
    await bus.dispatch('mailbox.send', { toFactory: 'beta', subject: 'private', body: 'x' }, human);
    const res = (await bus.dispatch('mailbox.list', {}, human)) as { result: { mail: unknown[] } };
    expect(res.result.mail).toHaveLength(0);
  });

  it('reading marks the message read exactly once', async () => {
    await bus.dispatch('mailbox.send', { toFactory: 'beta', subject: 's', body: 'b' }, human);
    const betaBus = makeBus(beta);
    const list = (await betaBus.dispatch('mailbox.list', {}, human)) as {
      result: { mail: Array<{ id: string }> };
    };
    const id = list.result.mail[0]!.id;

    const first = (await betaBus.dispatch('mailbox.read', { id }, human)) as {
      result: { mail: { status: string; readAt: number | null } };
    };
    expect(first.result.mail.status).toBe('read');
    expect(first.result.mail.readAt).toBeTypeOf('number');

    const again = (await betaBus.dispatch('mailbox.read', { id }, human)) as {
      result: { mail: { status: string; readAt: number | null } };
    };
    expect(again.result.mail.status).toBe('read');
    // readAt is not bumped on a second read.
    expect(again.result.mail.readAt).toBe(first.result.mail.readAt);
  });

  it('alpha cannot read a message addressed to beta', async () => {
    await bus.dispatch('mailbox.send', { toFactory: 'beta', subject: 's', body: 'b' }, human);
    const betaBus = makeBus(beta);
    const list = (await betaBus.dispatch('mailbox.list', {}, human)) as { result: { mail: Array<{ id: string }> } };
    const id = list.result.mail[0]!.id;

    // 404, not 403: do not confirm the message exists to a foreign factory.
    await expect(bus.dispatch('mailbox.read', { id }, human)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a factory cannot mail itself', async () => {
    await expect(
      bus.dispatch('mailbox.send', { toFactory: 'alpha', subject: 's', body: 'b' }, human),
    ).rejects.toMatchObject({ code: 'SELF_MAIL' });
  });

  it('filters by unread', async () => {
    await bus.dispatch('mailbox.send', { toFactory: 'beta', subject: 'one', body: 'b' }, human);
    await bus.dispatch('mailbox.send', { toFactory: 'beta', subject: 'two', body: 'b' }, human);
    const betaBus = makeBus(beta);
    const list = (await betaBus.dispatch('mailbox.list', {}, human)) as { result: { mail: Array<{ id: string }> } };
    await betaBus.dispatch('mailbox.read', { id: list.result.mail[0]!.id }, human);

    const unread = (await betaBus.dispatch('mailbox.list', { status: 'unread' }, human)) as {
      result: { mail: unknown[] };
    };
    expect(unread.result.mail).toHaveLength(1);
    const read = (await betaBus.dispatch('mailbox.list', { status: 'read' }, human)) as {
      result: { mail: unknown[] };
    };
    expect(read.result.mail).toHaveLength(1);
  });

  it('a reply references the original', async () => {
    await bus.dispatch('mailbox.send', { toFactory: 'beta', subject: 'q', body: 'question' }, human);
    const betaBus = makeBus(beta);
    const list = (await betaBus.dispatch('mailbox.list', {}, human)) as { result: { mail: Array<{ id: string }> } };
    const original = list.result.mail[0]!.id;

    const reply = (await betaBus.dispatch(
      'mailbox.send',
      { toFactory: 'alpha', subject: 're: q', body: 'answer', replyTo: original },
      human,
    )) as { result: { mail: { replyTo: string } } };
    expect(reply.result.mail.replyTo).toBe(original);
  });

  it('the prompt section reports the unread count', async () => {
    await bus.dispatch('mailbox.send', { toFactory: 'beta', subject: 's', body: 'b' }, human);
    const section = beta.renderPromptSection({ actor: human, toolNames: ['mailbox.list'], factoryName: 'beta' });
    expect(section).toContain('1 unread');
  });

  it('specialists can read the mailbox but cannot send', () => {
    const tools = bus.listToolsForActor('specialist').map((t) => t.name);
    expect(tools).toContain('mailbox.list');
    expect(tools).not.toContain('mailbox.send');
  });
});
