import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BudgetEnforcer,
  CommandBus,
  DurableRunner,
  FakeLLMProvider,
  SqliteGateStore,
  TokenLedger,
  openDb,
  type Db,
} from '@mf/core';
import {
  PAGE_CSP,
  assertPageHtmlIsContained,
  buildPageCsp,
  PAGE_BASE_CSS,
  createPagesHarness,  startPageStage,
  validateBridgeMessage,
  wrapPageHtml,
  type PageStageHandle,
} from '../src/index.js';

let dir: string;
let db: Db;
let bus: CommandBus;

const human = { kind: 'human' } as const;
const agent = { kind: 'agent', role: 'lead', agentId: 'a', runId: 'r', toolCallId: 't' } as const;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mf-pages-'));
  db = openDb({ path: join(dir, 'state.db') });
  bus = new CommandBus(db);
  bus.registerAll(createPagesHarness({ db, factoryId: 'f1' }).commands);
  bus.setGateStore(new SqliteGateStore(db));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('PageStage bridge whitelist', () => {
  it('accepts the three allowed messages', () => {
    expect(validateBridgeMessage({ type: 'navigate', path: '/runs/1' }).ok).toBe(true);
    expect(validateBridgeMessage({ type: 'copy', text: 'hi' }).ok).toBe(true);
    expect(validateBridgeMessage({ type: 'request_prompt', prompt: 'do it' }).ok).toBe(true);
  });

  const rejected: Array<[string, unknown]> = [
    ['unknown type', { type: 'exec_command', command: 'rm -rf /' }],
    ['missing type', { path: '/x' }],
    ['non-object', 'navigate'],
    ['null', null],
    ['array', [{ type: 'copy', text: 'x' }]],
    ['navigate with relative path', { type: 'navigate', path: 'evil.com' }],
    ['navigate with protocol', { type: 'navigate', path: 'https://evil.example' }],
    ['extra key smuggled in', { type: 'copy', text: 'x', token: 'steal-me' }],
    ['command name as type', { type: 'notes.delete', id: 'n1' }],
    ['empty prompt', { type: 'request_prompt', prompt: '' }],
  ];

  for (const [label, msg] of rejected) {
    it(`rejects: ${label}`, () => {
      const res = validateBridgeMessage(msg);
      expect(res.ok).toBe(false);
    });
  }

  it('an unknown type cannot reach the CommandBus by naming a command', () => {
    // The attack: a page posts {type:'notes.delete'} hoping the shell dispatches.
    const res = validateBridgeMessage({ type: 'notes.delete', id: 'n1' });
    expect(res.ok).toBe(false);
    // and the value the shell sees is only ever one of three literals
    const accepted = { type: 'copy', text: 'x' } as const;
    const parsed = validateBridgeMessage(accepted);
    expect(parsed.ok && ['navigate', 'copy', 'request_prompt'].includes(parsed.message.type)).toBe(true);
  });
});

