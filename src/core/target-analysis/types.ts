/**
 * The target deep-analysis result contract the background returns for `analyze-target` (the
 * popover's "Deep analysis" action). Pure data, JSON-serializable over runtime messaging.
 */
import type { JevAnalysisFailure } from '@/core/jev-client/client';
import type { JevVerdict } from '@/core/heuristic-engine';
import type { TargetReplyAngle } from '@/core/jev-client/config';

/** A completed deep analysis: the AI judgment for replying to this post. */
export interface TargetAnalysis {
  readonly kind: 'analyzed';
  readonly verdict: JevVerdict;
  /** The suggested reply angle, when the rubric produced one. */
  readonly angle?: TargetReplyAngle;
  /** `fresh` = a real Jev exchange just completed; `cache` = this post's stored verdict. */
  readonly source: 'fresh' | 'cache';
  readonly latencyMs?: number;
}

/**
 * Typed outcomes the popover renders distinctly:
 * - `disabled`: the master switch is off (defensive — the badge layer cannot be open then);
 * - `unavailable`: `jevForTargets` is off — Deep analysis is unavailable, badges stay local
 *   (VAL-SETUP-012);
 * - `no-key`: no Jev key configured;
 * - `error`: the exchange failed, typed so the popover can show a recoverable reason.
 */
export type TargetAnalysisResult =
  | TargetAnalysis
  | { readonly kind: 'disabled' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'no-key' }
  | { readonly kind: 'error'; readonly failure: JevAnalysisFailure };
