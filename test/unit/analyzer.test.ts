import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisTrigger, DraftSnapshot } from '@/core/draft-snapshot';
import { isDraftEligible } from '@/core/draft-snapshot';
import { composeHeadline, scoreDraft, toJevVerdict, type JevVerdict } from '@/core/heuristic-engine';
import { draftCacheKey } from '@/core/jev-client/hash';
import type { JevDraftAnalysisResult, JevAnalysisFailure } from '@/core/jev-client/client';
import { createAnalyzerService } from '@/core/analyzer';
import { createSettingsStore, LAST_ANALYSIS_STORAGE_KEY } from '@/core/settings-store';
import { createMemoryBackend } from '../helpers/memory-backend';
import { makeDraft } from '../helpers/draft';

const VERDICT: JevVerdict = toJevVerdict({ ordinal: 3.44, confidence: 0.65, weaknesses: ['Not specific enough.'] });

function makeJevClient(result: JevDraftAnalysisResult) {
  return {
    analyzeDraft: vi.fn(async () => result),
  };
}

function makeAnalyzer(options: {
  jevResult?: JevDraftAnalysisResult;
  failWrites?: boolean;
  now?: () => number;
} = {}) {
  const memory = createMemoryBackend({ failWrites: options.failWrites });
  const store = createSettingsStore(memory.backend);
  const jev = makeJevClient(options.jevResult ?? { ok: true, verdict: VERDICT, mainWeakness: 'not_specific_enough', source: 'fresh', latencyMs: 240 });
  const now = options.now ?? (() => 1_700_000_123_456);
  const analyzer = createAnalyzerService({ store, jev, now });
  return { analyzer, store, jev, memory, now };
}

