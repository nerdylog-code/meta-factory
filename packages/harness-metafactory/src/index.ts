import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, cpSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  FactoryConfigSchema,
  FactoryError,
  NotFoundError,
  openDb,
  type CommandDefinition,
  type Db,
  type HarnessModule,
} from '@mf/core';

/**
 * MetaFactory: the factory that manages factories.
 *
 * Two operations, both of which touch the filesystem, so both are deliberate:
 *
 *  - `factory.spinUp` creates `factories/<name>/` with a `factory.config.ts`,
 *    its own `state.db`, and an allocated port. A thin factory is config, never
 *    a copy of the engine.
 *  - `module.promote` promotes a validated local module into a versioned
 *    `packages/harness-<name>` so its improvements reach every factory through
 *    the workspace instead of being copy-pasted. It requires human approval:
 *    promoting code changes the shared engine, which is exactly the kind of
 *    decision the spec reserves for a person.
 */

const PORT_RANGE_START = 4970;

export const SpinUpInput = z.object({
  name: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes only'),
  title: z.string().min(1).max(120),
  description: z.string().max(500).default(''),
  harnesses: z.array(z.enum(['notes', 'coding', 'pages', 'settings', 'subagents', 'proactive', 'teams', 'mailbox'])).min(1),
  tier: z.enum(['S+', 'S', 'A', 'B', 'C', 'D']).default('S'),
  budgetUsd: z.number().positive().max(1000).default(5),
});

export const PromoteInput = z.object({
  factory: z.string().min(1),
  /** Module name inside that factory, e.g. `harnesses/reporting`. */
  module: z.string().min(1).max(200),
  packageName: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes only'),
  changelog: z.string().min(10).max(4000),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'semver, e.g. 0.1.0').default('0.1.0'),
});

export interface FactoryManifest {
  name: string;
  title: string;
  description: string;
  port: number;
  pageStagePort: number;
  tier: string;
  budgetUsd: number;
  harnesses: string[];
  workspaceRoot: string;
  agents: Array<{ id: string; role: string; name: string; prompt: string }>;
}

export class MetaFactory {
  constructor(private readonly root: string) {}

  get factoriesDir(): string {
    return join(this.root, 'factories');
  }

