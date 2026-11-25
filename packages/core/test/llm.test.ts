import { describe, expect, it } from 'vitest';
import { OpenAiCompatibleProvider } from '../src/llm/openai-compatible.js';
import { LlmRouter, RouterConfigSchema } from '../src/llm/router.js';
import { FakeLLMProvider } from '../src/llm/fake.js';
import { getModelPrice } from '../src/llm/pricing.js';

/** Records the request it was given and replays a canned OpenAI-shaped body. */
function stubFetch(body: unknown, init?: { status?: number; capture?: (req: { url: string; body: unknown; headers: Record<string, string> }) => void }) {
  return (async (url: string | URL | Request, opts?: RequestInit) => {
    init?.capture?.({
      url: String(url),
      body: JSON.parse(String(opts?.body ?? '{}')),
      headers: opts?.headers as Record<string, string>,
    });
    return new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('OpenAiCompatibleProvider', () => {
  it('sends tool definitions as JSON Schema and parses tool calls back', async () => {
    let captured: { url: string; body: unknown; headers: Record<string, string> } | undefined;
    const provider = new OpenAiCompatibleProvider({
      name: 'mistral',
      baseUrl: 'https://api.mistral.ai/v1',
      apiKey: 'test-key',
      model: 'deepseek-v4-1-flash-1017',
      unitPriceInUsd: 0.14,
      unitPriceOutUsd: 0.28,
      fetchImpl: stubFetch(
        {
          model: 'deepseek-v4-1-flash-1017',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: '',
                tool_calls: [
                  { id: 'abc', type: 'function', function: { name: 'notes.list', arguments: '{"x":1}' } },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        },
        { capture: (c) => (captured = c) },
      ),
    });

    const res = await provider.complete({
      tier: 'S',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'notes.list', description: 'list notes', inputSchema: { type: 'object', properties: {} } }],
      maxOutputTokens: 256,
    });

    expect(captured!.url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(captured!.headers.authorization).toBe('Bearer test-key');
    const body = captured!.body as { tools: Array<{ function: { name: string; parameters: unknown } }> };
    expect(body.tools[0]!.function.name).toBe('notes.list');
    expect(body.tools[0]!.function.parameters).toEqual({ type: 'object', properties: {} });

    expect(res.toolCalls).toEqual([{ id: 'abc', name: 'notes.list', arguments: '{"x":1}' }]);
    expect(res.finishReason).toBe('tool_calls');
    expect(res.usage).toEqual({ tokensIn: 100, tokensOut: 20, estimated: false });
  });

  it('flags usage as estimated when the provider omits it', async () => {
    const provider = new OpenAiCompatibleProvider({
      name: 'mistral',
      baseUrl: 'https://api.mistral.ai/v1',
      apiKey: 'k',
      model: 'm',
      unitPriceInUsd: 1,
      unitPriceOutUsd: 1,
      fetchImpl: stubFetch({
        choices: [{ finish_reason: 'stop', message: { content: 'hello there world' } }],
        // no usage
      }),
    });
    const res = await provider.complete({ tier: 'B', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 64 });
    expect(res.usage.estimated).toBe(true);
    expect(res.usage.tokensOut).toBeGreaterThan(0);
  });

  it('surfaces provider HTTP errors with status and body', async () => {
    const provider = new OpenAiCompatibleProvider({
      name: 'mistral',
      baseUrl: 'https://api.mistral.ai/v1',
      apiKey: 'k',
      model: 'm',
      unitPriceInUsd: 1,
      unitPriceOutUsd: 1,
      fetchImpl: stubFetch({ error: { message: 'quota exceeded' } }, { status: 429 }),
    });
    await expect(
      provider.complete({ tier: 'B', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10 }),
    ).rejects.toMatchObject({ name: 'ProviderHttpError', status: 429 });
  });

  it('encodes assistant tool calls and tool results in the wire format', async () => {
    let captured: unknown;
    const provider = new OpenAiCompatibleProvider({
      name: 'mistral',
      baseUrl: 'https://api.mistral.ai/v1',
      apiKey: 'k',
      model: 'm',
      unitPriceInUsd: 1,
      unitPriceOutUsd: 1,
      fetchImpl: stubFetch({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }, { capture: (c) => (captured = c.body) }),
    });
    await provider.complete({
      tier: 'B',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'notes.list', arguments: '{}' }] },
        { role: 'tool', toolCallId: 't1', name: 'notes.list', content: '{"status":"ok"}' },
      ],
      maxOutputTokens: 10,
    });
    const msgs = (captured as { messages: unknown[] }).messages;
    expect(msgs[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'notes.list', arguments: '{}' } }],
    });
    expect(msgs[2]).toMatchObject({ role: 'tool', tool_call_id: 't1' });
  });
});

