import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Test against core's SOURCE, not its build output. Otherwise a build
      // step becomes a hidden dependency of the suite, and suites race each
      // other over dist/.
      '@mf/core': r('./packages/core/src/index.ts'),
      '@mf/harness-notes': r('./packages/harness-notes/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    /**
     * THREADS, not forks.
     *
     * better-sqlite3 is a native addon. Under vitest's `forks` pool its
     * connection cleanup runs while the child process isolate is being
     * disposed, which trips a native assertion inside the Statement destructor
     * (`env != nullptr` / `DisposeIsolate`) and kills the worker. The symptom
     * was a random "Worker exited unexpectedly" with a whole file reporting
     * zero tests — reproducible roughly 1 run in 3 before this change, 0 in 30
     * after. Do not switch back to `forks`.
     */
    pool: 'threads',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ['default'],
  },
});
