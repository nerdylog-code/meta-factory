import { spawn } from 'node:child_process';
import { FactoryError } from '@mf/core';

export interface SandboxExecRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
  env: Record<string, string>;
}

export interface SandboxExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Pluggable execution driver.
 *
 * The engine never calls `child_process` directly for agent-issued commands;
 * it goes through a driver so a real sandbox (container, bwrap, Windows Job
 * Object, seccomp) can be dropped in without touching the harness.
 */
export interface SandboxDriver {
  readonly kind: string;
  exec(req: SandboxExecRequest): Promise<SandboxExecResult>;
}

/**
 * Minimal local driver: runs in a child process with a scrubbed environment and
 * a hard timeout.
 *
 * What it guarantees:
 *  - the child env is built from an allowlist, so HUMAN_TOKEN and every other
 *    secret in the parent environment cannot leak into agent-driven commands;
 *  - the process group is killed on timeout (no orphaned children).
 *
 * What it does NOT guarantee: filesystem confinement. That is why the coding
 * harness marks `shell.exec` as gated by default — a human decides.
 */
export class LocalProcessDriver implements SandboxDriver {
  readonly kind = 'local-process';

  constructor(
    /** Environment variable names that may be passed through. */
    private readonly passthrough: string[] = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'SHELL', 'COMSPEC', 'PATHEXT'],
  ) {}

  async exec(req: SandboxExecRequest): Promise<SandboxExecResult> {
    const started = Date.now();
    const env: Record<string, string> = {};
    for (const key of this.passthrough) {
      const v = process.env[key];
      if (v !== undefined) env[key] = v;
    }
    // Explicit request env wins, but never as `HUMAN_TOKEN`: that name is
    // reserved and dropped even if a caller passes it.
    for (const [k, v] of Object.entries(req.env)) {
      if (k.toUpperCase().includes('HUMAN_TOKEN')) continue;
      env[k] = v;
    }

    return new Promise<SandboxExecResult>((resolve) => {
      const isWindows = process.platform === 'win32';
      const child = spawn(req.command, {
        cwd: req.cwd,
        env,
        shell: isWindows ? 'cmd.exe' : '/bin/sh',
        windowsHide: true,
        // Own process group on POSIX so a timeout can kill the whole tree.
        detached: !isWindows,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const MAX = 256 * 1024;
      child.stdout.on('data', (d: Buffer) => {
        if (stdout.length < MAX) stdout += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        if (stderr.length < MAX) stderr += d.toString();
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (isWindows) {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
          } else if (child.pid) {
            process.kill(-child.pid, 'SIGKILL');
          }
        } catch {
          /* already gone */
        }
        child.kill('SIGKILL');
      }, req.timeoutMs);

      const done = (exitCode: number | null) => {
        clearTimeout(timer);
        resolve({
          exitCode,
          stdout: truncate(stdout),
          stderr: truncate(stderr),
          timedOut,
          durationMs: Date.now() - started,
        });
      };

      child.on('error', (err) => {
        stderr += `\n[sandbox] spawn failed: ${err.message}`;
        done(null);
      });
      child.on('close', (code) => done(code));
    });
  }
}

function truncate(s: string): string {
  const LIMIT = 20_000;
  if (s.length <= LIMIT) return s;
  return `${s.slice(0, LIMIT)}\n…[truncated ${s.length - LIMIT} chars]`;
}

/** Driver that refuses everything; used when no sandbox is configured. */
export class DisabledDriver implements SandboxDriver {
  readonly kind = 'disabled';
  async exec(): Promise<SandboxExecResult> {
    throw new FactoryError(
      'No sandbox driver is configured; shell.exec is unavailable in this factory.',
      'SANDBOX_DISABLED',
      503,
    );
  }
}
