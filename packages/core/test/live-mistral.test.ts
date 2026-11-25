/**
 * Live provider test against the real Mistral API.
 *
 * Opt-in: skipped unless MISTRAL_API_KEY is set, so the suite stays green
 * offline and in CI without secrets. This is the test that proves the adapter
 * is not vouching for itself with a mock.
 *
 * Run:  $env:MISTRAL_API_KEY='...'; pnpm test
 */
import { describe, expect, it } from 'vitest';
import { OpenAiCompatibleProvider } from '../src/llm/openai-compatible.js';
import { getModelPrice } from '../src/llm/pricing.js';

const apiKey = process.env.MISTRAL_API_KEY;
const hasKey = typeof apiKey === 'string' && apiKey.length > 0;

const provider = hasKey
  ? new OpenAiCompatibleProvider({
      name: 'mistral',
      baseUrl: process.env.MISTRAL_BASE_URL ?? 'https://api.mistral.ai/v1',
      apiKey: apiKey!,
      model: process.env.MISTRAL_MODEL ?? 'deepseek-v4-1-flash-1017',
      unitPriceInUsd: getModelPrice(process.env.MISTRAL_MODEL ?? 'deepseek-v4-1-flash-1017').in,
      unitPriceOutUsd: getModelPrice(process.env.MISTRAL_MODEL ?? 'deepseek-v4-1-flash-1017').out,
      timeoutMs: 60_000,
    })
  : null;

describe.skipIf(!hasKey)('live Mistral provider', () => {
  it('completes a trivial prompt and reports real usage', async () => {
    const res = await provider!.complete({
      tier: 'S',
      messages: [{ role: 'user', content: 'Reply with exactly the word: OK' }],
      maxOutputTokens: 16,
      temperature: 0,
    });
    expect(res.content.toUpperCase()).toContain('OK');
    expect(res.usage.tokensIn).toBeGreaterThan(0);
    expect(res.usage.tokensOut).toBeGreaterThan(0);
    // A real provider reports usage; if it did not, the ledger would mark it estimated.
    expect(res.provider).toBe('mistral');
  }, 90_000);

  it('emits a valid tool call for a schema-shaped request', async () => {
    const res = await provider!.complete({
      tier: 'S',
      messages: [{ role: 'user', content: 'Create a note whose body is "hello world". Use the tool.' }],
      tools: [
        {
          name: 'notes.create',
          description: 'Create a note',
          inputSchema: {
            type: 'object',
            properties: { body: { type: 'string' } },
            required: ['body'],
            additionalProperties: false,
          },
        },
      ],
      maxOutputTokens: 128,
      temperature: 0,
    });

    expect(res.toolCalls.length).toBeGreaterThan(0);
    const call = res.toolCalls[0]!;
    expect(call.name).toBe('notes.create');
    // The arguments must be parseable JSON matching the schema — this is what
    // the bus will validate, so a malformed payload here would fail in prod.
    const args = JSON.parse(call.arguments) as { body: string };
    expect(typeof args.body).toBe('string');
  }, 90_000);

  it('the cheap Tier-D model answers, so tool summaries/classifier are usable', async () => {
    const cheap = new OpenAiCompatibleProvider({
      name: 'mistral',
      baseUrl: process.env.MISTRAL_BASE_URL ?? 'https://api.mistral.ai/v1',
      apiKey: apiKey!,
      model: 'ministral-3b-latest',
      unitPriceInUsd: getModelPrice('ministral-3b-latest').in,
      unitPriceOutUsd: getModelPrice('ministral-3b-latest').out,
      timeoutMs: 60_000,
    });
    const res = await cheap.complete({
      tier: 'D',
      messages: [
        {
          role: 'user',
          content: 'Summarize in one short line: read config.yaml, wrote index.ts, ran tests.',
        },
      ],
      maxOutputTokens: 64,
      temperature: 0,
    });
    expect(res.content.length).toBeGreaterThan(0);
  }, 90_000);
});
