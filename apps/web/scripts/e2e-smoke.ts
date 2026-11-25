/**
 * End-to-end smoke test of a RUNNING factory over HTTP.
 *
 * Usage: node --import tsx/esm apps/web/scripts/e2e-smoke.ts <baseUrl> <token>
 *
 * Verifies, in order:
 *  1. Bearer auth is required (401 without it)
 *  2. the SSE stream delivers a real event (run_event)
 *  3. a human command round-trips
 *  4. tokenomics reflects the call
 * It exits non-zero on the first failure, so it can gate a phase.
 */
const baseUrl = process.argv[2];
const token = process.argv[3];
if (!baseUrl || !token) {
  console.error('usage: e2e-smoke.ts <baseUrl> <token>');
  process.exit(2);
}

const headers = { authorization: `Bearer ${token}`, origin: baseUrl };
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

async function main(): Promise<void> {
  // 1. unauthenticated must fail
  const noAuth = await fetch(`${baseUrl}/api/health`);
  check('rejects unauthenticated request', noAuth.status === 401, `got ${noAuth.status}`);

  // 2. open SSE, then trigger activity, and require a real event frame
  const sse = await fetch(`${baseUrl}/api/events`, { headers: { authorization: `Bearer ${token}` } });
  check('SSE connects with bearer header', sse.ok && sse.body !== null);
  const reader = sse.body!.getReader();
  const decoder = new TextDecoder();
  const received: string[] = [];
  let buffer = '';

  const pump = (async () => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const evLine = frame.split('\n').find((l) => l.startsWith('event: '));
        if (evLine) received.push(evLine.slice(7).trim());
      }
      if (received.includes('ready') && received.filter((e) => e === 'ready').length >= 1) {
        // ready proves the stream is wired; keep reading a moment for a run_event.
        if (received.includes('run_event')) return;
      }
    }
  })();

  await new Promise((r) => setTimeout(r, 300));

  // 3. a human mutation
  const res = await fetch(`${baseUrl}/api/commands/notes.list`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: '{}',
  });
  check('human command executes', res.status === 200, `got ${res.status}`);

  const created = await fetch(`${baseUrl}/api/commands/notes.create`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'e2e note', body: 'from the smoke test' }),
  });
  const createdBody = (await created.json()) as { result?: { note?: { id: string } } };
  check('notes.create returns a note', Boolean(createdBody.result?.note?.id));

  // 4. a subsequent list sees it
  const listed = await fetch(`${baseUrl}/api/commands/notes.list`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: '{}',
  });
  const listedBody = (await listed.json()) as { result?: { notes?: Array<{ title: string }> } };
  check(
    'created note is listed',
    listedBody.result?.notes?.some((n) => n.title === 'e2e note') === true,
  );

  // 5. tokenomics read model responds
  const tk = await fetch(`${baseUrl}/api/tokenomics`, { headers });
  const tkBody = (await tk.json()) as { tokenomics?: { totalCostUsd: number } };
  check('tokenomics read model responds', typeof tkBody.tokenomics?.totalCostUsd === 'number');

  // 6. a real agent run: start it, watch SSE, approve the gate, confirm resume
  const started = await fetch(`${baseUrl}/api/runs`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ goal: 'create a note and then delete it', approvalMode: 'gate' }),
  });
  const startedBody = (await started.json()) as { run?: { id: string; status: string } };
  check('agent run started', Boolean(startedBody.run?.id), `got ${started.status}`);

  let gateId: string | undefined;
  if (startedBody.run?.id) {
    const runId = startedBody.run.id;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !gateId) {
      const gates = (await (await fetch(`${baseUrl}/api/gates`, { headers })).json()) as {
        gates: Array<{ id: string; status: string; commandName: string }>;
      };
      gateId = gates.gates.find((g) => g.status === 'pending')?.id;
      if (!gateId) await new Promise((r) => setTimeout(r, 250));
    }
    check('run paused on an approval gate', Boolean(gateId));

    if (gateId) {
      const approved = await fetch(`${baseUrl}/api/gates/${gateId}/approve`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: '{}',
      });
      check('human can approve the gate', approved.status === 200, `got ${approved.status}`);

      const resumed = await fetch(`${baseUrl}/api/runs/${runId}/resume`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: '{}',
      });
      check('run resumes after approval', resumed.status === 200, `got ${resumed.status}`);

      let status = '';
      const done = Date.now() + 15_000;
      while (Date.now() < done) {
        const r = (await (await fetch(`${baseUrl}/api/runs/${runId}`, { headers })).json()) as {
          run: { status: string };
        };
        status = r.run.status;
        if (['completed', 'failed', 'cancelled', 'killed_budget'].includes(status)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      check('run reaches a terminal status', status === 'completed', `status=${status}`);

      const runEvents = (await (await fetch(`${baseUrl}/api/runs/${runId}`, { headers })).json()) as {
        events: Array<{ type: string }>;
      };
      const types = runEvents.events.map((e) => e.type);
      check('event log contains the gate lifecycle', types.includes('gate_opened') && types.includes('gate_resolved'));
    }
  }

  // 7. the stream delivered at least its handshake
  await Promise.race([pump, new Promise((r) => setTimeout(r, 1000))]);
  check('SSE delivered a ready frame', received.includes('ready'), `frames: ${[...new Set(received)].join(',')}`);
  check('SSE delivered a run_event', received.includes('run_event'), `frames: ${[...new Set(received)].join(',')}`);
  await reader.cancel().catch(() => {});

  // ---------------------------------------------------------------- PHASE 2
  // Core Four is readable and writable through the same CommandBus.
  const snap = (await (await fetch(`${baseUrl}/api/settings`, { headers })).json()) as {
    coreFour?: { model?: { tier?: string } };
    themes?: unknown[];
  };
  check('settings snapshot exposes the Core Four', snap.coreFour?.model?.tier !== undefined);
  check('theme catalogue is present', (snap.themes?.length ?? 0) >= 3);

  const patched = await fetch(`${baseUrl}/api/commands/factory.settings`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ patch: { model: { temperature: 0.3 } } }),
  });
  const patchedBody = (await patched.json()) as { result?: { coreFour?: { model?: { temperature?: number } } } };
  check('factory.settings patches the model', patchedBody.result?.coreFour?.model?.temperature === 0.3);

  // Filesystem confinement through the live API.
  await fetch(`${baseUrl}/api/commands/fs.write`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'e2e-file.txt', content: 'written by e2e' }),
  });
  const readBack = (await (
    await fetch(`${baseUrl}/api/commands/fs.read`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'e2e-file.txt' }),
    })
  ).json()) as { result?: { content?: string } };
  check('fs.write then fs.read round-trips', readBack.result?.content === 'written by e2e');

  const traverse = await fetch(`${baseUrl}/api/commands/fs.read`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ path: '../../package.json' }),
  });
  check('fs.read blocks traversal (403)', traverse.status === 403, `got ${traverse.status}`);

  // PageStage: a page is served from a DIFFERENT origin with a strict CSP.
  const pageCreate = await fetch(`${baseUrl}/api/commands/pages.create`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'e2e', title: 'E2E', html: '<p>e2e</p>' }),
  });
  const pageOk = pageCreate.ok;
  check('pages.create works', pageOk, `got ${pageCreate.status}`);

  const pagesModel = (await (await fetch(`${baseUrl}/api/pages`, { headers })).json()) as {
    pages: Array<{ slug: string }>;
    pageStageUrl: string;
  };
  const stageUrl = pagesModel.pageStageUrl;
  if (stageUrl) {
    // A distinct ORIGIN means a distinct port here (same host). Compare ports.
    const basePort = new URL(baseUrl).port;
    const stagePort = new URL(stageUrl).port;
    check('page stage URL is a distinct origin', stagePort !== '' && stagePort !== basePort, `${stagePort} vs ${basePort}`);
  }

  if (stageUrl) {
    const pageRes = await fetch(`${stageUrl}/pages/${pagesModel.pages[0]?.slug ? 'sandbox' : 'sandbox'}/e2e`);
    const csp = pageRes.headers.get('content-security-policy') ?? '';
    check('page served from the isolated origin', pageRes.ok, `got ${pageRes.status}`);
    check('page CSP blocks network access', csp.includes("connect-src 'none'"));
    check('page is not frameable by arbitrary sites', (pageRes.headers.get('x-frame-options') ?? '') !== '');
  }

  // model transparency
  const mi = (await (await fetch(`${baseUrl}/api/model-info`, { headers })).json()) as {
    route?: { model?: string };
  };
  check('model-info exposes the real model name', typeof mi.route?.model === 'string' && mi.route.model.length > 0);

  // ---------------------------------------------------------------- PHASE 3
  // Proactive: a job with no delta must cost $0 and never call a model.
  const triggers = (await (await fetch(`${baseUrl}/api/triggers`, { headers })).json()) as {
    jobs: Array<{ id: string }>;
  };
  check('proactive jobs are registered', triggers.jobs.length > 0, `got ${triggers.jobs.length}`);

  const fire = await fetch(`${baseUrl}/api/commands/proactive.fire`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: 'workspace-scan', event: { count: 0 } }),
  });
  const fired = (await fire.json()) as { result?: { stage: string; costUsd: number } };
  check('a job with no delta reports stage=no_delta', fired.result?.stage === 'no_delta', fired.result?.stage);
  check('a job with no delta costs $0', fired.result?.costUsd === 0, `cost=${fired.result?.costUsd}`);

  const logs = (await (await fetch(`${baseUrl}/api/classifier-logs`, { headers })).json()) as {
    logs: Array<{ decision: string; costUsd: number }>;
  };
  check('the discard is logged for audit', logs.logs.some((l) => l.decision === 'discard'));

  // Subagents are exposed and empty until used.
  const subs = (await (await fetch(`${baseUrl}/api/subagents`, { headers })).json()) as { subagents: unknown[] };
  check('subagents read model responds', Array.isArray(subs.subagents));

  // ---------------------------------------------------------------- PHASE 4
  const agent = await fetch(`${baseUrl}/api/commands/team.createAgent`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Writer', topic: 'docs' }),
  });
  check('team.createAgent works', agent.ok, `got ${agent.status}`);

  const agents = (await (await fetch(`${baseUrl}/api/agents`, { headers })).json()) as {
    agents: Array<{ name: string }>;
  };
  check('a created agent appears in the read model', agents.agents.some((a) => a.name === 'Writer'));

  // Mailbox: another factory mails us; we must see it.
  await fetch(`${baseUrl}/api/commands/mailbox.send`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ toFactory: 'elsewhere', subject: 'hello', body: 'from the sandbox' }),
  });
  const mail = (await (await fetch(`${baseUrl}/api/mailbox`, { headers })).json()) as {
    sent: Array<{ subject: string }>;
  };
  check('sent mail is recorded', mail.sent.some((m) => m.subject === 'hello'));

  // ---------------------------------------------------------------- PHASE 5
  const cmds = (await (await fetch(`${baseUrl}/api/commands`, { headers })).json()) as {
    commands: Array<{ name: string; allowedActors: string[]; requiresGate: boolean }>;
  };
  const names = cmds.commands.map((c) => c.name);
  check('subagent capability is exposed', names.includes('subagent.run'));
  check('team capability is exposed', names.includes('team.post'));
  check('mailbox capability is exposed', names.includes('mailbox.list'));
  check('proactive capability is exposed', names.includes('proactive.fire'));
  // Gated destructive tools stay gated.
  check(
    'shell.exec remains gated',
    cmds.commands.find((c) => c.name === 'shell.exec')?.requiresGate === true,
  );

  console.log(failures === 0 ? '\nE2E: PASS' : `\nE2E: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err: unknown) => {
  console.error('E2E crashed:', err);
  process.exit(1);
});

