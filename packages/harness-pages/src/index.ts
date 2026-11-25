import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { FactoryError, NotFoundError, type CommandDefinition, type Db, type HarnessModule } from '@mf/core';
import { PAGE_CSP, assertPageHtmlIsContained, buildPageCsp, wrapPageHtml } from './bridge.js';

export interface PageRow {
  id: string;
  factoryId: string;
  slug: string;
  title: string;
  html: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface PageStoreOptions {
  db: Db;
  factoryId: string;
}

export class PageStore {
  constructor(private readonly opts: PageStoreOptions) {}

  list(): Array<Omit<PageRow, 'html'>> {
    const rows = this.opts.db
      .prepare(`SELECT id, factory_id, slug, title, created_by, created_at, updated_at FROM pages WHERE factory_id = ? ORDER BY updated_at DESC`)
      .all(this.opts.factoryId) as RawPageMeta[];
    return rows.map(mapMeta);
  }

  get(slug: string): PageRow | null {
    const row = this.opts.db
      .prepare(`SELECT * FROM pages WHERE factory_id = ? AND slug = ?`)
      .get(this.opts.factoryId, slug) as RawPage | undefined;
    return row ? mapPage(row) : null;
  }

  create(input: { slug: string; title: string; html: string }, createdBy: string): PageRow {
    assertPageHtmlIsContained(input.html);
    const id = randomUUID();
    const now = Date.now();
    this.opts.db
      .prepare(
        `INSERT INTO pages (id, factory_id, slug, title, html, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(id, this.opts.factoryId, input.slug, input.title, input.html, createdBy, now, now);
    return this.get(input.slug)!;
  }

  update(slug: string, patch: { title?: string; html?: string }): PageRow | null {
    const existing = this.get(slug);
    if (!existing) return null;
    if (patch.html !== undefined) assertPageHtmlIsContained(patch.html);
    this.opts.db
      .prepare(`UPDATE pages SET title = ?, html = ?, updated_at = ? WHERE factory_id = ? AND slug = ?`)
      .run(patch.title ?? existing.title, patch.html ?? existing.html, Date.now(), this.opts.factoryId, slug);
    return this.get(slug);
  }

  delete(slug: string): boolean {
    const info = this.opts.db
      .prepare(`DELETE FROM pages WHERE factory_id = ? AND slug = ?`)
      .run(this.opts.factoryId, slug);
    return info.changes > 0;
  }
}

const SlugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase words separated by -');

const CreateInput = z.object({
  slug: SlugSchema,
  title: z.string().min(1).max(200),
  html: z.string().min(1).max(500_000),
});

const UpdateInput = z.object({
  slug: SlugSchema,
  title: z.string().min(1).max(200).optional(),
  html: z.string().min(1).max(500_000).optional(),
});

const ReadInput = z.object({ slug: SlugSchema });
const DeleteInput = z.object({ slug: SlugSchema });

export interface PagesHarnessOptions {
  db: Db;
  factoryId: string;
}

export function createPagesHarness(opts: PagesHarnessOptions): HarnessModule & { store: PageStore } {
  const store = new PageStore(opts);

  const create: CommandDefinition<typeof CreateInput> = {
    name: 'pages.create',
    description: 'Create a standalone HTML page served from the isolated PageStage origin.',
    inputSchema: CreateInput,
    allowedActors: ['human', 'lead', 'specialist'],
    idempotent: false,
    execute(input, actor) {
      if (store.get(input.slug)) {
        throw new FactoryError(`Page slug '${input.slug}' already exists`, 'SLUG_TAKEN', 409);
      }
      return { page: stripHtml(store.create(input, actorLabel(actor))) };
    },
  };

  const update: CommandDefinition<typeof UpdateInput> = {
    name: 'pages.update',
    description: 'Update a page title and/or HTML.',
    inputSchema: UpdateInput,
    allowedActors: ['human', 'lead', 'specialist'],
    idempotent: true,
    execute(input) {
      const page = store.update(input.slug, input);
      if (!page) throw new NotFoundError(`Page '${input.slug}' not found`);
      return { page: stripHtml(page) };
    },
  };

  const del: CommandDefinition<typeof DeleteInput> = {
    name: 'pages.delete',
    description: 'Delete a page. Requires human approval.',
    inputSchema: DeleteInput,
    allowedActors: ['human', 'lead'],
    idempotent: true,
    requiresGate: true,
    execute(input) {
      return { deleted: store.delete(input.slug), slug: input.slug };
    },
  };

  const read: CommandDefinition<typeof ReadInput> = {
    name: 'pages.read',
    description: 'Read a page including its HTML.',
    inputSchema: ReadInput,
    allowedActors: ['human', 'lead', 'specialist'],
    idempotent: true,
    execute(input) {
      const page = store.get(input.slug);
      if (!page) throw new NotFoundError(`Page '${input.slug}' not found`);
      return { page };
    },
  };

  const list: CommandDefinition<z.ZodObject<Record<string, never>>> = {
    name: 'pages.list',
    description: 'List pages (metadata only).',
    inputSchema: z.object({}),
    allowedActors: ['human', 'lead', 'specialist'],
    idempotent: true,
    execute() {
      return { pages: store.list() };
    },
  };

  return {
    id: 'pages',
    name: 'Pages',
    store,
    commands: [create, update, del, read, list],
    renderPromptSection(ctx) {
      if (!ctx.toolNames.includes('pages.create')) return '';
      return [
        '## Pages',
        'You can publish a page the human will see in the PageStage panel.',
        'The page runs on a SEPARATE origin with a strict CSP: no network access, no imports.',
        'Use it for results that are easier to read or act on than chat text (reports, forms, comparisons).',
        'Inside the page you may call window.factoryBridge.navigate(path), .copy(text), .requestPrompt(prompt).',
        'Those three messages are the only way a page can affect the factory.',
      ].join('\n');
    },
  };
}

/**
 * Serves pages on their own origin (separate port).
 *
 * Isolation rationale: a page on `127.0.0.1:<pageStagePort>` is a DIFFERENT
 * origin from the shell on `127.0.0.1:<port>`. It therefore cannot read the
 * shell's DOM, cannot reach its cookies (there are none anyway), and its
 * postMessages are accepted only after the Zod whitelist.
 */
export function createPageStageServer(args: {
  db: Db;
  pageStagePort: number;
}): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    // Origin-aware: the shell is the only site allowed to frame a page.
    // Read at request time so a restarted server with a new port is correct.
    const shellOrigin = 'http://127.0.0.1:' + Number(process.env['MF_PORT'] ?? 4960);
    c.header('content-security-policy', buildPageCsp(shellOrigin));
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    // PageStage must not be framed by arbitrary sites; the shell frames it.
    c.header('x-frame-options', 'SAMEORIGIN');
    c.header('cache-control', 'no-store');
  });

  app.get('/health', (c) => c.json({ ok: true, role: 'page-stage' }));

  app.get('/pages/:factory/:slug', (c) => {
    const factoryId = c.req.param('factory');
    const slug = c.req.param('slug');
    const row = args.db
      .prepare(`SELECT * FROM pages WHERE factory_id = ? AND slug = ?`)
      .get(factoryId, slug) as RawPage | undefined;
    if (!row) return c.text('Page not found', 404);
    const shellOrigin = `http://127.0.0.1:${Number(process.env['MF_PORT'] ?? 4960)}`;
    return c.html(
      wrapPageHtml({ title: row.title, body: row.html, shellOrigin }),
    );
  });

