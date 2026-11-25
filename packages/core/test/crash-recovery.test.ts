import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Real crash recovery: a child process writes a `tool_call_started` and then
 * dies. A SECOND process reopens the same SQLite file and recovers.
 *
 * This is deliberately cross-process. An in-process test can pass simply
 * because objects stayed in memory; this one can only pass if the event log on
 * disk is sufficient.
 *
 * Runs against `dist/` (built by the package's `pretest` script) because the
 * child needs ordinary module resolution from a temp cwd.
 */
const dir = mkdtempSync(join(tmpdir(), 'mf-crash-'));
const dbPath = join(dir, 'state.db');
const packageRoot = join(process.cwd(), 'packages', 'core');
// Build inside the package (so node resolves zod/better-sqlite3 by walking up)
// but NOT into dist/ — shared output that other suites and the app rely on.
const buildOut = join(packageRoot, '.test-build-crash', `run-${process.pid}`);
const childPath = join(buildOut, 'dist', 'fixtures', 'crash-child.js');

/**
 * The child needs compiled JS, so build core to a throwaway output dir before
 * spawning. Scoped per process so parallel runs cannot clobber each other.
 */
beforeAll(() => {
  const root = execFileSync(process.execPath, ['-e', 'console.log(process.cwd())'], { encoding: 'utf8' }).trim();
  const tscBin = createRequire(join(root, 'package.json')).resolve('typescript/bin/tsc');
  rmSync(buildOut, { recursive: true, force: true });
  // --tsBuildInfoFile points into the private dir so this build NEVER touches
  // the incremental state used by `pnpm build` (concurrent builds against the
  // same tsbuildinfo produced a spurious suite-load failure once).
  execFileSync(
    process.execPath,
    [
      tscBin,
      '-p',
      'tsconfig.build.json',
      '--outDir',
      join(buildOut, 'dist'),
      '--tsBuildInfoFile',
      join(buildOut, 'build.tsbuildinfo'),
      '--incremental',
      'false',
      '--declaration',
      'false',
      '--declarationMap',
      'false',
      '--composite',
      'false',
    ],
    { cwd: packageRoot, stdio: 'inherit' },
  );
}, 180_000);

function runChild(args: string[]): string {
  return execFileSync(process.execPath, [childPath, ...args], {
    encoding: 'utf8',
    cwd: buildOut,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
}

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* windows may hold the file briefly */
  }
});

describe('crash recovery across processes', () => {
  it('re-executes an idempotent tool that was interrupted by a process death', () => {
    const { runId } = JSON.parse(runChild([dbPath, 'die-after-start', 'fs.read'])) as { runId: string };

    const out = JSON.parse(runChild([dbPath, 'recover', 'fs.read', runId])) as {
      danglingBefore: number;
      danglingAfter: number;
      results: Array<{ status: string }>;
      eventTypes: string[];
    };

    expect(out.danglingBefore).toBe(1);
    expect(out.danglingAfter).toBe(0);
    expect(out.results[0]!.status).toBe('ok');
    expect(out.eventTypes).toContain('tool_call_replayed');
  });

  it('does NOT re-execute a non-idempotent tool and records unknown_after_crash', () => {
    const { runId } = JSON.parse(runChild([dbPath, 'die-after-start', 'notes.create'])) as { runId: string };

    const out = JSON.parse(runChild([dbPath, 'recover', 'notes.create', runId])) as {
      results: Array<{ status: string }>;
      eventTypes: string[];
    };

    expect(out.results[0]!.status).toBe('unknown_after_crash');
    // The safety property: no replay event for a non-idempotent tool.
    expect(out.eventTypes).not.toContain('tool_call_replayed');
  });
});