describe('FakeLLMProvider', () => {
  it('fails loudly when the script runs out instead of returning empty content', async () => {
    const fake = new FakeLLMProvider({ script: [{ type: 'text', content: 'once' }] });
    await fake.complete({ tier: 'B', messages: [], maxOutputTokens: 10 });
    await expect(fake.complete({ tier: 'B', messages: [], maxOutputTokens: 10 })).rejects.toThrow(/exhausted/);
  });

  it('supports per-tier scripts', async () => {
    const fake = new FakeLLMProvider({
      script: [{ type: 'text', content: 'default' }],
      scripts: { D: [{ type: 'text', content: 'cheap' }] },
    });
    const a = await fake.complete({ tier: 'S', messages: [], maxOutputTokens: 10 });
    const b = await fake.complete({ tier: 'D', messages: [], maxOutputTokens: 10 });
    expect(a.content).toBe('default');
    expect(b.content).toBe('cheap');
  });
});

describe('LlmRouter', () => {
  const config = RouterConfigSchema.parse({
    providers: [{ id: 'mistral', kind: 'openai-compatible', baseUrl: 'https://api.mistral.ai/v1' }],
    routes: [
      { tier: 'S', providerId: 'mistral', model: 'deepseek-v4-1-flash-1017' },
      { tier: 'D', providerId: 'mistral', model: 'ministral-3b-latest' },
    ],
  });

  it('exposes the real model names behind each tier', () => {
    const router = new LlmRouter(config, { resolveApiKey: () => 'k' });
    const routes = router.describeRoutes();
    expect(routes.find((r) => r.tier === 'S')!.model).toBe('deepseek-v4-1-flash-1017');
    expect(routes.find((r) => r.tier === 'D')!.model).toBe('ministral-3b-latest');
  });

  it('returns the price snapshot alongside the response', async () => {
    const router = new LlmRouter(config, { resolveApiKey: () => 'k' });
    router.setProvider('mistral', new FakeLLMProvider({ script: [{ type: 'text', content: 'x' }], model: 'deepseek-v4-1-flash-1017' }));
    const call = await router.call('S', { messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 10 });
    expect(call.price).toEqual({ in: getModelPrice('deepseek-v4-1-flash-1017').in, out: getModelPrice('deepseek-v4-1-flash-1017').out });
  });

  it('throws a clear error when the tier has no available provider', async () => {
    const router = new LlmRouter(config, { resolveApiKey: () => undefined });
    await expect(
      router.call('S', { messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 10 }),
    ).rejects.toThrow(/not available for tier S/);
  });

  it('compacts only when the prompt exceeds the configured ratio', async () => {
    const router = new LlmRouter(
      RouterConfigSchema.parse({
        ...config,
        compaction: { enabled: true, triggerRatio: 0.5, keepLastMessages: 2 },
      }),
      { resolveApiKey: () => 'k' },
    );
    router.route('S').contextLimitTokens = 100; // tiny, to force the trigger

    let compacted = false;
    const small = await router.maybeCompact([{ role: 'user', content: 'hi' }], 'S', async (m) => {
      compacted = true;
      return m;
    });
    expect(small.compacted).toBe(false);

    const big = await router.maybeCompact(
      [{ role: 'user', content: 'x'.repeat(2000) }],
      'S',
      async (m) => {
        compacted = true;
        return [{ role: 'system', content: 'summary' }, ...m.slice(-1)];
      },
    );
    expect(compacted).toBe(true);
    expect(big.compacted).toBe(true);
    expect(big.messages[0]!.content).toBe('summary');
  });
});
