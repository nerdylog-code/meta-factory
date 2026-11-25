/**
 * Verification driver for the redesigned UI.
 *
 * Opens a fresh tab (the UI wipes the token from the URL), seeds a run so the
 * chat has content, and captures the screenshots the brief asks for.
 *
 * Usage: node verify-ui.mjs <urlWithToken> <outDir>
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2];
const outDir = process.argv[3] ?? '.';
mkdirSync(outDir, { recursive: true });

const created = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(created.webSocketDebuggerUrl);
let id = 1;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const r = pending.get(m.id);
    pending.delete(m.id);
    r(m.result ?? m.error);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = id++;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

const log = { errors: [], steps: [] };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) {
    const msg = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
    log.errors.push(msg);
    return null;
  }
  return r?.result?.value;
}
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
  log.steps.push({ shot: name });
}

ws.addEventListener('message', (raw) => {
  const m = JSON.parse(raw.data);
  if (m.method === 'Runtime.exceptionThrown') {
    log.errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  }
});

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.navigate', { url });
await wait(5000);

log.steps.push({
  step: 'loaded',
  status: await ev(`document.getElementById('statusText').textContent`),
  model: await ev(`document.getElementById('mbModel').textContent`),
  telemetry: await ev(`document.getElementById('telemetry').innerText.replace(/\\s+/g,' ')`),
  emptyTitle: await ev(`document.querySelector('.ef-eyebrow')?.textContent`),
  cards: await ev(`document.querySelectorAll('.ef-card').length`),
  subtabs: await ev(`[...document.querySelectorAll('.subtab')].map(b=>b.dataset.tab)`),
  settingsNav: await ev(`document.querySelectorAll('#settingsNav .navitem').length`),
  rawEventSqlLeak: await ev(`document.getElementById('chatTimeline').innerText.includes('run_created')`),
});
await shot('01-empty-factory');

// Start the demo run through the real composer.
await ev(`(() => { const g = document.getElementById('goalInput'); g.value = 'create a note and then delete it'; document.getElementById('sendBtn').click(); })()`);
await wait(3500);
log.steps.push({
  step: 'run-started',
  status: await ev(`document.getElementById('statusText').textContent`),
  gateBadge: await ev(`document.getElementById('gateBadge').style.display`),
  hasGateCard: await ev(`!!document.querySelector('#chatTimeline .gate-card')`),
  hasSummaryLine: await ev(`!!document.querySelector('#chatTimeline .sumline')`),
  leaksRawEvents: await ev(`/\\b(run_started|llm_requested|turn_started)\\b/.test(document.getElementById('chatTimeline').innerText)`),
});
await shot('02-gate-inline');

// Approve through the inline card.
const approved = await ev(`(() => { const b = [...document.querySelectorAll('#chatTimeline .gate-card button')].find(x => x.textContent.includes('Approve')); if (!b) return 'no-button'; b.click(); return 'clicked'; })()`);
await wait(3500);
log.steps.push({
  step: 'approved',
  click: approved,
  runStatus: await ev(`document.querySelector('#runsList .pill')?.textContent`),
  status: await ev(`document.getElementById('statusText').textContent`),
});
await shot('03-after-approve');

// Create a page via the Commands tab, then open it.
await ev(`[...document.querySelectorAll('.subtab')].find(b=>b.dataset.tab==='commands').click()`);
await wait(700);
log.steps.push({ step: 'commands-tab', options: await ev(`document.querySelectorAll('#cmdList .list-item').length`) });
await ev(`(() => {
  const rows = [...document.querySelectorAll('#cmdList .list-item')];
  const r = rows.find(x => x.innerText.includes('pages.create'));
  if (r) r.click();
})()`);
await wait(400);
await ev(`(() => {
  document.getElementById('cmdInput').value = JSON.stringify({
    slug: 'demo', title: 'Demo Page',
    html: '<h2 style="font-family:system-ui;margin:0 0 8px">Factory Status</h2><p style="font-family:system-ui;color:#444">Rendered from an isolated origin (4961).</p>'
  });
  document.getElementById('cmdRun').click();
})()`);
await wait(2200);
log.steps.push({ step: 'page-created', ok: await ev(`document.getElementById('cmdOut').innerText.includes('Demo Page')`) });
await ev(`[...document.querySelectorAll('#pagesList .list-item')].find(e => e.innerText.includes('Demo'))?.click()`);
await wait(2500);
log.steps.push({
  step: 'pagestage',
  iframeShown: await ev(`document.getElementById('stage-frame').style.display`),
  stageBar: await ev(`document.getElementById('stageBar').style.display`),
  title: await ev(`document.getElementById('stageTitle').textContent`),
});
await shot('04-pagestage');

// Settings: the three required tabs.
const settingsTabs = ['tools', 'summary', 'subagents'];
for (const tab of settingsTabs) {
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', code: 'Comma', ctrlKey: true, bubbles: true }))`);
  await wait(800);
  await ev(`[...document.querySelectorAll('#settingsNav .navitem')].find(b => b.textContent.toLowerCase().includes(${JSON.stringify(
    tab === 'summary' ? 'tool summary' : tab,
  )}))?.click()`);
  await wait(1400);
  const info = await ev(`({
    title: document.getElementById('settingsTitle').textContent,
    toggles: document.querySelectorAll('#settingsBody .toggle').length,
    segs: document.querySelectorAll('#settingsBody .seg').length,
    segButtons: document.querySelectorAll('#settingsBody .seg button').length,
    toolsGrid: document.querySelectorAll('#settingsBody .tools-grid').length,
    toolCards: document.querySelectorAll('#settingsBody .tool-card').length,
    harnessGroups: document.querySelectorAll('#settingsBody .harness-group').length,
    nativeSelects: document.querySelectorAll('#settingsBody select').length,
    nativeChecks: document.querySelectorAll('#settingsBody input[type=checkbox]').length,
  })`);
  log.steps.push({ step: `settings:${tab}`, ...info });
  await shot(`05-settings-${tab}`);
  await ev(`document.getElementById('settingsClose').click()`);
  await wait(400);
}

// Persistence: toggle a tool off, reload in a fresh tab context, check it stuck.
await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', code: 'Comma', ctrlKey: true, bubbles: true }))`);
await wait(700);
await ev(`[...document.querySelectorAll('#settingsNav .navitem')].find(b => b.textContent.toLowerCase().includes('tools'))?.click()`);
await wait(1400);
const beforeToggles = await ev(`[...document.querySelectorAll('#settingsBody .toggle')].map(t => t.classList.contains('on')).filter(Boolean).length`);
await ev(`[...document.querySelectorAll('#settingsBody .tool-card')].find(c => c.innerText.includes('fs.write'))?.querySelector('.toggle')?.click()`);
await wait(1800);
const afterToggles = await ev(`[...document.querySelectorAll('#settingsBody .toggle')].map(t => t.classList.contains('on')).filter(Boolean).length`);

// Reload WITH the token: the UI wipes the hash on load (by design), so a plain
// Page.reload would land on a page with no credential and show nothing.
await send('Page.navigate', { url });
await wait(5000);
await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', code: 'Comma', ctrlKey: true, bubbles: true }))`);
await wait(800);
await ev(`[...document.querySelectorAll('#settingsNav .navitem')].find(b => b.textContent.toLowerCase().includes('tools'))?.click()`);
await wait(1600);
const afterReload = await ev(`[...document.querySelectorAll('#settingsBody .toggle')].map(t => t.classList.contains('on')).filter(Boolean).length`);
const fsWriteOff = await ev(`(() => { const c = [...document.querySelectorAll('#settingsBody .tool-card')].find(c => c.innerText.includes('fs.write')); return c ? !c.querySelector('.toggle').classList.contains('on') : null; })()`);
log.steps.push({ step: 'persistence', beforeToggles, afterToggles, afterReload, fsWriteOff });

// Restore fs.write so the factory is left usable.
await ev(`(() => { const c = [...document.querySelectorAll('#settingsBody .tool-card')].find(c => c.innerText.includes('fs.write')); c?.querySelector('.toggle')?.click(); })()`);
await wait(1500);
await shot('06-settings-tools-persisted');

log.consoleErrors = log.errors.slice(0, 20);
writeFileSync(join(outDir, 'log.json'), JSON.stringify(log, null, 2));
console.log(JSON.stringify(log, null, 2));
ws.close();
await fetch(`http://127.0.0.1:9333/json/close/${created.id}`).catch(() => {});
process.exit(0);

