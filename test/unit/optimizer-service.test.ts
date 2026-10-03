import { describe, expect, it } from 'vitest';
import { createOptimizerService } from '../../src/core/optimizer/service';
import { draftCacheKey } from '../../src/core/jev-client/hash';
import { X_POST_LIMIT } from '../../src/core/optimizer/char-limit';
import type { JevClient, JevOptimizeResult } from '../../src/core/jev-client/client';
import type { SettingsStore } from '../../src/core/settings-store';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/settings-store';
import { makeDraft } from '../helpers/draft';

/**
 * The OptimizerService's background half (m4-optimizer): settings/key gates with honest typed
 * refusals, and the derivation of UI facts (X-weighted char flag, top-3 presentation cut, drop
 * advice) on top of the client's ranked exchange results. The cache/coalescing wire guarantees
 * live in the JevClient (optimizer-client.test.ts); the service adds none of its own.
 */
const DRAFT = makeDraft();
const LONG_HASHTAG_DRAFT = makeDraft({
  text: 'My productivity system now runs on one checklist and my focus deep work blocks.',
  hashtags: ['system', 'checklist', 'grind', 'hustle'],
});

function fakeStore(overrides: Partial<Settings> = {}, apiKey: string | null = 'key'): Pick<SettingsStore, 'getSettings' | 'getApiKey'> {
  const settings: Settings = { ...DEFAULT_SETTINGS, ...overrides };
  return {
    getSettings: () => Promise.resolve(settings),
    getApiKey: () => Promise.resolve(apiKey ?? undefined),
  };
}

/** A stub standing in for the real JevClient.optimizeDraft (client-shaped results). */
function fakeJev(result: JevOptimizeResult): Pick<JevClient, 'optimizeDraft'> {
  return { optimizeDraft: () => Promise.resolve(result) };
}

function clientSuccess(
  variants: Array<{ id: 'question' | 'number' | 'story' | 'claim'; kind: 'question' | 'number' | 'story' | 'claim'; text: string; probability: number }>,
  hashtags: Array<{ tag: string; rationale: string; probability: number }> = [],
): JevOptimizeResult {
  return { ok: true, variants, hashtags, source: 'fresh', latencyMs: 42 };
}

describe('OptimizerService gates (VAL-OPT-001)', () => {
  it('refuses with typed outcomes when the master switch is off, the AI lane is off, or the key is missing', async () => {
    const unreachable: JevOptimizeResult = { ok: false, failure: { kind: 'network', reason: 'unreachable' } };
    const service = createOptimizerService({ store: fakeStore({ enabled: false }), jev: fakeJev(unreachable) });
    expect(await service.optimizeDraft(DRAFT)).toEqual({ kind: 'disabled' });

    const unavailable = createOptimizerService({ store: fakeStore({ jevForDrafts: false }), jev: fakeJev(unreachable) });
    expect(await unavailable.optimizeDraft(DRAFT)).toEqual({ kind: 'unavailable' });

    const noKey = createOptimizerService({ store: fakeStore({}, null), jev: fakeJev(unreachable) });
    expect(await noKey.optimizeDraft(DRAFT)).toEqual({ kind: 'no-key' });
  });
});

describe('OptimizerService derivation', () => {
  it('stamps the draft identity, X-weighted char counts, the over-limit flag, and source/latency', async () => {
    const longText = `Hook ${'x'.repeat(X_POST_LIMIT)} tail`;
    const longDraft = makeDraft({ text: longText });
    const service = createOptimizerService({
      store: fakeStore(),
      jev: fakeJev(clientSuccess([{ id: 'story', kind: 'story', text: longText, probability: 0.9 }])),
    });

    const result = await service.optimizeDraft(longDraft);
    expect(result.kind).toBe('optimized');
    if (result.kind !== 'optimized') return;
    expect(result.optimization.draftHash).toBe(draftCacheKey(longDraft));
    const variant = result.optimization.variants[0]!;
    expect(variant.weightedChars).toBeGreaterThan(X_POST_LIMIT);
    expect(variant.overLimit).toBe(true);
    expect(result.optimization.source).toBe('fresh');
    expect(result.optimization.latencyMs).toBe(42);
  });

  it('presents at most three variants ranked best-first', async () => {
    const service = createOptimizerService({
      store: fakeStore(),
      jev: fakeJev(
        clientSuccess([
          { id: 'question', kind: 'question', text: 'q', probability: 0.9 },
          { id: 'number', kind: 'number', text: 'n', probability: 0.8 },
          { id: 'claim', kind: 'claim', text: 'c', probability: 0.5 },
          { id: 'story', kind: 'story', text: 's', probability: 0.4 },
        ]),
      ),
    });
    const result = await service.optimizeDraft(DRAFT);
    if (result.kind !== 'optimized') throw new Error('expected optimized');
    expect(result.optimization.variants.map((variant) => variant.id)).toEqual(['question', 'number', 'claim']);
  });

  it('caps hashtag suggestions at three and builds drop advice for excess draft hashtags', async () => {
    const service = createOptimizerService({
      store: fakeStore(),
      jev: fakeJev(
        clientSuccess([{ id: 'story', kind: 'story', text: 's', probability: 0.4 }], [
          { tag: 'Focus', rationale: 'r', probability: 0.9 },
          { tag: 'Checklist', rationale: 'r', probability: 0.8 },
        ]),
      ),
    });
    const result = await service.optimizeDraft(LONG_HASHTAG_DRAFT);
    if (result.kind !== 'optimized') throw new Error('expected optimized');
    expect(result.optimization.hashtags.suggestions.length).toBeLessThanOrEqual(3);
    expect(result.optimization.hashtags.dropAdvice).toBeTruthy();
    expect(result.optimization.hashtags.dropAdvice).toMatch(/drop/i);
  });

  it('gives no drop advice when the draft has at most three hashtags', async () => {
    const service = createOptimizerService({
      store: fakeStore(),
      jev: fakeJev(
        clientSuccess([{ id: 'story', kind: 'story', text: 's', probability: 0.4 }], [
          { tag: 'Focus', rationale: 'r', probability: 0.9 },
        ]),
      ),
    });
    const result = await service.optimizeDraft(DRAFT);
    if (result.kind !== 'optimized') throw new Error('expected optimized');
    expect(result.optimization.hashtags.dropAdvice).toBeUndefined();
  });

  it('passes typed failures through unchanged (non-blocking by contract)', async () => {
    const service = createOptimizerService({
      store: fakeStore(),
      jev: fakeJev({ ok: false, failure: { kind: 'network', reason: 'unreachable' } }),
    });
    expect(await service.optimizeDraft(DRAFT)).toEqual({
      kind: 'error',
      failure: { kind: 'network', reason: 'unreachable' },
    });
  });
});