  return app;
}

export interface PageStageHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

/** Starts the isolated PageStage origin. Binds to loopback only. */
export async function startPageStage(args: { db: Db; port: number }): Promise<PageStageHandle> {
  const app = createPageStageServer({ db: args.db, pageStagePort: args.port });
  const server = serve({ fetch: app.fetch, port: args.port, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const actual = (server.address() as AddressInfo).port;
  return {
    port: actual,
    url: `http://127.0.0.1:${actual}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function actorLabel(actor: { kind: string }): string {
  return actor.kind === 'agent' ? `${(actor as { role?: string }).role ?? 'agent'}` : actor.kind;
}

function stripHtml<T extends { html: string }>(page: T): Omit<T, 'html'> & { bytes: number } {
  const { html, ...rest } = page;
  return { ...rest, bytes: Buffer.byteLength(html, 'utf8') };
}

interface RawPage {
  id: string;
  factory_id: string;
  slug: string;
  title: string;
  html: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface RawPageMeta {
  id: string;
  factory_id: string;
  slug: string;
  title: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

function mapPage(r: RawPage): PageRow {
  return {
    id: r.id,
    factoryId: r.factory_id,
    slug: r.slug,
    title: r.title,
    html: r.html,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapMeta(r: RawPageMeta): Omit<PageRow, 'html'> {
  return {
    id: r.id,
    factoryId: r.factory_id,
    slug: r.slug,
    title: r.title,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export * from './bridge.js';

