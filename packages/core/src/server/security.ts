import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

/**
 * Ephemeral human credential.
 *
 * - Generated at boot with 32 random bytes.
 * - Lives only in this process's memory: never written to disk, never placed
 *   on `process.env`, never forwarded to a subprocess env.
 * - The UI receives it via the URL fragment, which browsers do not send to the
 *   server, so it cannot leak through server logs or Referer headers.
 */
export class HumanToken {
  readonly value: string;

  constructor(value?: string) {
    this.value = value ?? randomBytes(32).toString('hex');
    if (this.value.length < 32) {
      throw new Error('HUMAN_TOKEN must be at least 32 hex chars');
    }
  }

  /** Constant-time comparison to avoid a timing oracle on token guessing. */
  matches(candidate: string): boolean {
    const a = Buffer.from(this.value, 'utf8');
    const b = Buffer.from(candidate, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** Redacted form for logs and read models. */
  get fingerprint(): string {
    return `${this.value.slice(0, 6)}…${this.value.slice(-4)}`;
  }
}

export interface HostGuardOptions {
  port: number;
  allowedHosts?: string[];
}

/**
 * Anti-DNS-rebinding.
 *
 * A malicious page can point `evil.example` at 127.0.0.1. The browser then
 * sends `Host: evil.example`, even though the request lands on our server.
 * Requiring an exact local host:port defeats that: the attacker cannot make
 * the browser send a Host header we accept unless they control the name
 * `127.0.0.1` itself.
 */
export function hostGuard(opts: HostGuardOptions): MiddlewareHandler {
  const ports = new Set([String(opts.port)]);
  const hosts = new Set(opts.allowedHosts ?? ['127.0.0.1', 'localhost', '[::1]']);

  return async (c, next) => {
    const hostHeader = c.req.header('host');
    if (!hostHeader) {
      return c.json({ error: { code: 'BAD_HOST', message: 'Missing Host header' } }, 403);
    }
    // Host is `name` or `name:port`.
    const lastColon = hostHeader.lastIndexOf(':');
    const hasPort = lastColon > 0 && !hostHeader.endsWith(']');
    const name = hasPort ? hostHeader.slice(0, lastColon) : hostHeader;
    const port = hasPort ? hostHeader.slice(lastColon + 1) : null;

    if (!hosts.has(name.toLowerCase()) || (port !== null && !ports.has(port))) {
      return c.json(
        {
          error: {
            code: 'BAD_HOST',
            message: `Refused Host '${hostHeader}'. This server only answers to ${[...hosts].join(' or ')}:${opts.port}.`,
          },
        },
        403,
      );
    }
    await next();
  };
}

export interface OriginGuardOptions {
  /** Exact allowed UI origins, e.g. `http://127.0.0.1:4960`. */
  allowedOrigins: string[];
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CORS closed to the UI origin + strict Origin validation on mutations.
 *
 * GET is covered by the bearer token and the Host guard. Mutations additionally
 * require an Origin we recognise, so a page on another origin cannot drive the
 * factory even if it somehow has the token.
 */
export function originGuard(opts: OriginGuardOptions): MiddlewareHandler {
  const allowed = new Set(opts.allowedOrigins);

  return async (c, next) => {
    const origin = c.req.header('origin');

    if (c.req.method === 'OPTIONS') {
      if (origin && allowed.has(origin)) {
        return c.body(null, 204, {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
          'access-control-allow-headers': 'authorization,content-type',
          'access-control-max-age': '600',
          vary: 'origin',
        });
      }
      return c.body(null, 403, { vary: 'origin' });
    }

    if (!SAFE_METHODS.has(c.req.method)) {
      if (!origin || !allowed.has(origin)) {
        return c.json(
          {
            error: {
              code: 'BAD_ORIGIN',
              message: origin
                ? `Mutation refused: Origin '${origin}' is not allowed.`
                : 'Mutation refused: missing Origin header.',
            },
          },
          403,
        );
      }
      c.header('access-control-allow-origin', origin);
      c.header('vary', 'origin');
    } else if (origin && allowed.has(origin)) {
      c.header('access-control-allow-origin', origin);
      c.header('vary', 'origin');
    }

    await next();
  };
}

/**
 * Bearer authentication.
 *
 * Only `Authorization: Bearer <token>` is accepted. Query-string tokens are
 * rejected outright (they end up in logs and browser history) — this is why
 * SSE uses `fetch` + ReadableStream on the client instead of EventSource.
 */
export function bearerAuth(token: HumanToken): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.query('token') !== undefined) {
      return c.json(
        {
          error: {
            code: 'TOKEN_IN_QUERY',
            message: 'Tokens are not accepted in the query string. Use the Authorization header.',
          },
        },
        401,
      );
    }
    const header = c.req.header('authorization') ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!m || !m[1]) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing Authorization: Bearer <token>' } }, 401);
    }
    if (!token.matches(m[1])) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }, 401);
    }
    await next();
  };
}

/** Baseline security headers. CSP for the app shell allows no remote origins. */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('x-frame-options', 'DENY');
    c.header('referrer-policy', 'no-referrer');
    c.header('cache-control', 'no-store');
  };
}
