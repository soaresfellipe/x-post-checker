/**
 * The badges' view model: pure functions from (TargetScore, settings, key presence, per-post deep
 * analysis state) to what renders. DOM-free so every gate is unit-testable; the controller owns
 * the DOM.
 */
import type { JevAnalysisFailure } from '@/core/jev-client/client';
import type { TargetReplyAngle } from '@/core/jev-client/config';
import type { JevVerdict, SignalEntry, TargetScore } from '@/core/heuristic-engine';
import type { TargetAnalysisResult } from '@/core/target-analysis';
import { BADGE_COPY } from './config';

/** Badge gating (VAL-TARGET-005): eligible posts scoring at or above the configured threshold. */
export function isBadgeEligible(score: TargetScore, threshold: number): boolean {
  return score.eligible && score.headline >= threshold;
}

/**
 * The badge's concise reason: the contributing signal with the MOST points (scanner order breaks
 * ties), phrased from BADGE_COPY.reasons. Falls back to the eligibility line when nothing applied
 * points — the eligibility entry is itself a signal (VAL-TARGET-006).
 */
export function badgeReason(score: TargetScore): string {
  let best: SignalEntry | null = null;
  for (const signal of score.signals) {
    if (!signal.applied) continue;
    if (best === null || signal.points > best.points) best = signal;
  }
  if (best === null) return BADGE_COPY.reasons.eligibility;
  const phrases = BADGE_COPY.reasons as Readonly<Record<string, string>>;
  return phrases[best.id] ?? best.label;
}

/** Which state the popover's AI-judgment section shows. */
export type TargetAiState = 'idle' | 'pending' | 'verdict' | 'error' | 'off' | 'no-key';

export interface TargetAiSection {
  readonly state: TargetAiState;
  /** Present on 'verdict'. */
  readonly verdict?: JevVerdict;
  readonly angle?: TargetReplyAngle;
  /** Present on 'error': the human-readable reason line under the notice. */
  readonly reason?: string;
}

/** The human-readable reason line for a typed Jev failure (the notice always shows too). */
export function targetFailureReason(failure: JevAnalysisFailure): string {
  switch (failure.kind) {
    case 'network':
      return BADGE_COPY.errorReasons.network;
    case 'http-error':
      return BADGE_COPY.errorReasons.http(failure.status);
    case 'malformed':
      return BADGE_COPY.errorReasons.malformed;
    case 'rate-limited':
      return BADGE_COPY.errorReasons.rateLimited;
    case 'no-key':
      return `${BADGE_COPY.noKeyBefore}${BADGE_COPY.noKeyLink}${BADGE_COPY.noKeyAfter}`;
  }
}

export interface TargetAiSectionInputs {
  /** LIVE settings precedence (VAL-SETUP-012): `off` wins over any settled verdict. */
  readonly jevForTargets: boolean;
  readonly keyPresent: boolean;
  /** A deep-analysis dispatch for this post is in flight. */
  readonly pending: boolean;
  /** The latest settled deep-analysis result for this post, when one exists. */
  readonly settled: TargetAnalysisResult | null;
}

/**
 * Derives the AI section exactly like the overlay derives its Jev half: live settings first, then
 * the settled result, then the optimistic gate (key presence). `idle` is the pre-activation state
 * with the "Deep analysis" affordance.
 */
export function deriveTargetAiSection(inputs: TargetAiSectionInputs): TargetAiSection {
  if (!inputs.jevForTargets) return { state: 'off' };
  if (inputs.pending) return { state: 'pending' };
  if (inputs.settled) {
    const settled = inputs.settled;
    switch (settled.kind) {
      case 'analyzed':
        return { state: 'verdict', verdict: settled.verdict, angle: settled.angle };
      case 'no-key':
        return { state: 'no-key' };
      case 'error':
        return { state: 'error', reason: targetFailureReason(settled.failure) };
      case 'disabled':
      case 'unavailable':
        return { state: 'off' };
    }
  }
  if (!inputs.keyPresent) return { state: 'no-key' };
  return { state: 'idle' };
}