describe('PageStage CSP', () => {
  it('allows the SHELL to frame a page, and nobody else', () => {
    // Regression: the CSP said `frame-ancestors 'none'`, which blocked the
    // shell's own PageStage iframe (broken-page icon in the panel) while every
    // header assertion still passed, because they only looked for
    // `connect-src 'none'`.
    const csp = buildPageCsp('http://127.0.0.1:4960');
    expect(csp).toContain("frame-ancestors http://127.0.0.1:4960");
    expect(csp).not.toContain("frame-ancestors 'none'");
    // Still not frameable by anyone else.
    expect(csp).not.toContain('frame-ancestors *');
  });

  it('the default CSP (no shell origin known) denies framing', () => {
    expect(PAGE_CSP).toContain("frame-ancestors 'none'");
  });

  it('injects a dark base stylesheet so a page is not a white glare', () => {
    // Reported from a screenshot: the Demo Page rendered as a white sheet with
    // serif text inside the dark shell. The wrapper now ships base CSS.
    const html = wrapPageHtml({ title: 'T', body: '<p>hi</p>', shellOrigin: 'http://127.0.0.1:4960' });
    expect(html).toContain(PAGE_BASE_CSS);
    expect(PAGE_BASE_CSS).toContain('background:#0b0b0d');
    expect(PAGE_BASE_CSS).toContain('color:#ececef');
    expect(PAGE_BASE_CSS).toContain("sans-serif");
    // A generated page using bare tags must still look intentional.
    for (const sel of ['h1', 'table', 'th', 'td', 'pre', 'code']) {
      expect(PAGE_BASE_CSS, `base css missing ${sel}`).toContain(sel);
    }
    // The page can still override: this is a default, not a cage.
    expect(html).toContain('<style>');
    expect(html).toContain('</style>');
  });

  it('wrapped HTML carries the shell origin in frame-ancestors', () => {
    const html = wrapPageHtml({ title: 'T', body: '', shellOrigin: 'http://127.0.0.1:4960' });
    expect(html).toContain('frame-ancestors http://127.0.0.1:4960');
  });

  it('blocks all network access from a page', () => {
    expect(PAGE_CSP).toContain("connect-src 'none'");
    expect(PAGE_CSP).toContain("default-src 'none'");
    expect(PAGE_CSP).not.toContain('*');
  });

  it('wrapped HTML carries the CSP meta and a same-origin bridge', () => {
    const html = wrapPageHtml({ title: 'T', body: '<p>hi</p>', shellOrigin: 'http://127.0.0.1:4960' });
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("connect-src 'none'");
    // postMessage must never use a wildcard target
    expect(html).not.toContain("postMessage(x, '*')");
    expect(html).toContain('http://127.0.0.1:4960');
  });

  it('escapes the title so a page cannot inject markup through it', () => {
    const html = wrapPageHtml({
      title: '</title><script>evil()</script>',
      body: '',
      shellOrigin: 'http://127.0.0.1:1',
    });
    expect(html).not.toContain('<script>evil()</script>');
    expect(html).toContain('&lt;/title&gt;');
  });

  it('refuses HTML with a meta refresh or base tag', () => {
    expect(() => assertPageHtmlIsContained('<meta http-equiv="refresh" content="0;url=http://evil">')).toThrow();
    expect(() => assertPageHtmlIsContained('<base href="http://evil/">')).toThrow();
    expect(() => assertPageHtmlIsContained('<p>fine</p>')).not.toThrow();
  });
});

describe('pages commands', () => {
  const sample = (slug: string) => ({
    slug,
    title: `Page ${slug}`,
    html: '<h1>Hello</h1><p>world</p>',
  });

  it('creates and reads a page', async () => {
    await bus.dispatch('pages.create', sample('report'), human);
    const res = (await bus.dispatch('pages.read', { slug: 'report' }, human)) as {
      result: { page: { html: string; title: string } };
    };
    expect(res.result.page.title).toBe('Page report');
    expect(res.result.page.html).toContain('Hello');
  });

  it('rejects a duplicate slug instead of silently overwriting', async () => {
    await bus.dispatch('pages.create', sample('dup'), human);
    await expect(bus.dispatch('pages.create', sample('dup'), human)).rejects.toMatchObject({ code: 'SLUG_TAKEN' });
  });

  it('validates slugs (no path traversal through a slug)', async () => {
    await expect(
      bus.dispatch('pages.create', { slug: '../../etc/passwd', title: 'x', html: 'x' }, human),
    ).rejects.toThrow(/Invalid input/);
  });

  it('refuses page HTML that is not contained', async () => {
    await expect(
      bus.dispatch(
        'pages.create',
        { slug: 'evil', title: 'x', html: '<meta http-equiv="refresh" content="0">' },
        human,
      ),
    ).rejects.toThrow(/meta refresh/);
  });

  it('pages.delete requires a gate for an agent but not for a human', async () => {
    await bus.dispatch('pages.create', sample('del'), human);

    db.prepare(
      `INSERT OR IGNORE INTO runs (id, factory_id, agent_id, goal, status, tier, pool_id, turn, created_at, updated_at)
       VALUES ('r','f1','a','g','running','B',NULL,0,0,0)`,
    ).run();

    const res = await bus.dispatch('pages.delete', { slug: 'del' }, agent, {
      factoryId: 'f1',
      idempotencyKey: 'k',
    });
    expect(res.status).toBe('pending_approval');
    // still there
    const listed = (await bus.dispatch('pages.list', {}, human)) as { result: { pages: unknown[] } };
    expect(listed.result.pages).toHaveLength(1);

    await bus.dispatch('pages.delete', { slug: 'del' }, human);
    const after = (await bus.dispatch('pages.list', {}, human)) as { result: { pages: unknown[] } };
    expect(after.result.pages).toHaveLength(0);
  });

  it('list returns metadata without HTML', async () => {
    await bus.dispatch('pages.create', sample('meta'), human);
    const res = (await bus.dispatch('pages.list', {}, human)) as { result: { pages: Array<Record<string, unknown>> } };
    expect(res.result.pages[0]).not.toHaveProperty('html');
    expect(res.result.pages[0]).toHaveProperty('slug', 'meta');
  });
});

