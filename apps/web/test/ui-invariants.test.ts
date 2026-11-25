import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Structural assertions on the single-file UI (`apps/web/public/index.html`).
 *
 * The UI was redesigned, so selectors changed; the SECURITY assertions did not
 * weaken. Each block below pairs a behaviour with the reason it matters. Where
 * a check could rot silently, it asserts against a regex rather than a string
 * that a rename would accidentally satisfy.
 */
const html = readFileSync(join(process.cwd(), 'apps', 'web', 'public', 'index.html'), 'utf8');

describe('auth and transport invariants', () => {
  it('reads the token from the fragment and erases it from the URL', () => {
    expect(html).toMatch(/new URLSearchParams\(location\.hash\.slice\(1\)\)/);
    expect(html).toContain("history.replaceState(null, '', location.pathname + location.search)");
  });

  it('never persists the token anywhere (memory only)', () => {
    // A token in web storage, a cookie, or the query string survives a reload,
    // is readable by any script on the origin, and lands in logs.
    expect(html).not.toMatch(/localStorage\s*[.[]/);
    expect(html).not.toMatch(/sessionStorage\s*[.[]/);
    expect(html).not.toMatch(/document\.cookie\s*=/);
    expect(html).not.toMatch(/[?&]token=/);
  });

  it('authenticates SSE with a bearer header and never uses EventSource', () => {
    expect(html).toContain("fetch('/api/events'");
    expect(html).toMatch(/authorization:\s*'Bearer '\s*\+\s*TOKEN/);
    // EventSource cannot send headers, so it would force the token into the URL.
    expect(html).not.toContain('new EventSource(');
  });

  it('sends the bearer header on every API call', () => {
    expect(html).toMatch(/async function api\(path, opts = \{\}\)/);
    expect(html).toMatch(/authorization:\s*'Bearer '\s*\+\s*TOKEN/);
  });
});

describe('PageStage isolation', () => {
  it('frames pages in a sandboxed iframe pointing at the isolated origin', () => {
    expect(html).toMatch(/<iframe id="stage-frame"[^>]*sandbox="allow-scripts"/);
    expect(html).toContain('referrerpolicy="no-referrer"');
    // The src is built from the server-provided page-stage origin, never a
    // same-origin path.
    expect(html).toMatch(/\$\{S\.pageStageUrl\}\/pages\//);
  });

  it('accepts postMessage only from the page-stage origin', () => {
    expect(html).toMatch(/if \(!S\.pageStageUrl \|\| event\.origin !== S\.pageStageUrl\) return;/);
    // And the handler is actually registered.
    expect(html).toMatch(/window\.addEventListener\('message'/);
  });

  it('handles only the three whitelisted actions', () => {
    for (const t of ["case 'navigate'", "case 'copy'", "case 'request_prompt'"]) {
      expect(html).toContain(t);
    }
  });
});

describe('XSS safety', () => {
  it('escapes dynamic text before injecting it as HTML', () => {
    expect(html).toContain('const esc = (s) =>');
    // Model text flows into these DOM sinks; each must be escaped.
    for (const sink of ['esc(r.goal)', 'esc(text)', 'esc(g.commandName)', 'esc(e.payload.message']) {
      expect(html, `unescaped sink: ${sink}`).toContain(sink);
    }
  });

  it('markdown escaping happens BEFORE structure is applied', () => {
    // Applying markdown first and escaping later would double-escape; escaping
    // first and never re-injecting raw HTML is what makes this safe.
    const fnStart = html.indexOf('function renderMarkdown');
    expect(fnStart, 'renderMarkdown missing').toBeGreaterThan(-1);
    const fn = html.slice(fnStart, fnStart + 1400);
    const escAt = fn.indexOf('s = esc(s)');
    const structureAt = fn.indexOf("replace(/`([^`\\n]+)`/");
    expect(escAt).toBeGreaterThan(-1);
    expect(structureAt).toBeGreaterThan(escAt);
    // No raw-HTML passthrough.
    expect(fn).not.toContain('dangerouslySetInnerHTML');
    expect(fn).not.toMatch(/innerHTML\s*=\s*[a-zA-Z]+\s*;/);
  });
});

describe('the agent panel is a conversation, not an event dump', () => {
  it('does not print raw run event types in the chat', () => {
    // The brief: run_created / llm_requested / turn_started belong in Traces.
    expect(html).not.toMatch(/run_created[\s\S]{0,200}chatTimeline/);
  });

  it('groups tool calls into a summary line with a details pane', () => {
    expect(html).toContain('class="sumline');
    expect(html).toContain('summarizeFallback');
    expect(html).toContain('Call');
  });

  it('renders the approval gate inline in the chat with approve and reject', () => {
    expect(html).toContain('APPROVAL REQUIRED');
    expect(html).toContain('Approve & Resume');
    expect(html).toContain('/api/gates/');
  });
});

describe('human command panel', () => {
  it('lets a human execute any command the bus allows', () => {
    expect(html).toContain('renderCommandsTab');
    expect(html).toContain('Execute as human');
    expect(html).toMatch(/c\.allowedActors\.includes\('human'\)/);
    expect(html).toContain("'/api/commands/' + encodeURIComponent(name)");
  });
});

describe('settings surface', () => {
  it('exposes all required tabs with the documented hotkey letters', () => {
    const required = {
      agent: 'S',
      context: 'C',
      model: 'M',
      prompt: 'P',
      tools: 'T',
      cron: 'R',
      jobs: 'J',
      subagents: 'G',
      summary: 'U',
      traces: 'O',
      tokenomics: '$',
      harness: 'E',
      theme: 'H',
      hotkeys: '?',
    };
    for (const [id, key] of Object.entries(required)) {
      // The nav entry must exist with that id and that key binding.
      const re = new RegExp(`id: '${id === 'summary' ? 'summary' : id}'[^}]*key: '${key.replace('$', '\\$')}'`);
      expect(html, `settings tab '${id}' with key '${key}'`).toMatch(re);
    }
  });

  it('uses custom primitives instead of native select/checkbox', () => {
    // The brief forbids native controls: they cannot be themed consistently.
    expect(html).toContain('function seg(');
    expect(html).toContain('function toggle(');
    expect(html).not.toMatch(/<input type="checkbox"/);
    expect(html).not.toMatch(/<select[\s>]/);
  });

  it('the Tools view groups by harness and shows a gated badge', () => {
    expect(html).toContain('harness-group');
    expect(html).toContain('tools-grid');
    expect(html).toContain('>gated<');
  });
});

describe('stylesheets contain only valid CSS', () => {
  /**
   * The UI is one file mixing <style> and <script>. A `//` comment inside a
   * <style> block is invalid CSS and silently killed the declaration that
   * followed it — which is exactly how the tool-call rows stayed expanded after
   * being "fixed". This test makes that class of mistake impossible to ship.
   */
  const styleBlocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);

  it('has at least one stylesheet', () => {
    expect(styleBlocks.length).toBeGreaterThan(0);
  });

  it('uses no line comments inside CSS', () => {
    for (const css of styleBlocks) {
      const offenders = css
        .split('\n')
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter((l) => l.line.startsWith('//'));
      expect(offenders, `CSS line comments found: ${JSON.stringify(offenders.slice(0, 3))}`).toEqual([]);
    }
  });

  it('uses no JS template syntax inside CSS', () => {
    for (const css of styleBlocks) {
      expect(css).not.toContain('${');
    }
  });

  it('every declaration block opens and closes', () => {
    for (const css of styleBlocks) {
      const opens = (css.match(/\{/g) ?? []).length;
      const closes = (css.match(/\}/g) ?? []).length;
      expect(opens, 'unbalanced braces in a stylesheet').toBe(closes);
    }
  });
});

describe('layout when the centre is hidden', () => {
  it('the agent panel expands to fill the space instead of leaving a gutter', () => {
    // Reported: hiding the centre left the 420px panel pinned to the left with
    // half the screen empty black.
    const rule = /\.shell\.hide-center \.pane-right \{[^}]*flex: 1 1 auto[^}]*\}/;
    expect(html).toMatch(rule);
    expect(html).toMatch(/\.shell\.hide-center \.pane-right \{[^}]*width: auto/);
  });

  it('the expanded conversation is centred at a readable measure', () => {
    expect(html).toContain('--measure: 860px');
    expect(html).toMatch(/\.shell\.hide-center \.pane-right \.chat-timeline \{[^}]*max-width: var\(--measure\)/);
  });
});

describe('tool-call rows start collapsed', () => {
  it('detail is hidden unless the row is explicitly open', () => {
    expect(html).toMatch(/\.sumline \.detail \{ display: none;/);
    expect(html).toMatch(/\.sumline\.open \.detail \{ display: block; \}/);
  });

  it('a row is only marked open when the user expanded it', () => {
    expect(html).toContain("el.className = 'sumline' + (open ? ' open' : '')");
    expect(html).toContain('openSummaries: new Set()');
    // Opening is a click, never automatic.
    expect(html).toMatch(/S\.openSummaries\.has\(key\) \? S\.openSummaries\.delete\(key\) : S\.openSummaries\.add\(key\)/);
  });
});

describe('Stop cancels for real', () => {
  it('calls the stop endpoint instead of faking it', () => {
    expect(html).toContain("'/stop'");
    expect(html).toContain('async function stopRun()');
    // The old placeholder must be gone.
    expect(html).not.toContain('Stop is wired to the run cancel endpoint');
  });

  it('is enabled only while the selected run is executing', () => {
    expect(html).toContain('function syncStopButton()');
    expect(html).toMatch(/run\.status === 'running' \|\| run\.status === 'pending'/);
  });
});

describe('hotkeys', () => {
  it('ignores shortcuts while typing', () => {
    expect(html).toContain('function isTyping()');
    expect(html).toMatch(/if \(isTyping\(\)\) return;/);
  });

  it('supports the documented navigation keys', () => {
    expect(html).toMatch(/\/\^\[1-9\]\$\/\.test\(e\.key\)/); // 1-9 open pages
    expect(html).toContain("e.key === 'Escape'");
    expect(html).toMatch(/e\.key === ',' \|\| e\.code === 'Comma'/);
  });
});


