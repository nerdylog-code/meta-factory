import { z } from 'zod';
import type { Actor, PendingApproval } from '../types.js';

/**
 * Channel contract for external messaging surfaces (WhatsApp via Baileys or
 * Evolution API, Telegram, Slack, email...).
 *
 * The point of this file is that a channel is a PLUGIN: adding WhatsApp must
 * not change the runner, the bus, or the gate logic. A channel only has to
 * translate between its wire format and the four events below.
 *
 * Design constraints that come from the factory's security model:
 *  - A channel can NEVER approve a gate by itself. `onApprovalRequired` is a
 *    notification; approval arrives as an inbound message carrying a per-gate
 *    token, and the core decides whether that message counts.
 *  - An inbound message must resolve to a known principal. An unknown phone
 *    number is not a `human` actor; it is a rejection.
 */

export const ChannelKindSchema = z.enum(['whatsapp', 'telegram', 'slack', 'email', 'cli', 'custom']);
export type ChannelKind = z.infer<typeof ChannelKindSchema>;

/** Identity of whoever is on the other end of a channel. */
export const ChannelIdentitySchema = z.object({
  channel: ChannelKindSchema,
  /** Channel-native id: phone number, chat id, email address... */
  externalId: z.string().min(1),
  displayName: z.string().max(200).optional(),
});
export type ChannelIdentity = z.infer<typeof ChannelIdentitySchema>;

/** A message arriving from the outside world. */
export interface InboundMessage {
  identity: ChannelIdentity;
  text: string;
  /** Channel-specific conversation id. */
  conversationId: string;
  /** Present when the message is a reply to a gate notification. */
  gateReply?: {
    gateId: string;
    decision: 'approve' | 'reject';
    reason?: string;
  };
  receivedAt: number;
  raw?: unknown;
}

/** Something the factory wants to tell the outside world. */
export type OutboundEvent =
  | {
      type: 'approval_required';
      gate: PendingApproval & { commandName: string; inputPreview: string };
      /** One-time token the human must echo to approve. Never the gate id alone. */
      approvalToken: string;
      to: ChannelIdentity;
    }
  | { type: 'run_finished'; runId: string; status: string; summary: string; to: ChannelIdentity }
  | { type: 'agent_message'; runId: string; text: string; to: ChannelIdentity }
  | { type: 'notification'; level: 'info' | 'warn' | 'error'; text: string; to: ChannelIdentity };

export interface ChannelDeliveryResult {
  delivered: boolean;
  /** Channel-native message id when available. */
  externalMessageId?: string;
  error?: string;
}

/**
 * What a channel implementation must provide.
 *
 * Deliberately tiny: `start`, `stop`, `send`, and a callback registration. Any
 * channel needing more (media, reactions) can expose it through its own
 * interface without widening this contract.
 */
export interface ChannelAdapter<Config = unknown> {
  readonly kind: ChannelKind;
  readonly name: string;
  /** Validates its own configuration at startup. */
  configure(config: Config): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(event: OutboundEvent): Promise<ChannelDeliveryResult>;
  /**
   * Registers the inbound handler. The factory supplies it; the channel merely
   * calls it. A channel must not act on a message before calling this.
   */
  onInbound(handler: (msg: InboundMessage) => Promise<void>): void;
}

/**
 * Resolves a channel identity to an Actor, or refuses.
 *
 * `allowed` is an explicit allowlist of external ids per channel. An empty
 * allowlist means "nobody", never "everybody" — a channel with no configured
 * principals is inert rather than open.
 */
export class ChannelPrincipalRegistry {
  private readonly allowed = new Map<ChannelKind, Set<string>>();

  allow(channel: ChannelKind, externalIds: string[]): this {
    const set = this.allowed.get(channel) ?? new Set<string>();
    for (const id of externalIds) set.add(normalise(id));
    this.allowed.set(channel, set);
    return this;
  }

  resolve(identity: ChannelIdentity): Actor | null {
    const set = this.allowed.get(identity.channel);
    if (!set || !set.has(normalise(identity.externalId))) return null;
    // A channel principal is a HUMAN: they are the person behind the phone.
    // They still cannot bypass ApprovalGate rules the core enforces on commands.
    return { kind: 'human' };
  }

  isAllowed(identity: ChannelIdentity): boolean {
    return this.resolve(identity) !== null;
  }
}

function normalise(id: string): string {
  // Phone numbers arrive with/without '+', spaces and dashes.
  return id.replace(/[\s+\-()]/g, '').toLowerCase();
}

/**
 * Validates an inbound gate reply.
 *
 * Approving requires ALL of:
 *  - the identity is an allowed principal (checked by the caller),
 *  - the reply names a gate that is actually pending,
 *  - the one-time token matches the token issued for THAT gate.
 * A forwarded screenshot of the notification therefore cannot approve anything.
 */
export function validateGateReply(args: {
  reply: NonNullable<InboundMessage['gateReply']>;
  expected: { gateId: string; approvalToken: string } | null;
  providedToken: string | undefined;
}): { ok: true } | { ok: false; reason: string } {
  if (!args.expected) return { ok: false, reason: 'no pending approval for this conversation' };
  if (args.reply.gateId !== args.expected.gateId) {
    return { ok: false, reason: 'reply refers to a different gate' };
  }
  if (!args.providedToken || args.providedToken !== args.expected.approvalToken) {
    return { ok: false, reason: 'missing or incorrect approval token' };
  }
  return { ok: true };
}
