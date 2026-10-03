/**
 * TargetAnalysisService — orchestrates one target deep analysis end to end (background only),
 * the popover-driven counterpart of the draft AnalyzerService:
 *
 * 1. refusals are honest and typed: master off (`disabled`), `jevForTargets` off
 *    (`unavailable` — VAL-SETUP-012: the target path stays local), or no key (`no-key`);
 * 2. otherwise the JevClient runs the exchange — its per-post cache and coalescing guarantee
 *    exactly one API call per post across close/reopen (VAL-TARGET-017/020).
 *
 * It never throws into the UI: every refusal and failure is a typed result the popover renders.
 * Target analyses deliberately do NOT write the draft `lastAnalysis` record — that record is the
 * draft-analysis lane's status (settings-store contract), not a count of AI calls.
 */
import type { PostSnapshot } from '@/core/post-snapshot';
import type { JevClient } from '@/core/jev-client/client';
import type { SettingsStore } from '@/core/settings-store';
import type { TargetAnalysisResult } from './types';

export interface TargetAnalyzerDeps {
  /** The background's own store: settings gate + key. */
  readonly store: Pick<SettingsStore, 'getSettings' | 'getApiKey'>;
  readonly jev: Pick<JevClient, 'analyzeTarget'>;
}

export interface TargetAnalysisService {
  analyzeTarget(post: PostSnapshot): Promise<TargetAnalysisResult>;
}

export function createTargetAnalysisService(deps: TargetAnalyzerDeps): TargetAnalysisService {
  return {
    async analyzeTarget(post) {
      const settings = await deps.store.getSettings();
      if (!settings.enabled) return { kind: 'disabled' };
      if (!settings.jevForTargets) return { kind: 'unavailable' };

      const apiKey = await deps.store.getApiKey();
      if (!apiKey) return { kind: 'no-key' };

      const result = await deps.jev.analyzeTarget({ apiKey, post });
      if (!result.ok) return { kind: 'error', failure: result.failure };
      return {
        kind: 'analyzed',
        verdict: result.verdict,
        ...(result.angle === undefined ? {} : { angle: result.angle }),
        source: result.source,
        ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
      };
    },
  };
}
