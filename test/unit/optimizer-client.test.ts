import { describe, expect, it } from 'vitest';
import { createJevClient } from '../../src/core/jev-client/client';
import { buildOptimizerPipeline } from '../../src/core/optimizer/request';
import { makeDraft } from '../helpers/draft';

/**
 * The JevClient's optimize exchange (the transport-level half of m4-optimizer): ONE request per
 * optimize call carrying the noul pipeline, cached and coalesced per draft so repeated Optimize
 * on an unchanged draft produces at most one API call (VAL-OPT-009), with the client's standard
 * typed failures for everything else.
 */
const DRAFT = makeDraft();

function noulOptimizeResponse(pipeline: ReturnType<typeof buildOptimizerPipeline>): unknown {
  const answers: Record<string, unknown> = {};
  pipeline.variantIds.forEach((id, index) => (answers[id] = { type: 'noul', noul: 0.9 - index * 0.1 }));
  pipeline.hashtagIds.forEach((id, index) => (answers[id] = { type: 'noul', noul: 0.6 + index * 0.01 }));
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 10 } };
}

function fetchCounting(response: unknown): { fetchImpl: (url: string, init: RequestInit) => Promise<Response>; calls: () => number; bodies: () => unknown[] } {
  const bodies: unknown[] = [];
  return {
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    calls: () => bodies.length,
    bodies: () => bodies,
  };
}

describe('JevClient.optimizeDraft (VAL-OPT-009 wire half)', () => {
  it('sends one request with the noul optimize questions and returns ranked results', async () => {
    const pipeline = buildOptimizerPipeline(DRAFT);
    const harness = fetchCounting(noulOptimizeResponse(pipeline));
    const client = createJevClient({ fetchImpl: harness.fetchImpl });

    const result = await client.optimizeDraft({ apiKey: 'k', draft: DRAFT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe('fresh');
    expect(result.variants.length).toBeGreaterThanOrEqual(1);
    expect(result.variants[0]!.probability).toBe(0.9);
    expect(result.hashtags.length).toBeGreaterThanOrEqual(1);
    expect(harness.calls()).toBe(1);

    const body = harness.bodies()[0] as { questions: Record<string, { type: string }>; state: string };
    for (const id of pipeline.variantIds) expect(body.questions[id]!.type).toBe('noul');
    expect(body.state).toContain(DRAFT.text);
  });

  it('serves an identical draft from cache without a second request', async () => {
    const pipeline = buildOptimizerPipeline(DRAFT);
    const harness = fetchCounting(noulOptimizeResponse(pipeline));
    const client = createJevClient({ fetchImpl: harness.fetchImpl });

    const first = await client.optimizeDraft({ apiKey: 'k', draft: DRAFT });
    const second = await client.optimizeDraft({ apiKey: 'k', draft: { ...DRAFT, capturedAt: DRAFT.capturedAt + 1 } });
    if (!first.ok || !second.ok) throw new Error('expected both exchanges to succeed');
    expect(first.source).toBe('fresh');
    expect(second.source).toBe('cache');
    expect(second.variants).toEqual(first.variants);
    expect(second.hashtags).toEqual(first.hashtags);
    expect(harness.calls()).toBe(1);
  });

  it('coalesces concurrent optimize calls for the same draft into one request', async () => {
    const pipeline = buildOptimizerPipeline(DRAFT);
    const harness = fetchCounting(noulOptimizeResponse(pipeline));
    const client = createJevClient({ fetchImpl: harness.fetchImpl });

    const [a, b] = await Promise.all([
      client.optimizeDraft({ apiKey: 'k', draft: DRAFT }),
      client.optimizeDraft({ apiKey: 'k', draft: DRAFT }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(harness.calls()).toBe(1);
  });

  it('maps transport failures to typed failures without throwing', async () => {
    const client = createJevClient({
      fetchImpl: async () => new Response('nope', { status: 401 }),
      retry: { maxRetries: 0 },
    });
    const result = await client.optimizeDraft({ apiKey: 'k', draft: DRAFT });
    expect(result).toEqual({ ok: false, failure: { kind: 'http-error', status: 401 } });
  });

  it('refuses without a key before any request is made', async () => {
    const harness = fetchCounting(noulOptimizeResponse(buildOptimizerPipeline(DRAFT)));
    const client = createJevClient({ fetchImpl: harness.fetchImpl });
    const result = await client.optimizeDraft({ apiKey: undefined, draft: DRAFT });
    expect(result).toEqual({ ok: false, failure: { kind: 'no-key' } });
    expect(harness.calls()).toBe(0);
  });
});
