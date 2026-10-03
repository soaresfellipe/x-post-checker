/**
 * OptimizerService — orchestrates one draft optimization end to end (background only), the
 * "Optimize" counterpart of the AnalyzerService:
 *
 * 1. refusals are honest and typed: master off (`disabled`), `jevForDrafts` off (`unavailable` —
 *    the optimizer is an AI feature and stays off with the AI lane), or no key (`no-key` — the
 *    overlay's guidance points to Options, VAL-OPT-001);
 * 2. otherwise the JevClient runs the exchange — its per-draft optimizer cache and in-flight
 *    coalescing guarantee at most one API call per unique draft (VAL-OPT-009);
 * 3. the service derives the presentation facts (X-weighted char counts, over-limit flag,
 *    top-3 cuts, drop advice) on every read, so a config change re-derives without a new call.
 *
 * It never throws into the UI: every refusal and failure is a typed result the overlay renders
 * (VAL-OPT-010 — failures are non-blocking, local scoring and the composer untouched).
 */
import type { DraftSnapshot } from '@/core/draft-snapshot';
import type { JevClient } from '@/core/jev-client/client';
import { draftCacheKey } from '@/core/jev-client/hash';
import type { SettingsStore } from '@/core/settings-store';
import { OPTIMIZER_MAX_HASHTAG_SUGGESTIONS, OPTIMIZER_MAX_VARIANTS_PRESENTED } from './config';
import { isOverXLimit, weightedLength } from './char-limit';
import { buildDropAdvice } from './hashtags';
import type { OptimizationResult } from './types';

export interface OptimizerDeps {
  /** The background's own store: settings gate + key. */
  readonly store: Pick<SettingsStore, 'getSettings' | 'getApiKey'>;
  readonly jev: Pick<JevClient, 'optimizeDraft'>;
}

export interface OptimizerService {
  optimizeDraft(draft: DraftSnapshot): Promise<OptimizationResult>;
}

export function createOptimizerService(deps: OptimizerDeps): OptimizerService {
  return {
    async optimizeDraft(draft) {
      const settings = await deps.store.getSettings();
      if (!settings.enabled) return { kind: 'disabled' };
      if (!settings.jevForDrafts) return { kind: 'unavailable' };

      const apiKey = await deps.store.getApiKey();
      if (!apiKey) return { kind: 'no-key' };

      const result = await deps.jev.optimizeDraft({ apiKey, draft });
      if (!result.ok) return { kind: 'error', failure: result.failure };

      const variants = result.variants.slice(0, OPTIMIZER_MAX_VARIANTS_PRESENTED).map((variant) => {
        const weightedChars = weightedLength(variant.text);
        return { ...variant, weightedChars, overLimit: isOverXLimit(variant.text) };
      });
      const suggestions = result.hashtags.slice(0, OPTIMIZER_MAX_HASHTAG_SUGGESTIONS);
      const dropAdvice = buildDropAdvice(draft, suggestions);
      const optimization = {
        draftHash: draftCacheKey(draft),
        variants,
        hashtags: {
          suggestions,
          ...(dropAdvice === undefined ? {} : { dropAdvice }),
        },
        source: result.source,
        ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
      };
      return { kind: 'optimized', optimization };
    },
  };
}
