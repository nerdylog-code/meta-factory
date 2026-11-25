import type { RunEvent } from '../runner/events.js';

export interface BrokerClient {
  id: string;
  write(chunk: string): void;
  close(): void;
  /** Optional: forcibly destroy the underlying connection (shutdown path). */
  destroy?(): void;
}

export type BrokerMessage =
  | { kind: 'run_event'; event: RunEvent }
  | { kind: 'tokenomics'; payload: unknown }
  | { kind: 'gate'; payload: unknown }
  | { kind: 'page'; payload: unknown }
  | { kind: 'chat'; payload: unknown }
  | { kind: 'mailbox'; payload: unknown }
  | { kind: 'settings'; payload: unknown }
  | { kind: 'heartbeat'; ts: number };

/**
 * Minimal in-process fan-out for Server-Sent Events.
 *
 * Backpressure policy: a slow client must never block a run. If a write throws
 * or the buffer is marked full, that client is dropped rather than awaiting it.
 */
export class EventBroker {
  private readonly clients = new Map<string, BrokerClient>();
  private seq = 0;

  addClient(opts: { write(chunk: string): void; close(): void; destroy?(): void }): string {
    const id = `c${++this.seq}`;
    this.clients.set(id, { id, ...opts });
    return id;
  }

  removeClient(id: string): void {
    this.clients.delete(id);
  }

  get size(): number {
    return this.clients.size;
  }

  broadcast(msg: BrokerMessage): void {
    if (this.clients.size === 0) return;
    const frame = formatSse(msg);
    for (const [id, client] of [...this.clients]) {
      try {
        client.write(frame);
      } catch (err) {
        // A dead client must never break a run or another client's stream.
        console.warn(`[sse] dropping client ${id}: ${(err as Error).message}`);
        this.clients.delete(id);
        try {
          client.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * Ends every stream. Used on shutdown: an open SSE response keeps the HTTP
   * server listening forever, so this must be called BEFORE server.close().
   */
  closeAll(): void {
    // Snapshot first: a client's close() removes it from the map.
    const clients = [...this.clients.values()];
    this.clients.clear();
    for (const c of clients) {
      // Close gracefully; if the runtime has not released the socket yet,
      // destroy it so server.close() cannot hang.
      try {
        c.close();
      } catch {
        /* ignore */
      }
      try {
        c.destroy?.();
      } catch {
        /* ignore */
      }
    }
  }
}

export function formatSse(msg: BrokerMessage): string {
  const event = msg.kind;
  const data = JSON.stringify(msg.kind === 'heartbeat' ? msg : msg);
  // Multi-line payloads must be split across `data:` lines per the SSE spec.
  const lines = data.split('\n').map((l) => `data: ${l}`).join('\n');
  return `event: ${event}\n${lines}\n\n`;
}
