import { mkdir, readFile, readdir, rename, writeFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { FactoryError, type CommandDefinition, type HarnessModule } from '@mf/core';
import { Workspace } from './workspace.js';
import { DisabledDriver, type SandboxDriver } from './sandbox.js';

export interface CodingHarnessOptions {
  workspace: Workspace;
  /**
   * Sandbox driver for shell.exec. Defaults to DisabledDriver: a factory must
   * opt in to shell execution explicitly.
   */
  sandbox?: SandboxDriver;
  /** Max bytes a single fs.read may return. */
  maxReadBytes?: number;
  /** Max bytes fs.write may accept. */
  maxWriteBytes?: number;
  /** Default timeout for shell commands. */
  shellTimeoutMs?: number;
  /**
   * Whether shell.exec requires a human gate. Default TRUE (spec requirement):
   * shell is the highest-risk capability and the local driver cannot confine
   * the filesystem.
   */
  shellRequiresGate?: boolean;
}

const ReadInput = z.object({
  path: z.string().min(1),
  /** Optional line window, 0-based. */
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
});

const WriteInput = z.object({
  path: z.string().min(1),
  content: z.string(),
  /** Create parent directories. Off by default so a typo fails loudly. */
  createDirs: z.boolean().default(false),
});

const EditInput = z.object({
  path: z.string().min(1),
  oldText: z.string().min(1),
  newText: z.string(),
  /** Replace every occurrence instead of requiring uniqueness. */
  replaceAll: z.boolean().default(false),
});

const ListInput = z.object({
  path: z.string().default('.'),
  recursive: z.boolean().default(false),
  maxEntries: z.number().int().min(1).max(5000).default(200),
});

const ExecInput = z.object({
  command: z.string().min(1).max(4000),
  cwd: z.string().default('.'),
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
});

export function createCodingHarness(opts: CodingHarnessOptions): HarnessModule {
  const ws = opts.workspace;
  const sandbox = opts.sandbox ?? new DisabledDriver();
  const maxRead = opts.maxReadBytes ?? 1_000_000;
  const maxWrite = opts.maxWriteBytes ?? 1_000_000;
  const shellTimeout = opts.shellTimeoutMs ?? 120_000;
  const gated = opts.shellRequiresGate ?? true;

  const read: CommandDefinition<typeof ReadInput> = {
    name: 'fs.read',
    description: 'Read a text file inside the workspace. Optional offset/limit select a line window.',
    inputSchema: ReadInput,
    allowedActors: ['human', 'lead', 'specialist'],
    idempotent: true,
    async execute(input) {
      const abs = await ws.resolveSafe(input.path);
      const info = await stat(abs).catch(() => null);
      if (!info || !info.isFile()) throw new FactoryError(`Not a file: ${input.path}`, 'NOT_A_FILE', 404);
      if (info.size > maxRead) {
        throw new FactoryError(
          `File is ${info.size} bytes, above the ${maxRead} byte read limit. Use offset/limit.`,
          'FILE_TOO_LARGE',
          413,
        );
      }
      const raw = await readFile(abs, 'utf8');
      if (input.offset === undefined && input.limit === undefined) {
        return { path: ws.display(abs), content: raw, lines: raw.split('\n').length };
      }
      const all = raw.split('\n');
      const start = input.offset ?? 0;
      const end = start + (input.limit ?? 200);
      const slice = all.slice(start, end);
      return {
        path: ws.display(abs),
        content: slice.join('\n'),
        totalLines: all.length,
        offset: start,
        limit: slice.length,
      };
    },
  };

  const write: CommandDefinition<typeof WriteInput> = {
    name: 'fs.write',
    description: 'Write a text file inside the workspace, replacing its contents.',
    inputSchema: WriteInput,
    allowedActors: ['human', 'lead', 'specialist'],
    // Overwrites content: a crash mid-write means the previous content may be
    // gone, so replaying is not safe without a human looking.
    idempotent: false,
    async execute(input) {
      const abs = await ws.resolveSafe(input.path);
      if (Buffer.byteLength(input.content, 'utf8') > maxWrite) {
        throw new FactoryError(`Content exceeds the ${maxWrite} byte write limit`, 'CONTENT_TOO_LARGE', 413);
      }
      if (input.createDirs) await mkdir(dirname(abs), { recursive: true });
      // Atomic-ish: write to a temp file then rename, so a crash leaves either
      // the old file or the new one, never a half-written file.
      const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, input.content, 'utf8');
      await rename(tmp, abs);
      return { path: ws.display(abs), bytes: Buffer.byteLength(input.content, 'utf8') };
    },
  };

  const edit: CommandDefinition<typeof EditInput> = {
    name: 'fs.edit',
    description: 'Replace exact text in a workspace file. Fails if the text is absent or ambiguous.',
    inputSchema: EditInput,
    allowedActors: ['human', 'lead', 'specialist'],
    idempotent: false,
    async execute(input) {
      const abs = await ws.resolveSafe(input.path);
      const original = await readFile(abs, 'utf8').catch(() => {
        throw new FactoryError(`File not found: ${input.path}`, 'NOT_FOUND', 404);
      });
      const occurrences = original.split(input.oldText).length - 1;
      if (occurrences === 0) {
        throw new FactoryError(`oldText not found in ${input.path}`, 'EDIT_NO_MATCH', 409);
      }
      if (occurrences > 1 && !input.replaceAll) {
        throw new FactoryError(
          `oldText appears ${occurrences} times in ${input.path}; pass replaceAll or be more specific`,
          'EDIT_AMBIGUOUS',
          409,
        );
      }
      const next = input.replaceAll
        ? original.split(input.oldText).join(input.newText)
        : original.replace(input.oldText, input.newText);
      const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, next, 'utf8');
      await rename(tmp, abs);
      return { path: ws.display(abs), replaced: input.replaceAll ? occurrences : 1 };
    },
  };

  const list: CommandDefinition<typeof ListInput> = {
    name: 'fs.list',
    description: 'List a directory inside the workspace.',
    inputSchema: ListInput,
    allowedActors: ['human', 'lead', 'specialist'],
    idempotent: true,
    async execute(input) {
      const abs = await ws.resolveSafe(input.path);
      const out: Array<{ name: string; type: 'file' | 'dir'; size?: number }> = [];

      async function walk(dir: string, depth: number): Promise<void> {
        if (out.length >= input.maxEntries) return;
        const entries = await readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (out.length >= input.maxEntries) return;
          const full = `${dir}/${e.name}`;
          if (e.isDirectory()) {
            out.push({ name: ws.display(full), type: 'dir' });
            if (input.recursive && depth < 6) await walk(full, depth + 1);
          } else if (e.isFile()) {
            const s = await stat(full).catch(() => null);
            out.push({ name: ws.display(full), type: 'file', size: s?.size });
          }
        }
      }

      await walk(abs, 0);
      return { path: ws.display(abs), entries: out, truncated: out.length >= input.maxEntries };
    },
  };

  const exec: CommandDefinition<typeof ExecInput> = {
    name: 'shell.exec',
    description:
      'Run a shell command inside the workspace. Requires explicit human approval before it runs.',
    inputSchema: ExecInput,
    allowedActors: ['human', 'lead'],
    idempotent: false,
    requiresGate: gated,
    async execute(input) {
      const cwdAbs = await ws.resolveSafe(input.cwd);
      const res = await sandbox.exec({
        command: input.command,
        cwd: cwdAbs,
        timeoutMs: input.timeoutMs ?? shellTimeout,
        env: {},
      });
      return {
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        timedOut: res.timedOut,
        durationMs: res.durationMs,
        driver: sandbox.kind,
      };
    },
  };

  return {
    id: 'coding',
    name: 'Coding',
    commands: [read, write, edit, list, exec],
    renderPromptSection(ctx) {
      const lines = [
        '## Coding',
        `All filesystem tools are confined to the factory workspace. Paths outside it are rejected.`,
        'Prefer fs.read before fs.edit; fs.edit requires exact unique text.',
      ];
      if (ctx.toolNames.includes('shell.exec')) {
        lines.push(
          gated
            ? 'shell.exec PAUSES the run for human approval. Only propose commands you can justify.'
            : 'shell.exec runs immediately. It cannot confine the filesystem: be conservative.',
        );
      }
      return lines.join('\n');
    },
  };
}

export { Workspace } from './workspace.js';
export { PathEscapeError } from './workspace.js';
export type { SandboxDriver, SandboxExecRequest, SandboxExecResult } from './sandbox.js';
export { LocalProcessDriver, DisabledDriver } from './sandbox.js';
