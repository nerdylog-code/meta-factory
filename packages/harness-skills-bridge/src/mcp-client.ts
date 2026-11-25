import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { FactoryError, type ToolDescriptor } from '@mf/core';

/**
 * Minimal MCP (Model Context Protocol) client over stdio.
 *
 * Why hand-rolled instead of an SDK: the factory needs exactly three things
 * (initialize, tools/list, tools/call) and must control the process lifecycle
 * itself. An SDK that owns the transport also owns the failure modes.
 *
 * Transport: newline-delimited JSON-RPC 2.0 on the child's stdio. Each request
 * carries an incrementing id; responses are matched by id. A request that never
 * answers is rejected on timeout so a wedged server cannot hang a run.
 */

export interface McpStdioOptions {
  /** Command to spawn, e.g. `npx` or `node`. */
  command: string;
  args?: string[];
  /** Environment for the child. Callers must pass an ALLOWLIST: never the
   * HUMANT TOKEN or any other parent secret. */
  env?: Record<string, string>;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
  /** Handshake deadline. */
  initTimeoutMs?: number;
  clientName?: string;
}

export interface McpToolInfo extends ToolDescriptor {
  /** Server that exposed it. */
  server: string;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: unknown;
}

export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private initialized = false;
  private stderrTail: string[] = [];

  constructor(private readonly opts: McpStdioOptions) {}

  get running(): boolean {
    return this.child !== null;
  }

  /** Recent stderr from the server, for diagnostics when a call fails. */
  get diagnostics(): string {
    return this.stderrTail.slice(-20).join('\n');
  }

  async start(): Promise<void> {
    if (this.child) return;
    const env = { ...(this.opts.env ?? {}) };
    // Defence in depth: even if a caller passes the whole environment, the
    // human token can never reach an external MCP server.
    for (const key of Object.keys(env)) {
      if (key.toUpperCase().includes('HUMAN_TOKEN')) delete env[key];
    }

    const child = spawn(this.opts.command, this.opts.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
      shell: false,
    });
    this.child = child;

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this.onLine(line));

    const errRl = createInterface({ input: child.stderr });
    errRl.on('line', (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
    });

    child.on('exit', (code) => {
      this.child = null;
      const err = new FactoryError(
        `MCP server exited (code ${code}). ${this.diagnostics}`.trim(),
        'MCP_SERVER_EXITED',
        502,
      );
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    });

    child.on('error', (err) => {
      this.child = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new FactoryError(`MCP server failed to start: ${err.message}`, 'MCP_SPAWN_FAILED', 502));
      }
      this.pending.clear();
    });

    await this.initialize();
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      return; // a server may log to stdout; ignore non-JSON lines
    }
    if (msg.id === undefined) return; // notification (e.g. log message)
    const key = Number(msg.id);
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    clearTimeout(p.timer);
    if (msg.error) {
      p.reject(new FactoryError(`MCP error ${msg.error.code}: ${msg.error.message}`, 'MCP_ERROR', 502));
    } else {
      p.resolve(msg.result);
    }
  }

  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const child = this.child;
    if (!child) {
      return Promise.reject(new FactoryError('MCP client is not running', 'MCP_NOT_RUNNING', 502));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new FactoryError(
            `MCP request '${method}' timed out after ${timeoutMs ?? this.opts.requestTimeoutMs ?? 15_000}ms`,
            'MCP_TIMEOUT',
            504,
          ),
        );
      }, timeoutMs ?? this.opts.requestTimeoutMs ?? 15_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${payload}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new FactoryError(`MCP write failed: ${(err as Error).message}`, 'MCP_WRITE_FAILED', 502));
      }
    });
  }

  private async initialize(): Promise<void> {
    await this.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: this.opts.clientName ?? 'meta-factory', version: '0.1.0' },
      },
      this.opts.initTimeoutMs ?? 15_000,
    );
    // notifications/initialized is a notification: no id, no response.
    this.child?.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    this.initialized = true;
  }

  async listTools(): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>> {
    if (!this.initialized) throw new FactoryError('MCP client is not initialized', 'MCP_NOT_INITIALIZED', 500);
    const res = (await this.request('tools/list', {})) as {
      tools?: Array<{ name?: string; description?: string; inputSchema?: Record<string, unknown> }>;
    };
    return (res.tools ?? []).map((t) => ({
      name: t.name ?? '',
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    }));
  }

  async callTool(name: string, args: unknown): Promise<{ content: unknown; isError: boolean }> {
    const res = (await this.request('tools/call', { name, arguments: args })) as {
      content?: unknown;
      isError?: boolean;
    };
    return { content: res.content ?? null, isError: res.isError === true };
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new FactoryError('MCP client stopped', 'MCP_STOPPED', 502));
    }
    this.pending.clear();
    child.kill();
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}


