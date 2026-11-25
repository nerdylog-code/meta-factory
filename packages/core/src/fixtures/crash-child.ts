/**
 * Child process used by `crash-recovery.test.ts`.
 *
 * Built to `dist/` alongside core, then invoked as a plain .mjs so it can be
 * spawned from any cwd. It builds a real on-disk factory, writes the exact
 * durable marker a crash leaves behind, and hard-exits.
 */
import { z } from 'zod';
import { BudgetEnforcer } from '../budget/enforcer.js';
import { TokenLedger } from '../budget/ledger.js';
import { CommandBus, SqliteGateStore } from '../bus/command-bus.js';
import { openDb } from '../db/client.js';
import { FakeLLMProvider } from '../llm/fake.js';
import { DurableRunner } from '../runner/durable-runner.js';
import type { RunEvent } from '../runner/events.js';

const dbPath = process.argv[2];
const mode = process.argv[3];
const toolName = process.argv[4] ?? 'notes.create';
if (!dbPath) throw new Error('usage: crash-child.js <dbPath> <mode> [toolName] [runId]');

const db = openDb({ path: dbPath });
const bus = new CommandBus(db);
const ledger = new TokenLedger(db);
const budget = new BudgetEnforcer(db);
const gates = new SqliteGateStore(db);
bus.setGateStore(gates);

const provider = new FakeLLMProvider({
  script: [{ type: 'tool_call', name: toolName, args: { name: 'x' }, callId: 'tc-die' }],
});

bus.register({
  name: toolName,
  description: 'test tool',
  inputSchema: z.object({ name: z.string() }),
  allowedActors: ['human', 'lead'],
  idempotent: toolName === 'fs.read',
  execute: () => ({ ok: true }),
});

if (mode === 'die-after-start') {
  const poolRow = db
    .prepare(`SELECT id FROM budget_pools WHERE owner_kind = 'run' ORDER BY created_at LIMIT 1`)
    .get() as { id: string } | undefined;
  const poolId = poolRow?.id ?? budget.createPool({ ownerKind: 'run', ownerId: 'r', amountUsd: 1 }).id;

  const runner = new DurableRunner({ db, bus, ledger, budget, provider, price: { in: 0, out: 0 } });
  const run = runner.createRun({
    factoryId: 'crash-test',
    goal: 'call the tool then die',
    tier: 'B',
    poolId,
    systemPrompt: '',
  });

  runner.appendEvents(run.id, [
    {
      type: 'tool_call_started',
      payload: { toolCallId: 'tc-die', name: toolName, input: { name: 'x' }, idempotent: toolName === 'fs.read' },
    },
  ]);
  process.stdout.write(JSON.stringify({ runId: run.id }));
  // Exit while the log ends mid-call. No close(), no cleanup.
  process.exit(0);
}

if (mode === 'recover') {
  const runner = new DurableRunner({ db, bus, ledger, budget, provider, price: { in: 0, out: 0 } });
  const runId = process.argv[5];
  if (!runId) throw new Error('recover mode requires <runId> as argv[5]');
  const state = runner.recoverRun(runId);
  const results = await runner.reconcileDanglingTools(runId);
  const after = runner.recoverRun(runId);

  process.stdout.write(
    JSON.stringify({
      danglingBefore: state.dangling.length,
      danglingAfter: after.dangling.length,
      results,
      eventTypes: (runner.getEvents(runId) as RunEvent[]).map((e) => e.type),
    }),
  );
  db.close();
  process.exit(0);
}
