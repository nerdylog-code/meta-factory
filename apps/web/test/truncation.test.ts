import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapFactory, z, type Factory } from '@mf/core';
import { FakeLLMProvider } from '@mf/core';
import { HumanToken } from '@mf/core';
import type { LlmProvider, LlmRequest, LlmResponse } from '@mf/core';

const open: Array<Factory> = [];
afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

/**
 * A generated page or a long file write can exceed the output ceiling. When that
 * happens the tool arguments arrive as TRUNCATED JSON.
 *
 * Observed with a real model: `pages.create` was emitted twice with ~5.9k
 * characters of HTML, cut off mid-string, and every attempt failed schema
 * validation. The runner executed the broken call anyway and the model retried
 * until the turn limit — 12 tool calls, zero progress, run `failed`.
 *
 * The runner must instead (a) never execute truncated arguments, and (b) tell
 * the model to be smaller, a bounded number of times.
 */
function truncatingProvider(script: Array<'truncate' | { name: string; args: unknown }>): LlmProvider {
  let i = 0;
  return {
    name: 'truncating',
    model: 'truncating-model',
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      if (step === 'truncate') {
        return {
          content: '',
          // The arguments are a JSON prefix that never closes: exactly what a
          // token-limited response looks like.
          toolCalls: [{ id: `t${i}`, name: 'pages.create', arguments: '{"slug":"status","title":"Status","html":"<!DOCTYPE html><p>unterminated' }],
          usage: { tokensIn: 100, tokensOut: 8192, estimated: false },
          aborted: false,
          finishReason: 'length',
          model: 'truncating-model',
          provider: 'truncating',
        };
      }
      return {
        content: 'finished',
        toolCalls: [],
        usage: { tokensIn: 100, tokensOut: 10, estimated: false },
        aborted: false,
        finishReason: 'stop',
        model: 'truncating-model',
        provider: 'truncating',
      };
    },
  };
}

function build(provider: LlmProvider, maxOutputTokens?: number) {
  const factory = bootstrapFactory({
    factoryId: 'trunc',
    dbPath: ':memory:',
    port: 0,
    provider,
    humanToken: new HumanToken('f'.repeat(64)),
    harnesses: [],
  });
  let executed = 0;
  factory.bus.register({
    name: 'pages.create',
    description: 'create a page',
    inputSchema: z.object({ slug: z.string(), title: z.string(), html: z.string() }),
    allowedActors: ['human', 'lead'],
    idempotent: false,
    execute: () => {
      executed += 1;
      return { ok: true };
    },
  } as never);
  open.push(factory);
  return { factory, executed: () => executed, maxOutputTokens };
}

describe('output truncation is handled, not executed', () => {
  it('never executes a tool call whose arguments were cut off', async () => {
    const { factory, executed } = build(truncatingProvider(['truncate', 'truncate', 'truncate']));
    const run = await factory.runner.startRun({
      factoryId: 'trunc',
      goal: 'make a page',
      tier: 'B',
      poolId: factory.poolId,
      systemPrompt: 'sys',
      maxTurns: 6,
    });

    // The truncated tool never ran: its arguments could not have validated.
    expect(executed()).toBe(0);
    expect(run.status).toBe('failed');
  });

  it('records a truncation error in the event log', async () => {
    const { factory } = build(truncatingProvider(['truncate', 'truncate', 'truncate']));
    const run = await factory.runner.startRun({
      factoryId: 'trunc',
      goal: 'make a page',
      tier: 'B',
      poolId: factory.poolId,
      systemPrompt: 'sys',
      maxTurns: 6,
    });
    const errors = factory.runner.getEvents(run.id).filter((e) => e.type === 'error');
    expect(errors.length).toBeGreaterThan(0);
    const msg = (errors[0]!.payload as { message: string }).message;
    expect(msg).toMatch(/truncated/);
    expect(msg).toMatch(/discarded/);
  });

  it('nudges the model, then succeeds when it complies', async () => {
    const provider = truncatingProvider(['truncate', { name: 'pages.create', args: {} }]);
    const { factory } = build(provider);
    const run = await factory.runner.startRun({
      factoryId: 'trunc',
      goal: 'make a page',
      tier: 'B',
      poolId: factory.poolId,
      systemPrompt: 'sys',
      maxTurns: 6,
    });
    // After one truncation the run recovers and finishes.
    expect(run.status).toBe('completed');
    const types = factory.runner.getEvents(run.id).map((e) => e.type);
    expect(types.filter((t) => t === 'error').length).toBe(1);
  });

  it('stops after a bounded number of retries instead of burning the budget', async () => {
    const { factory } = build(truncatingProvider(['truncate']));
    const run = await factory.runner.startRun({
      factoryId: 'trunc',
      goal: 'make a page',
      tier: 'B',
      poolId: factory.poolId,
      systemPrompt: 'sys',
      maxTurns: 20,
    });
    expect(run.status).toBe('failed');
    // Two nudges allowed, then stop: far fewer than maxTurns.
    const turns = factory.runner.getEvents(run.id).filter((e) => e.type === 'turn_started').length;
    expect(turns).toBeLessThanOrEqual(4);
  });

  it('requests a ceiling large enough for a real page by default', async () => {
    // 2048 tokens could not fit the generated HTML that failed in production
    // (a ~5.9k character page). The exported constant is the contract.
    const core = await import('@mf/core');
    const ceiling = (core as unknown as { DEFAULT_MAX_OUTPUT_TOKENS?: number }).DEFAULT_MAX_OUTPUT_TOKENS;
    expect(ceiling, 'DEFAULT_MAX_OUTPUT_TOKENS must be exported').toBeGreaterThanOrEqual(8192);
  });
});


