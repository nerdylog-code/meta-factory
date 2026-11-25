import { describe, expect, it } from 'vitest';
import {
  ChannelIdentitySchema,
  ChannelPrincipalRegistry,
  validateGateReply,
  type ChannelAdapter,
  type InboundMessage,
  type OutboundEvent,
} from '../src/channels/types.js';

const identity = (externalId: string, channel: 'whatsapp' | 'telegram' = 'whatsapp') =>
  ChannelIdentitySchema.parse({ channel, externalId });

describe('channel principal registry', () => {
  it('resolves an allowed identity to a human actor', () => {
    const reg = new ChannelPrincipalRegistry().allow('whatsapp', ['+55 11 99999-0000']);
    const actor = reg.resolve(identity('+5511999990000'));
    expect(actor).toEqual({ kind: 'human' });
  });

  it('normalises phone formatting so +55 11 9... matches 55119...', () => {
    const reg = new ChannelPrincipalRegistry().allow('whatsapp', ['5511999990000']);
    expect(reg.isAllowed(identity('+55 (11) 99999-0000'))).toBe(true);
  });

  it('an empty allowlist means NOBODY, never everybody', () => {
    const reg = new ChannelPrincipalRegistry();
    expect(reg.resolve(identity('+5511999990000'))).toBeNull();
    expect(reg.isAllowed(identity('+5511999990000'))).toBe(false);
  });

  it('an unknown number is refused', () => {
    const reg = new ChannelPrincipalRegistry().allow('whatsapp', ['+5511999990000']);
    expect(reg.resolve(identity('+5511888880000'))).toBeNull();
  });

  it('allowlists are per channel: a number allowed on whatsapp is not allowed on telegram', () => {
    const reg = new ChannelPrincipalRegistry().allow('whatsapp', ['+5511999990000']);
    expect(reg.isAllowed(identity('+5511999990000', 'whatsapp'))).toBe(true);
    expect(reg.isAllowed(identity('+5511999990000', 'telegram'))).toBe(false);
  });

  it('allow() can be called repeatedly to accumulate ids', () => {
    const reg = new ChannelPrincipalRegistry()
      .allow('whatsapp', ['+5511999990000'])
      .allow('whatsapp', ['+5511888880000']);
    expect(reg.isAllowed(identity('+5511999990000'))).toBe(true);
    expect(reg.isAllowed(identity('+5511888880000'))).toBe(true);
  });
});

describe('gate reply validation', () => {
  const expected = { gateId: 'gate-1', approvalToken: 'tok-abc' };

  it('accepts the correct gate and token', () => {
    const res = validateGateReply({
      reply: { gateId: 'gate-1', decision: 'approve' },
      expected,
      providedToken: 'tok-abc',
    });
    expect(res.ok).toBe(true);
  });

  it('rejects when there is no pending approval', () => {
    const res = validateGateReply({
      reply: { gateId: 'gate-1', decision: 'approve' },
      expected: null,
      providedToken: 'tok-abc',
    });
    expect(res.ok).toBe(false);
  });

  it('rejects a reply naming a different gate', () => {
    const res = validateGateReply({
      reply: { gateId: 'gate-2', decision: 'approve' },
      expected,
      providedToken: 'tok-abc',
    });
    expect(res).toMatchObject({ ok: false, reason: expect.stringContaining('different gate') });
  });

  it('rejects a missing token', () => {
    const res = validateGateReply({
      reply: { gateId: 'gate-1', decision: 'approve' },
      expected,
      providedToken: undefined,
    });
    expect(res).toMatchObject({ ok: false, reason: expect.stringContaining('token') });
  });

  it('rejects a wrong token (a forwarded screenshot cannot approve)', () => {
    const res = validateGateReply({
      reply: { gateId: 'gate-1', decision: 'approve' },
      expected,
      providedToken: 'guess',
    });
    expect(res.ok).toBe(false);
  });

  it('rejection replies need the same token discipline', () => {
    const res = validateGateReply({
      reply: { gateId: 'gate-1', decision: 'reject', reason: 'not now' },
      expected,
      providedToken: 'tok-abc',
    });
    expect(res.ok).toBe(true);
  });
});

describe('ChannelAdapter contract', () => {
  /** A minimal in-memory adapter: proves the interface is implementable
   * without touching core. */
  class MemoryChannel implements ChannelAdapter<{ account: string }> {
    readonly kind = 'custom' as const;
    readonly name = 'memory';
    sent: OutboundEvent[] = [];
    private handler: ((m: InboundMessage) => Promise<void>) | null = null;
    started = false;
    config: { account: string } | null = null;

    async configure(config: { account: string }): Promise<void> {
      this.config = config;
    }
    async start(): Promise<void> {
      this.started = true;
    }
    async stop(): Promise<void> {
      this.started = false;
    }
    async send(event: OutboundEvent): Promise<{ delivered: boolean }> {
      if (!this.started) return { delivered: false, error: 'not started' };
      this.sent.push(event);
      return { delivered: true };
    }
    onInbound(handler: (m: InboundMessage) => Promise<void>): void {
      this.handler = handler;
    }
    /** Simulates the outside world sending a message. */
    async receive(msg: InboundMessage): Promise<void> {
      if (!this.handler) throw new Error('no inbound handler registered');
      await this.handler(msg);
    }
  }

  it('satisfies the contract end to end', async () => {
    const ch = new MemoryChannel();
    await ch.configure({ account: 'factory-bot' });
    expect(ch.started).toBe(false);

    // Sending before start fails honestly.
    expect(await ch.send({ type: 'notification', level: 'info', text: 'x', to: identity('+5511999990000') })).toEqual({
      delivered: false,
      error: 'not started',
    });

    const received: InboundMessage[] = [];
    ch.onInbound(async (m) => {
      received.push(m);
    });
    await ch.start();

    await ch.receive({
      identity: identity('+5511999990000'),
      text: 'status?',
      conversationId: 'c1',
      receivedAt: Date.now(),
    });
    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe('status?');

    const res = await ch.send({
      type: 'approval_required',
      gate: { status: 'pending_approval', gateId: 'g1', commandName: 'notes.delete', inputPreview: '{"id":"n1"}' },
      approvalToken: 'tok',
      to: identity('+5511999990000'),
    });
    expect(res.delivered).toBe(true);
    expect(ch.sent[0]!.type).toBe('approval_required');
  });

  it('an inbound gate reply carries the decision and is validated separately', () => {
    const msg: InboundMessage = {
      identity: identity('+5511999990000'),
      text: 'APPROVE tok-abc',
      conversationId: 'c1',
      receivedAt: Date.now(),
      gateReply: { gateId: 'gate-1', decision: 'approve' },
    };
    const res = validateGateReply({
      reply: msg.gateReply!,
      expected: { gateId: 'gate-1', approvalToken: 'tok-abc' },
      providedToken: 'tok-abc',
    });
    expect(res.ok).toBe(true);
  });

  it('the identity schema rejects an empty external id', () => {
    expect(ChannelIdentitySchema.safeParse({ channel: 'whatsapp', externalId: '' }).success).toBe(false);
    expect(ChannelIdentitySchema.safeParse({ channel: 'carrier-pigeon', externalId: 'x' }).success).toBe(false);
  });
});
