import { describe, expect, it } from 'vitest';
import { buildOptimizerPipeline } from '@/core/optimizer/request';
import { parseOptimizeResponse } from '@/core/optimizer/response';
import { makeDraft } from '../helpers/draft';

/**
 * The optimizer's Jev wire contract: ONE request per optimize call (state + one `noul` question
 * per rewrite and per hashtag candidate — the type verified live in optimizer-noul-live.test.ts),
 * and strict response parsing into ranked variants/suggestions. Determinism is load-bearing: the
 * cache key and the E2E fixtures depend on identical drafts producing identical pipelines.
 */
const DRAFT = makeDraft();

function noulAnswer(probability: number): unknown {
  return { type: 'noul', noul: probability };
}

/** A well-formed live-style response for the pipeline's expected question ids. */
function responseFor(
  pipeline: ReturnType<typeof buildOptimizerPipeline>,
  probability: (id: string) => number,
): unknown {
  const answers: Record<string, unknown> = {};
  for (const id of pipeline.variantIds) answers[id] = noulAnswer(probability(id));
  for (const id of pipeline.hashtagIds) answers[id] = noulAnswer(probability(id));
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 1 } };
}

describe('optimizer request builder', () => {
  it('uses the verified model alias and puts the draft, context, and every rewrite in the state', () => {
    const pipeline = buildOptimizerPipeline(DRAFT);
    expect(pipeline.request.model).toBe('jev-latest');
    expect(pipeline.request.state).toContain(DRAFT.text);
    expect(pipeline.request.state).toMatch(/Context:/);
    expect(pipeline.request.state).toMatch(/Rewrite/);
    for (const variant of pipeline.variants) expect(pipeline.request.state).toContain(variant.text);
  });

  it('asks exactly one noul question per variant and one per hashtag candidate', () => {
    const pipeline = buildOptimizerPipeline(DRAFT);
    const questions = pipeline.request.questions as Record<string, { type: string }>;
    expect(Object.keys(questions).length).toBe(pipeline.variantIds.length + pipeline.hashtagIds.length);
    for (const id of pipeline.variantIds) expect(questions[id]!.type).toBe('noul');
    for (const id of pipeline.hashtagIds) expect(questions[id]!.type).toBe('noul');
  });

  it('carries at least one variant and at most five hashtag candidates', () => {
    const pipeline = buildOptimizerPipeline(DRAFT);
    expect(pipeline.variants.length).toBeGreaterThanOrEqual(1);
    expect(pipeline.hashtagIds.length).toBeLessThanOrEqual(5);
  });

  it('is deterministic for identical drafts (the cache identity depends on it)', () => {
    expect(buildOptimizerPipeline(DRAFT)).toEqual(buildOptimizerPipeline(makeDraft()));
  });
});

describe('optimizer response parser', () => {
  it('parses noul answers into variants and hashtag suggestions ranked by probability', () => {
    const pipeline = buildOptimizerPipeline(DRAFT);
    const byId: Record<string, number> = {};
    pipeline.variantIds.forEach((id, index) => (byId[id] = 0.9 - index * 0.1));
    pipeline.hashtagIds.forEach((id, index) => (byId[id] = 0.5 + index * 0.01));
    const parsed = parseOptimizeResponse(responseFor(pipeline, (id) => byId[id]!), pipeline);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.variants[0]!.probability).toBe(0.9);
    for (let index = 1; index < parsed.variants.length; index += 1) {
      expect(parsed.variants[index]!.probability).toBeLessThanOrEqual(parsed.variants[index - 1]!.probability);
    }
    for (let index = 1; index < parsed.hashtags.length; index += 1) {
      expect(parsed.hashtags[index]!.probability).toBeLessThanOrEqual(parsed.hashtags[index - 1]!.probability);
    }
  });

  it('breaks probability ties by generation order (deterministic presentation)', () => {
    const pipeline = buildOptimizerPipeline(DRAFT);
    const parsed = parseOptimizeResponse(responseFor(pipeline, () => 0.5), pipeline);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.variants.map((variant) => variant.id)).toEqual(pipeline.variants.map((variant) => variant.id));
  });

  it('builds a one-line rationale for each hashtag suggestion naming the draft term', () => {
    const pipeline = buildOptimizerPipeline(DRAFT);
    const parsed = parseOptimizeResponse(responseFor(pipeline, () => 0.8), pipeline);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (const suggestion of parsed.hashtags) {
      expect(suggestion.rationale).toMatch(/draft/i);
      expect(suggestion.rationale.length).toBeGreaterThan(10);
    }
  });

  it('rejects a missing answer, a wrong answer type, or an out-of-range probability as malformed', () => {
    const pipeline = buildOptimizerPipeline(DRAFT);
    const incomplete = responseFor(pipeline, () => 0.5) as { answers: Record<string, unknown> };
    delete incomplete.answers[pipeline.variantIds[0]!];
    expect(parseOptimizeResponse(incomplete, pipeline).ok).toBe(false);

    const wrongType = responseFor(pipeline, () => 0.5) as { answers: Record<string, unknown> };
    wrongType.answers[pipeline.variantIds[0]!] = { type: 'score', score: 3, confidence: 0.5, probabilities: {} };
    expect(parseOptimizeResponse(wrongType, pipeline).ok).toBe(false);

    const outOfRange = responseFor(pipeline, () => 0.5) as { answers: Record<string, unknown> };
    outOfRange.answers[pipeline.hashtagIds[0]!] = { type: 'noul', noul: 1.5 };
    expect(parseOptimizeResponse(outOfRange, pipeline).ok).toBe(false);
  });

  it('rejects a non-object payload outright', () => {
    const pipeline = buildOptimizerPipeline(DRAFT);
    expect(parseOptimizeResponse(null, pipeline).ok).toBe(false);
    expect(parseOptimizeResponse('nope', pipeline).ok).toBe(false);
  });
});