describe('isolated PageStage origin', () => {
  let handle: PageStageHandle;

  afterEach(async () => {
    if (handle) await handle.close();
  });

  it('serves a page on its OWN origin with strict CSP headers', async () => {
    await bus.dispatch(
      'pages.create',
      { slug: 'demo', title: 'Demo', html: '<h1>Demo</h1>' },
      human,
    );
    handle = await startPageStage({ db, port: 0 });

    const res = await fetch(`${handle.url}/pages/f1/demo`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await res.text();
    expect(body).toContain('Demo');
    expect(body).toContain('factoryBridge');
  });

  it('returns 404 for an unknown page instead of leaking a list', async () => {
    handle = await startPageStage({ db, port: 0 });
    const res = await fetch(`${handle.url}/pages/f1/nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('demo');
  });

  it('the page stage port differs from the shell port, so it is a distinct origin', async () => {
    handle = await startPageStage({ db, port: 0 });
    expect(handle.port).toBeGreaterThan(0);
    // origin isolation is what makes the postMessage whitelist meaningful
    const res = await fetch(`${handle.url}/health`);
    const body = (await res.json()) as { role: string };
    expect(body.role).toBe('page-stage');
  });

  it('a page cannot read another factory\'s page', async () => {
    await bus.dispatch('pages.create', { slug: 'secret', title: 'S', html: '<p>S</p>' }, human);
    handle = await startPageStage({ db, port: 0 });
    const res = await fetch(`${handle.url}/pages/other-factory/secret`);
    expect(res.status).toBe(404);
  });
});

describe('pages through the runner', () => {
  it('an agent creates a page and it is served', async () => {
    const provider = new FakeLLMProvider({
      script: [
        {
          type: 'tool_call',
          name: 'pages.create',
          args: { slug: 'agent-page', title: 'Built by agent', html: '<p>ok</p>' },
          callId: 'c1',
        },
        { type: 'text', content: 'page created' },
      ],
    });
    const budget = new BudgetEnforcer(db);
    const pool = budget.createPool({ ownerKind: 'factory', ownerId: 'f1', amountUsd: 1 });
    const runner = new DurableRunner({
      db,
      bus,
      ledger: new TokenLedger(db),
      budget,
      provider,
      price: { in: 0, out: 0 },
    });

    const run = await runner.startRun({
      factoryId: 'f1',
      goal: 'make a page',
      tier: 'B',
      poolId: pool.id,
      systemPrompt: 'sys',
    });
    expect(run.status).toBe('completed');

    const handle = await startPageStage({ db, port: 0 });
    const res = await fetch(`${handle.url}/pages/f1/agent-page`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Built by agent');
    await handle.close();
  });
});