  listFactories(): Array<{ name: string; title: string; dir: string }> {
    if (!existsSync(this.factoriesDir)) return [];
    const out: Array<{ name: string; title: string; dir: string }> = [];
    for (const entry of readdirSync(this.factoriesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(this.factoriesDir, entry.name);
      const cfg = join(dir, 'factory.config.ts');
      if (!existsSync(cfg)) continue;
      const raw = readFileSync(cfg, 'utf8');
      // Accept both quote styles: hand-written configs use single quotes, the
      // generator uses JSON.stringify (double). Parsing only one silently
      // showed the folder name as the title.
      const title = /title:\s*(['"])(.*?)\1/.exec(raw)?.[2] ?? entry.name;
      out.push({ name: entry.name, title, dir });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Next free port, avoiding anything already used by an existing config. */
  nextPort(): number {
    const used = new Set<number>();
    for (const f of this.listFactories()) {
      const raw = readFileSync(join(f.dir, 'factory.config.ts'), 'utf8');
      for (const m of raw.matchAll(/port:\s*(\d+)/g)) used.add(Number(m[1]));
    }
    let port = PORT_RANGE_START;
    while (used.has(port) || used.has(port + 1)) port += 2;
    return port;
  }

  /**
   * Creates a thin factory on disk. Returns its manifest and the files written.
   * Refuses to overwrite an existing factory: silent clobbering of someone's
   * state.db is unrecoverable.
   */
  spinUp(input: z.infer<typeof SpinUpInput> & { port?: number }): {
    manifest: FactoryManifest;
    dir: string;
    files: string[];
    port: number;
  } {
    const dir = join(this.factoriesDir, input.name);
    if (existsSync(dir)) {
      throw new FactoryError(`Factory '${input.name}' already exists at ${dir}`, 'FACTORY_EXISTS', 409);
    }
    const port = input.port ?? this.nextPort();
    const pageStagePort = port + 1;

    const manifest: FactoryManifest = {
      name: input.name,
      title: input.title,
      description: input.description,
      port,
      pageStagePort,
      tier: input.tier,
      budgetUsd: input.budgetUsd,
      harnesses: input.harnesses,
      workspaceRoot: './workspace',
      agents: [{ id: 'lead', role: 'lead', name: 'Lead', prompt: `You lead the ${input.title} factory.` }],
    };

    // Validate through the same schema the loader uses, so a spun-up factory
    // cannot be born broken.
    FactoryConfigSchema.parse({
      name: manifest.name,
      title: manifest.title,
      description: manifest.description,
      port: manifest.port,
      pageStagePort: manifest.pageStagePort,
      budgetUsd: manifest.budgetUsd,
      tier: manifest.tier,
      harnesses: manifest.harnesses,
      workspaceRoot: manifest.workspaceRoot,
      agents: manifest.agents,
    });

    mkdirSync(dir, { recursive: true });
    const files: string[] = [];

    const cfgPath = join(dir, 'factory.config.ts');
    writeFileSync(cfgPath, renderConfig(manifest), 'utf8');
    files.push(cfgPath);

    const pkgPath = join(dir, 'package.json');
    writeFileSync(
      pkgPath,
      `${JSON.stringify(
        {
          name: `@mf/factory-${manifest.name}`,
          version: '0.1.0',
          private: true,
          type: 'module',
          description: `Factory '${manifest.title}': configuration only, no engine code.`,
          dependencies: { '@mf/core': 'workspace:*' },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    files.push(pkgPath);

    // The state database is created eagerly in WAL mode so the factory is
    // runnable the moment it is listed.
    const dbPath = join(dir, 'state.db');
    const db: Db = openDb({ path: dbPath });
    db.close();
    files.push(dbPath);

    mkdirSync(join(dir, 'workspace'), { recursive: true });
    files.push(join(dir, 'workspace'));

    const readmePath = join(dir, 'README.md');
    writeFileSync(
      readmePath,
      `# ${manifest.title}\n\n${manifest.description || 'Spawned by the MetaFactory.'}\n\n` +
        `- port: ${manifest.port}\n- page stage: ${manifest.pageStagePort}\n- harnesses: ${manifest.harnesses.join(', ')}\n\n` +
        `Run with \`MF_FACTORY=${manifest.name} pnpm --filter @mf/app dev\`.\n`,
      'utf8',
    );
    files.push(readmePath);

    return { manifest, dir, files: files.map((f) => relative(this.root, f)), port };
  }

  /**
   * Promotes a validated module into a versioned shared package.
   *
   * Copies, then writes a changelog entry, then rewrites the package manifest.
   * Refuses to overwrite an existing package version so history is never
   * silently replaced.
   */
  promote(input: z.infer<typeof PromoteInput>): {
    packageDir: string;
    version: string;
    changelogPath: string;
    files: string[];
  } {
    const factoryDir = join(this.factoriesDir, input.factory);
    if (!existsSync(factoryDir)) {
      throw new NotFoundError(`Factory '${input.factory}' not found`);
    }
    const sourceDir = resolve(factoryDir, input.module);
    // Confinement: a promotion must not reach outside its own factory.
    const relToFactory = relative(resolve(factoryDir), sourceDir);
    if (relToFactory.startsWith('..')) {
      throw new FactoryError(
        `Module path escapes factory '${input.factory}': ${input.module}`,
        'MODULE_OUTSIDE_FACTORY',
        403,
      );
    }
    if (!existsSync(sourceDir)) {
      throw new NotFoundError(`Module '${input.module}' not found in factory '${input.factory}'`);
    }

    const packageDir = join(this.root, 'packages', `harness-${input.packageName}`);
    const packageJsonPath = join(packageDir, 'package.json');
    if (existsSync(packageJsonPath)) {
      const existing = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
      if (existing.version === input.version) {
        throw new FactoryError(
          `packages/harness-${input.packageName}@${input.version} already exists; bump the version`,
          'VERSION_EXISTS',
          409,
        );
      }
    }

    mkdirSync(packageDir, { recursive: true });
    const files: string[] = [];

    // Copy the module's sources into src/.
    const dest = join(packageDir, 'src');
    cpSync(sourceDir, dest, { recursive: true });
    files.push(relative(this.root, dest));

    writeFileSync(
      packageJsonPath,
      `${JSON.stringify(
        {
          name: `@mf/harness-${input.packageName}`,
          version: input.version,
          private: true,
          type: 'module',
          main: './dist/index.js',
          types: './dist/index.d.ts',
          exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
          scripts: { build: 'tsc -p tsconfig.build.json' },
          dependencies: { '@mf/core': 'workspace:*', zod: '^4.6.7' },
          mf: { promotedFrom: `${input.factory}/${input.module}` },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    files.push(relative(this.root, packageJsonPath));

    // A promoted module needs the same build config as any other package.
    const baseTsconfig = readFileSync(join(this.root, 'packages', 'core', 'tsconfig.build.json'), 'utf8');
    const tsconfigPath = join(packageDir, 'tsconfig.build.json');
    writeFileSync(tsconfigPath, baseTsconfig, 'utf8');
    files.push(relative(this.root, tsconfigPath));

    const changelogDir = join(packageDir, 'CHANGELOG');
    mkdirSync(changelogDir, { recursive: true });
    const changelogPath = join(changelogDir, `${input.version}.md`);
    writeFileSync(
      changelogPath,
      `# @mf/harness-${input.packageName} ${input.version}\n\n` +
        `Promoted from \`${input.factory}/${input.module}\` by the MetaFactory.\n\n` +
        `${input.changelog}\n\nYou are now using the workspace package; the local module can be deleted.\n`,
      'utf8',
    );
    files.push(relative(this.root, changelogPath));

    // Rewrite the factory config so it consumes the package instead of its
    // local module — the "backport" step of Compounding Engineering.
    const cfgPath = join(factoryDir, 'factory.config.ts');
    if (existsSync(cfgPath)) {
      const raw = readFileSync(cfgPath, 'utf8');
      if (!raw.includes(`@mf/harness-${input.packageName}`)) {
        const patched = raw.replace(
          /(import \{ defineFactory \} from '@mf\/core';\n)/,
          `$1import harness${pascal(input.packageName)} from '@mf/harness-${input.packageName}';\n`,
        );
        writeFileSync(cfgPath, patched, 'utf8');
        files.push(relative(this.root, cfgPath));
      }
    }

    return { packageDir, version: input.version, changelogPath, files };
  }
}

function pascal(s: string): string {
  return s
    .split(/[-_]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

function renderConfig(m: FactoryManifest): string {
  return `import { defineFactory } from '@mf/core';

/**
 * ${m.title} — configuration only. No engine code lives here.
 * Generated by the MetaFactory (factory.spinUp).
 */
export default defineFactory({
  name: '${m.name}',
  title: ${JSON.stringify(m.title)},
  description: ${JSON.stringify(m.description)},
  port: ${m.port},
  pageStagePort: ${m.pageStagePort},
  budgetUsd: ${m.budgetUsd},
  tier: '${m.tier}',
  harnesses: ${JSON.stringify(m.harnesses)},
  workspaceRoot: '${m.workspaceRoot}',
  agents: ${JSON.stringify(m.agents, null, 2).replace(/\n/g, '\n  ')},
});
`;
}

export interface MetaFactoryHarnessOptions {
  /** Repository root that contains factories/ and packages/. */
  root: string;
}

export interface MetaFactoryHarness extends HarnessModule {
  meta: MetaFactory;
}

export function createMetaFactoryHarness(opts: MetaFactoryHarnessOptions): MetaFactoryHarness {
  const meta = new MetaFactory(opts.root);

  const list: CommandDefinition<z.ZodObject<Record<string, never>>> = {
    name: 'meta.listFactories',
    description: 'List every factory in the workspace.',
    inputSchema: z.object({}),
    allowedActors: ['human', 'lead'],
    idempotent: true,
    execute: () => ({ factories: meta.listFactories() }),
  };

  const spinUp: CommandDefinition<typeof SpinUpInput> = {
    name: 'factory.spinUp',
    description:
      'Create a new thin factory: factory.config.ts, its own state.db and an allocated port.',
    inputSchema: SpinUpInput,
    allowedActors: ['human', 'lead'],
    // Creates directories and a database; never replay after a crash.
    idempotent: false,
    execute: (input) => meta.spinUp(input),
  };

  const promote: CommandDefinition<typeof PromoteInput> = {
    name: 'module.promote',
    description:
      'Promote a validated local module from a factory into a versioned packages/harness-<name>. Requires human approval.',
    inputSchema: PromoteInput,
    allowedActors: ['human', 'lead'],
    idempotent: false,
    // Changes shared engine code: the spec reserves this for a human.
    requiresGate: true,
    execute: (input) => meta.promote(input),
  };

  return {
    id: 'metaFactory',
    name: 'MetaFactory',
    meta,
    commands: [list, spinUp, promote],
    renderPromptSection(ctx) {
      if (!ctx.toolNames.includes('factory.spinUp')) return '';
      const count = meta.listFactories().length;
      return [
        '## MetaFactory',
        `This factory manages ${count} factor${count === 1 ? 'y' : 'ies'}.`,
        'factory.spinUp creates a new thin factory (configuration only).',
        'module.promote moves a validated local module into a shared package; a human must approve it.',
        'Promote only after the module has been exercised inside its factory.',
      ].join('\n');
    },
  };
}


