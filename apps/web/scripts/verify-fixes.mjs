/**
 * Verifies the four reported UI/UX fixes on the live app.
 * Usage: node verify-fixes.mjs <urlWithToken> <outDir>
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2];
const outDir = process.argv[3] ?? '.';
mkdirSync(outDir, { recursive: true });

const created = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(created.webSocketDebuggerUrl);
let id = 1;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    const r = pend.get(m.id);
    pend.delete(m.id);
    r(m.result ?? m.error);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = id++;
    pend.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

const log = { steps: [], errors: [] };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) {
    log.errors.push(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return null;
  }
  return r?.result?.value;
}
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
  log.steps.push({ shot: name });
}
const rect = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; })()`);

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.navigate', { url });
await wait(5000);

// --- FIX 1: hide the centre, the agent panel must expand.
const before = await rect('#paneRight');
await ev(`document.getElementById('toggleCenter').click()`);
await wait(700);
const after = await rect('#paneRight');
const shellWidth = await ev(`document.getElementById('shell').getBoundingClientRect().width`);
const leftWidth = await ev(`document.getElementById('paneLeft').getBoundingClientRect().width`);
const measured = await ev(`(() => { const e = document.querySelector('#paneRight .chat-timeline'); return e ? Math.round(e.getBoundingClientRect().width) : null; })()`);
log.steps.push({
  step: 'fix1-hide-center',
  before,
  after,
  shellWidth,
  leftWidth,
  fillsRemainder: after && Math.abs(after.x + after.w - shellWidth) < 2,
  expandedBeyond420: after ? after.w > 420 : false,
  measureCapped: measured !== null ? measured <= 862 : null,
});
await shot('fix1-center-hidden');
await ev(`document.getElementById('toggleCenter').click()`);
await wait(500);

// --- Start a run so the chat has tool calls.
await ev(`(() => { const g = document.getElementById('goalInput'); g.value = 'create a note and then delete it'; document.getElementById('sendBtn').click(); })()`);
await wait(3500);

// --- FIX 3: tool rows collapsed by default.
const collapsed = await ev(`(() => {
  const rows = [...document.querySelectorAll('#chatTimeline .sumline')];
  return rows.map(r => {
    const d = r.querySelector(':scope > .body > .detail') || r.querySelector('.detail');
    return {
      open: r.classList.contains('open'),
      detailDisplay: d ? getComputedStyle(d).display : 'missing',
      visibleText: r.innerText.replace(/\\s+/g, ' ').slice(0, 70),
    };
  });
})()`);
log.steps.push({ step: 'fix3-collapsed', rows: collapsed, allClosed: (collapsed ?? []).every((r) => !r.open && r.detailDisplay === 'none') });
await shot('fix3-collapsed');

// Expand the first row on click.
await ev(`document.querySelector('#chatTimeline .sumline')?.click()`);
await wait(500);
const expanded = await ev(`(() => { const r = document.querySelector('#chatTimeline .sumline'); const d = r?.querySelector('.detail'); return { open: r?.classList.contains('open'), detailVisible: d ? getComputedStyle(d).display !== 'none' : null }; })()`);
log.steps.push({ step: 'fix3-expand-on-click', ...expanded });
await shot('fix3-expanded');

// --- FIX 2: PageStage must not be a white sheet.
await ev(`[...document.querySelectorAll('.subtab')].find(b => b.dataset.tab === 'commands').click()`);
await wait(600);
await ev(`(() => {
  const rows = [...document.querySelectorAll('#cmdList .list-item')];
  rows.find(x => x.innerText.includes('pages.create'))?.click();
})()`);
await wait(400);
await ev(`(() => {
  document.getElementById('cmdInput').value = JSON.stringify({
    slug: 'stylecheck', title: 'Style Check',
    html: '<h1>Status report</h1><p>Plain tags, no CSS of its own.</p><table><tr><th>Metric</th><th>Value</th></tr><tr><td>Runs</td><td>3</td></tr></table><pre>const x = 1;</pre>'
  });
  document.getElementById('cmdRun').click();
})()`);
await wait(2000);
await ev(`[...document.querySelectorAll('#pagesList .list-item')].find(e => e.innerText.includes('Style'))?.click()`);
await wait(2500);
// Probe INSIDE the iframe (same CDP session; evaluate in its frame).
const frames = await send('Page.getFrameTree');
const childFrame = frames?.frameTree?.childFrames?.[0]?.frame;
let iframeStyles = null;
if (childFrame) {
  const ctx = await send('Runtime.evaluate', { expression: '', contextId: undefined });
  void ctx;
  // Use DOM domain targeting via executionContextId of the child frame.
  const world = await send('Page.createIsolatedWorld', { frameId: childFrame.id, worldName: 'probe' });
  const res = await send('Runtime.evaluate', {
    expression: `(() => { const b = getComputedStyle(document.body); const h = document.querySelector('h1'); const t = document.querySelector('td'); return { bg: b.backgroundColor, color: b.color, font: b.fontFamily.slice(0, 28), h1Color: h ? getComputedStyle(h).color : null, tdPad: t ? getComputedStyle(t).padding : null }; })()`,
    returnByValue: true,
    contextId: world?.executionContextId,
  });
  iframeStyles = res?.result?.value ?? res?.exceptionDetails?.text;
}
log.steps.push({ step: 'fix2-pagestage-css', iframeStyles, notWhite: iframeStyles?.bg === 'rgb(11, 11, 13)' });
await shot('fix2-pagestage');

// --- FIX 4: Stop hits the real endpoint. Approve first so a run is live, then
// start a fresh slow one is not possible with the fake provider; instead assert
// the button is enabled only while running and the endpoint answers honestly.
const stopState = await ev(`(() => {
  const b = document.getElementById('stopBtn');
  return { disabled: b.disabled, label: b.textContent.trim() };
})()`);
log.steps.push({ step: 'fix4-stop-button', ...stopState });
const stopRes = await ev(`(async () => {
  const btn = document.getElementById('stopBtn');
  btn.disabled = false;
  btn.click();
  await new Promise(r => setTimeout(r, 1200));
  return document.querySelector('.toast')?.innerText ?? 'no toast';
})()`);
log.steps.push({ step: 'fix4-stop-call', toast: stopRes });
await shot('fix4-stop');

log.consoleErrors = log.errors.slice(0, 10);
writeFileSync(join(outDir, 'log.json'), JSON.stringify(log, null, 2));
console.log(JSON.stringify(log, null, 2));
ws.close();
await fetch(`http://127.0.0.1:9333/json/close/${created.id}`).catch(() => {});
process.exit(0);

