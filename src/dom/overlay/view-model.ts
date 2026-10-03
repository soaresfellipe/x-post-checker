/**
 * The overlay's view model: a pure function from (latest capture, live settings, key presence,
 * in-flight dispatches, settled replies) to what the panel renders. DOM-free so every state
 * transition is unit-testable; `overlay.ts` owns the DOM.
 *
 * Timing contract (VAL-DRAFT-006): the LOCAL half renders from the capture alone — the pure
 * heuristic engine runs in the tab at capture time — so the local score never waits for the
 * analyze-draft roundtrip, let alone the Jev network call. The analyze-draft reply remains the
 * AUTHORITATIVE render (headline, verdict, typed failure notices) once it lands, keyed by
 * `meta.draftHash` so a stale reply can never overwrite a newer draft's result (VAL-DRAFT-011).
 */
import { isDraftEligible, type DraftSnapshot } from '@/core/draft-snapshot';
import { composeHeadline, scoreDraft } from '@/core/heuristic-engine';
import { draftCacheKey } from '@/core/jev-client/hash';
import type { DraftAnalysis } from '@/core/analyzer';
import type { JevAnalysisFailure } from '@/core/jev-client/client';
import type { Settings } from '@/core/settings-store';
import { OVERLAY_COPY } from './config';
import type { JevSection, OverlayView, OverlayViewInputs } from './types';

/** The draft identity replies are matched by: the Jev request identity of the snapshot. */
export function draftIdentity(snapshot: DraftSnapshot): string {
  return draftCacheKey(snapshot);
}

/** The human-readable reason line for a typed Jev failure (the notice always shows too). */
export function failureReason(failure: JevAnalysisFailure): string {
  switch (failure.kind) {
    case 'network':
      return OVERLAY_COPY.errorReasons.network;
    case 'http-error':
      return OVERLAY_COPY.errorReasons.http(failure.status);
    case 'malformed':
      return OVERLAY_COPY.errorReasons.malformed;
    case 'rate-limited':
      return OVERLAY_COPY.errorReasons.rateLimited;
    case 'no-key':
      // The analyzer maps a missing key to 'skipped-no-key' (the Connect Jev prompt), so a
      // no-key failure never reaches the error path; keeping the mapping total is still right.
      return OVERLAY_COPY.noKey;
  }
}

/**
 * Derives the Jev-half section for the current draft. A settled reply wins over the pending
 * state (a re-dispatch of an identical draft returns an identical result, so flipping back to a
 * spinner would only be noise); the optimistic phase decides from settings + key presence.
 */
function deriveJevSection(
  settings: Settings,
  keyPresent: boolean,
  reply: DraftAnalysis | null,
  transportFailed: boolean,
): JevSection {
  if (reply) {
    const { jevStatus, jevFailure } = reply.meta;
    if ((jevStatus === 'ok' || jevStatus === 'cached') && reply.jev) {
      return { state: 'verdict', verdict: reply.jev };
    }
    switch (jevStatus) {
      case 'skipped-no-key':
        return { state: 'no-key' };
      case 'skipped-disabled':
        return { state: 'off' };
      case 'failed-network':
      case 'failed-http':
      case 'failed-malformed':
      case 'rate-limited':
        return {
          state: 'error',
          reason: jevFailure ? failureReason(jevFailure) : OVERLAY_COPY.errorReasons.network,
        };
      default:
        return { state: 'off' };
    }
  }
  if (transportFailed) return { state: 'error', reason: OVERLAY_COPY.errorReasons.transport };
  if (!settings.jevForDrafts) return { state: 'off' };
  if (!keyPresent) return { state: 'no-key' };
  return { state: 'pending' };
}

export function deriveOverlayView(inputs: OverlayViewInputs): OverlayView {
  const { settings, keyPresent, capture, pending, reply, transportFailure } = inputs;
  if (!capture || !isDraftEligible(capture, settings.minDraftLength)) {
    return { phase: 'empty', minDraftLength: settings.minDraftLength };
  }

  const hash = draftIdentity(capture);
  const matchingReply = reply?.hash === hash ? reply.result : null;
  const hasAnalysis =
    (pending.get(hash) ?? 0) > 0 || matchingReply !== null || transportFailure?.hash === hash;
  if (!hasAnalysis) return { phase: 'ready' };

  const local = matchingReply?.local ?? scoreDraft(capture);
  const verdict = matchingReply?.jev;
  const jev = deriveJevSection(
    settings,
    keyPresent,
    matchingReply,
    transportFailure?.hash === hash && !matchingReply,
  );
  return {
    phase: 'analyzed',
    local,
    headline: matchingReply ? matchingReply.meta.headline : composeHeadline(local.headline, verdict?.ordinal),
    headlineSource: verdict ? 'hybrid' : 'local',
    jev,
  };
}