describe('AnalyzerService analyzeDraft', () => {
  it('always computes the local heuristic score, even when the Jev half fails or is skipped', async () => {
    const failures: JevAnalysisFailure[] = [
      { kind: 'network', reason: 'timeout' },
      { kind: 'malformed' },
    ];
    for (const failure of failures) {
      const { analyzer } = makeAnalyzer({ jevResult: { ok: false, failure } });
      const draft = makeDraft();
      const result = await analyzer.analyzeDraft(draft, 'auto');
      if (result.kind !== 'analyzed') throw new Error('must be analyzed');
      expect(result.local).toEqual(scoreDraft(draft));
    }
  });

  it('merges a fresh Jev verdict into the approved {local, jev, meta} shape with the hybrid headline', async () => {
    const { analyzer, store } = makeAnalyzer();
    await store.setApiKey('test-key');
    const draft = makeDraft();
    const result = await analyzer.analyzeDraft(draft, 'auto');

    if (result.kind !== 'analyzed') throw new Error('must be analyzed');
    expect(result.local).toEqual(scoreDraft(draft));
    expect(result.jev).toEqual(VERDICT);
    expect(result.meta).toMatchObject({
      trigger: 'auto',
      jevStatus: 'ok',
      analyzedAt: 1_700_000_123_456,
      draftHash: draftCacheKey(draft),
      mainWeakness: 'not_specific_enough',
    });
    expect(result.meta.headline).toBe(composeHeadline(scoreDraft(draft).headline, 3.44));
    expect(result.meta.jevLatencyMs).toBe(240);
    expect(result.meta.jevFailure).toBeUndefined();
  });

  it('marks a cached verdict as cached and still records the analysis', async () => {
    const { analyzer, store } = makeAnalyzer({
      jevResult: { ok: true, verdict: VERDICT, mainWeakness: 'weak_hook', source: 'cache' },
    });
    await store.setApiKey('test-key');
    const result = await analyzer.analyzeDraft(makeDraft(), 'manual');
    if (result.kind !== 'analyzed') throw new Error('must be analyzed');
    expect(result.meta.jevStatus).toBe('cached');
    expect(await store.getLastAnalysis()).toEqual({ at: 1_700_000_123_456, outcome: 'ok' });
  });

  it('skips Jev locally when jevForDrafts is off: no request, no verdict, local-only record', async () => {
    const { analyzer, store, jev } = makeAnalyzer();
    await store.setApiKey('test-key');
    await store.setSettings({ jevForDrafts: false });

    const result = await analyzer.analyzeDraft(makeDraft(), 'auto');
    if (result.kind !== 'analyzed') throw new Error('must be analyzed');
    expect(result.jev).toBeUndefined();
    expect(result.meta.jevStatus).toBe('skipped-disabled');
    expect(result.meta.headline).toBe(result.local.headline); // local-only headline is unchanged
    expect(jev.analyzeDraft).not.toHaveBeenCalled();
    expect(await store.getLastAnalysis()).toEqual({ at: 1_700_000_123_456, outcome: 'local-only' });
  });

  it('skips Jev when no key is configured and records a local-only analysis (Connect Jev path)', async () => {
    const { analyzer, store, jev } = makeAnalyzer();
    const result = await analyzer.analyzeDraft(makeDraft(), 'auto');
    if (result.kind !== 'analyzed') throw new Error('must be analyzed');
    expect(result.jev).toBeUndefined();
    expect(result.meta.jevStatus).toBe('skipped-no-key');
    expect(jev.analyzeDraft).not.toHaveBeenCalled();
    expect(await store.getLastAnalysis()).toEqual({ at: 1_700_000_123_456, outcome: 'local-only' });
  });

  it('treats a key that disappears mid-analysis as skipped-no-key, not an error', async () => {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend);
    const jev = makeJevClient({ ok: false, failure: { kind: 'no-key' } });
    const analyzer = createAnalyzerService({ store, jev, now: () => 5 });
    await store.setApiKey('test-key');
    // The key is cleared between the analyzer's read and the Jev call:
    const analyze = analyzer.analyzeDraft(makeDraft(), 'auto');
    await store.clearApiKey();
    const result = await analyze;
    if (result.kind !== 'analyzed') throw new Error('must be analyzed');
    expect(result.meta.jevStatus).toBe('skipped-no-key');
    expect(await store.getLastAnalysis()).toEqual({ at: 5, outcome: 'local-only' });
  });

  it('maps every Jev failure mode to a typed local-only outcome, never throwing into the UI', async () => {
    const failures: JevAnalysisFailure[] = [
      { kind: 'network', reason: 'unreachable' },
      { kind: 'http-error', status: 503 },
      { kind: 'malformed' },
      { kind: 'rate-limited' },
    ];
    for (const failure of failures) {
      const { analyzer, store } = makeAnalyzer({ jevResult: { ok: false, failure } });
      await store.setApiKey('test-key');
      const result = await analyzer.analyzeDraft(makeDraft(), 'auto');
      if (result.kind !== 'analyzed') throw new Error('must be analyzed');
      expect(result.jev).toBeUndefined();
      expect(result.meta.jevStatus).toBe(
        failure.kind === 'network' ? 'failed-network' : failure.kind === 'http-error' ? 'failed-http' : failure.kind === 'malformed' ? 'failed-malformed' : 'rate-limited',
      );
      expect(result.meta.jevFailure).toEqual(failure);
      expect(result.meta.headline).toBe(result.local.headline);
      expect(await store.getLastAnalysis()).toEqual({ at: 1_700_000_123_456, outcome: 'error' });
    }
  });

  it('refuses politely when the master switch is off, and records nothing', async () => {
    const { analyzer, store, jev } = makeAnalyzer();
    await store.setSettings({ enabled: false });
    const result = await analyzer.analyzeDraft(makeDraft(), 'auto');
    expect(result).toEqual({ kind: 'disabled' });
    expect(jev.analyzeDraft).not.toHaveBeenCalled();
    expect(await store.getLastAnalysis()).toBeUndefined();
  });

  it('refuses drafts below minDraftLength with the configured threshold, and records nothing', async () => {
    const { analyzer, store, jev } = makeAnalyzer();
    const short = makeDraft({ text: 'too short' });
    expect(isDraftEligible(short, 10)).toBe(false);
    const result = await analyzer.analyzeDraft(short, 'auto');
    expect(result).toEqual({ kind: 'below-min-length', minDraftLength: 10 });
    expect(jev.analyzeDraft).not.toHaveBeenCalled();
    expect(await store.getLastAnalysis()).toBeUndefined();
  });

  it('passes the trigger through and stamps the analysis time at completion', async () => {
    let nowMs = 1_000;
    const { analyzer, store } = makeAnalyzer({
      now: () => nowMs,
      jevResult: {
        ok: true,
        verdict: VERDICT,
        mainWeakness: 'not_specific_enough',
        source: 'fresh',
        latencyMs: 10,
      },
    });
    await store.setApiKey('test-key');
    const analyze = analyzer.analyzeDraft(makeDraft(), 'manual');
    nowMs = 2_000; // the Jev exchange settles after the capture
    const result = await analyze;
    if (result.kind !== 'analyzed') throw new Error('must be analyzed');
    expect(result.meta.trigger).toBe('manual');
    expect(result.meta.analyzedAt).toBe(2_000);
  });

  it('keeps the analysis result when recording the outcome fails (the status write never breaks analysis)', async () => {
    const { analyzer, store } = makeAnalyzer({ failWrites: true });
    const result = await analyzer.analyzeDraft(makeDraft(), 'auto');
    if (result.kind !== 'analyzed') throw new Error('must be analyzed');
    expect(result.local).toBeDefined();
    expect(await store.getLastAnalysis()).toBeUndefined(); // nothing persisted — the write failed
  });

  it('records every completed analysis so the popup last-analysis status reflects reality', async () => {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend);
    const jev = makeJevClient({ ok: true, verdict: VERDICT, mainWeakness: 'not_specific_enough', source: 'fresh' });
    let at = 42;
    const analyzer = createAnalyzerService({ store, jev, now: () => at });
    await store.setApiKey('test-key');

    const triggers: AnalysisTrigger[] = ['auto', 'manual'];
    for (const trigger of triggers) {
      at += 1;
      await analyzer.analyzeDraft(makeDraft({ text: `draft ${trigger}` }), trigger);
      expect(memory.data[LAST_ANALYSIS_STORAGE_KEY]).toEqual({ at, outcome: 'ok' });
    }
  });
});

describe('AnalyzerService draft hashing for stale-response handling', () => {
  it('labels each reply with the draft hash the overlay can compare against', async () => {
    const { analyzer, store } = makeAnalyzer();
    await store.setApiKey('test-key');
    const draft: DraftSnapshot = makeDraft();
    const other = makeDraft({ isReply: true });
    const first = await analyzer.analyzeDraft(draft, 'auto');
    const second = await analyzer.analyzeDraft(other, 'auto');
    if (first.kind !== 'analyzed' || second.kind !== 'analyzed') throw new Error('must be analyzed');
    expect(first.meta.draftHash).toBe(draftCacheKey(draft));
    expect(second.meta.draftHash).toBe(draftCacheKey(other));
    expect(first.meta.draftHash).not.toBe(second.meta.draftHash);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
