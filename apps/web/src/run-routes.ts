/**
 * Run lifecycle routes: POST /api/runs, POST /api/runs/:id/resume.
 *
 * These live in the app layer (not core) because they assemble a system prompt
 * from the registered harnesses. Provider selection stays in core: the runner
 * resolves provider+price from the run's tier via `providerFor`.
 */
import type { Hono } from 'hono';
import type { Env } from '@mf/core';
import {
  ConflictError,
  NotFoundError,
  type CommandBus,
  type DurableRunner,
  type FactoryConfig,
  type HarnessModule,
  type Tier,
} from '@mf/core';

export interface RunRouteDeps {
  runner: DurableRunner;
  bus: CommandBus;
  harnesses: HarnessModule[];
  config: FactoryConfig;
  /** Pool the run spends from. */
  defaultPoolId: string;
}

/**
 * Builds the system prompt from harness sections.
 *
 * Pure so it can be unit-tested without a running server, and so the prompt a
 * run actually used can be reproduced from config + tool list.
 */
export function composeSystemPrompt(
  config: FactoryConfig,
  harnesses: HarnessModule[],
  toolNames: string[],
  agentPrompt: string,
): string {
  const sections = harnesses.map((h) =>
    h.renderPromptSection({
      actor: { kind: 'agent', role: 'lead', agentId: 'lead', runId: '', toolCallId: '' },
      toolNames,
      factoryName: config.name,
    }),
  );
  return [
    `You are the lead agent of "${config.title}" (${config.name}), a small software factory.`,
    agentPrompt,
    'Work in small steps. Use the provided tools; do not invent tool names.',
    'When a tool returns status "pending_approval", a human must approve it before it runs.',
    ...sections,
  ]
    .filter((s) => s && s.trim().length > 0)
    .join('\n\n');
}

export function registerRunRoutes(app: Hono<Env>, deps: RunRouteDeps): void {
  const leadTools = () => deps.bus.listToolsForActor('lead').map((t) => t.name);
  const agentPrompt = (id: string) => deps.config.agents.find((a) => a.id === id)?.prompt ?? '';
  const promptFor = () => composeSystemPrompt(deps.config, deps.harnesses, leadTools(), agentPrompt('lead'));

  app.post('/api/runs', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { goal?: unknown; tier?: unknown };
    const goal = typeof body.goal === 'string' && body.goal.trim() ? body.goal.trim() : null;
    if (!goal) {
      return c.json({ error: { code: 'VALIDATION_FAILED', message: 'goal is required' } }, 400);
    }
    const tier = (typeof body.tier === 'string' ? body.tier : deps.config.tier) as Tier;

    const run = deps.runner.createRun({
      factoryId: deps.config.name,
      goal,
      tier,
      poolId: deps.defaultPoolId,
      systemPrompt: promptFor(),
    });

    // Kick off without awaiting: the client watches progress over SSE. Errors
    // are recorded in the event log by the runner itself.
    void deps.runner
      .startExisting(run.id, {
        factoryId: deps.config.name,
        goal,
        tier,
        poolId: deps.defaultPoolId,
        systemPrompt: promptFor(),
        maxTurns: 6,
      })
      .catch((err: unknown) => console.error('[run] start failed', err));

    return c.json({ run: deps.runner.getRun(run.id) ?? run }, 202);
  });

  app.post('/api/runs/:id/resume', async (c) => {
    const id = c.req.param('id');
    const run = deps.runner.getRun(id);
    if (!run) throw new NotFoundError(`Run ${id} not found`);
    if (['completed', 'failed', 'cancelled', 'killed_budget'].includes(run.status)) {
      throw new ConflictError(`Run ${id} is already ${run.status}`);
    }

    void deps.runner.resumeRun(id, { systemPrompt: promptFor() }).catch((err: unknown) => {
      console.error('[run] resume failed', err);
    });

    return c.json({ run: deps.runner.getRun(id) });
  });
}
