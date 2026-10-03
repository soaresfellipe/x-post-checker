/**
 * AnalyzerService — orchestrates one draft analysis end to end (background only):
 *
 * 1. the local heuristic score ALWAYS runs (the overlay's "Algorithm signals" half);
 * 2. the Jev verdict runs when the master switch and `jevForDrafts` are on AND a key is present,
 *    through the JevClient (cache, coalescing, retry, rate limit, typed failures);
 * 3. every completed analysis is recorded via the settings store's `recordAnalysis({at, outcome})`
 *    so the popup's last-analysis status reflects reality.
 *
 * It never throws into the UI: every refusal and failure is a typed result the caller can render.
 */
import { isDraftEligible, type AnalysisTrigger, type DraftSnapshot } from '@/core/draft-snapshot';
import { composeHeadline, scoreDraft } from '@/core/heuristic-engine';
import { draftCacheKey } from '@/core/jev-client/hash';
import type { JevClient, JevDraftAnalysisResult } from '@/core/jev-client/client';
import type { JevAnalysisFailure } from '@/core/jev-client/client';
import type { SettingsStore } from '@/core/settings-store';
import type { DraftAnalysis, DraftAnalysisMeta, DraftAnalysisResult, JevHalfStatus } from './types';

export interface AnalyzerDeps {
  /** The background's own store: settings, the key, and the analysis recorder. */
  readonly store: SettingsStore;
  readonly jev: Pick<JevClient, 'analyzeDraft'>;
  readonly now?: () => number;
}

export interface AnalyzerService {
  analyzeDraft(draft: DraftSnapshot, trigger: AnalysisTrigger): Promise<DraftAnalysisResult>;
}

function statusForFailure(failure: JevAnalysisFailure): JevHalfStatus {
  switch (failure.kind) {
    case 'no-key':
      // The key vanished between the read and the call: local-only, not an error.
      return 'skipped-no-key';
    case 'network':
      return 'failed-network';
    case 'http-error':
      return 'failed-http';
    case 'malformed':
      return 'failed-malformed';
    case 'rate-limited':
      return 'rate-limited';
  }
}

export function createAnalyzerService(deps: AnalyzerDeps): AnalyzerService {
  const now = deps.now ?? Date.now;

  /**
   * Completes an analysis: stamps the meta, records the outcome for the popup, and returns the
   * merged result. A failed status write must never fail the analysis — it is bookkeeping.
   */
  async function finish(
    draft: DraftSnapshot,
    trigger: AnalysisTrigger,
    local: DraftAnalysis['local'],
    outcome: 'ok' | 'local-only' | 'error',
    status: JevHalfStatus,
    jev?: DraftAnalysis['jev'],
    extras: { latencyMs?: number; failure?: JevAnalysisFailure; mainWeakness?: DraftAnalysisMeta['mainWeakness'] } = {},
  ): Promise<DraftAnalysis> {
    const analyzedAt = now();
    const meta: DraftAnalysisMeta = {
      analyzedAt,
      trigger,
      draftHash: draftCacheKey(draft),
      headline: composeHeadline(local.headline, jev?.ordinal),
      jevStatus: status,
      ...(extras.latencyMs === undefined ? {} : { jevLatencyMs: extras.latencyMs }),
      ...(extras.failure === undefined ? {} : { jevFailure: extras.failure }),
      ...(extras.mainWeakness === undefined ? {} : { mainWeakness: extras.mainWeakness }),
    };
    await deps.store.recordAnalysis({ at: analyzedAt, outcome }).catch(() => undefined);
    return { kind: 'analyzed', local, ...(jev === undefined ? {} : { jev }), meta };
  }

  return {
    async analyzeDraft(draft, trigger) {
      // Defense in depth: the watcher gates on both, but the analyzer is the last line — it must
      // never score a draft the user's settings would not analyze, nor record a refusal as an
      // analysis.
      const settings = await deps.store.getSettings();
      if (!settings.enabled) return { kind: 'disabled' };
      if (!isDraftEligible(draft, settings.minDraftLength)) {
        return { kind: 'below-min-length', minDraftLength: settings.minDraftLength };
      }

      const local = scoreDraft(draft);

      if (!settings.jevForDrafts) {
        return finish(draft, trigger, local, 'local-only', 'skipped-disabled');
      }
      const apiKey = await deps.store.getApiKey();
      if (!apiKey) {
        return finish(draft, trigger, local, 'local-only', 'skipped-no-key');
      }

      const result: JevDraftAnalysisResult = await deps.jev.analyzeDraft({ apiKey, draft });
      if (result.ok) {
        return finish(draft, trigger, local, 'ok', result.source === 'cache' ? 'cached' : 'ok', result.verdict, {
          ...(result.latencyMs === undefined || result.source === 'cache' ? {} : { latencyMs: result.latencyMs }),
          mainWeakness: result.mainWeakness,
        });
      }
      return finish(draft, trigger, local, 'error', statusForFailure(result.failure), undefined, {
        failure: result.failure,
      });
    },
  };
}
