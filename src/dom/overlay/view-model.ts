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
import { neutralCount, signalChips, summaryPhrases } from './chips';
import { OVERLAY_COPY } from './config';
import type { JevSection, OptimizerSection, OptimizerSlot, OverlayView, OverlayViewInputs } from './types';

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
      return `${OVERLAY_COPY.noKeyLongBefore}${OVERLAY_COPY.noKeyLink}${OVERLAY_COPY.noKeyLongAfter}`;
  }
}

/** The Jev-half statuses that render as the terminal error state (VAL-DRAFT-018). */
export function isFailureJevStatus(status: DraftAnalysis['meta']['jevStatus']): boolean {
  return (
    status === 'failed-network' ||
    status === 'failed-http' ||
    status === 'failed-malformed' ||
    status === 'rate-limited'
  );
}

/**
 * Derives the Jev-half section for the current draft. LIVE SETTINGS TAKE PRECEDENCE (VAL-DRAFT-021):
 * when `jevForDrafts` is off, the off state wins over anything a settled reply carried — a verdict
 * analyzed while the setting was on must vanish the moment it flips, and a late-arriving result
 * must not re-introduce it. Otherwise a settled reply wins over the pending state (a re-dispatch
 * of an identical draft returns an identical result, so flipping back to a spinner would only be
 * noise); the optimistic phase decides from settings + key presence.
 *
 * M5: with `autoAnalyze` OFF the user, not the debounce, triggers the AI call — so this draft has
 * NOTHING in flight and the honest half-state is `ready`, which the expanded panel renders as an
 * explicit AI-analysis action (exactly one Jev call on activation, zero before — VAL-SETUP-010).
 *
 * A dispatch in flight takes precedence over the optimistic phase: the pill must read `pending`
 * the moment the user's own Analyze action leaves the tab, not only once the reply settles.
 */
function deriveJevSection(
  settings: Settings,
  keyPresent: boolean,
  reply: DraftAnalysis | null,
  transportFailed: boolean,
  pendingCount: number,
): JevSection {
  if (!settings.jevForDrafts) return { state: 'off' };
  // M6-SCRUTINY-003 (VAL-DRAFT-010): an in-flight attempt for THIS draft outranks that draft's
  // settled terminal failure — while a retry is pending, the row and block show the pending
  // state (never the old "AI unavailable" with a live Retry button), on BOTH failure paths
  // (Jev-result failures ride in `reply`, transport failures in `transportFailures`). Draft
  // identity and the stale-response guards are untouched: `pendingCount` is keyed by this
  // draft's own hash. A settled VERDICT still wins over pending (a re-dispatch of an identical
  // draft returns an identical result, so flipping back to a spinner would only be noise).
  const inFlight = pendingCount > 0;
  const settledReply =
    reply !== null && inFlight && isFailureJevStatus(reply.meta.jevStatus) ? null : reply;
  if (settledReply) {
    const { jevStatus, jevFailure } = settledReply.meta;
    if ((jevStatus === 'ok' || jevStatus === 'cached') && settledReply.jev) {
      return { state: 'verdict', verdict: settledReply.jev };
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
  // A dispatch in flight takes precedence over the optimistic phase AND over the terminal
  // transport failure a retry retires: the pending state shows from the dispatch tick until the
  // response settles (VAL-DRAFT-010). LIVE KEY FACTS still outrank it (VAL-DRAFT-017): with no
  // key configured the honest state is 'no-key' even while the refusal-making dispatch travels.
  if (!keyPresent) return { state: 'no-key' };
  if (inFlight) return { state: 'pending' };
  if (transportFailed) return { state: 'error', reason: OVERLAY_COPY.errorReasons.transport };
  if (!settings.autoAnalyze) return { state: 'ready' };
  return { state: 'pending' };
}

export function deriveOverlayView(inputs: OverlayViewInputs): OverlayView {
  const { settings, keyPresent, capture, pending, reply, transportFailures, optimizer } = inputs;
  if (!capture || !isDraftEligible(capture, settings.minDraftLength)) {
    return { phase: 'empty', minDraftLength: settings.minDraftLength };
  }

  const hash = draftIdentity(capture);
  const optimizerSection = deriveOptimizerSection(settings, keyPresent, optimizer, hash);
  const matchingReply = reply?.hash === hash ? reply.result : null;
  // Per-draft terminal-state ownership (VAL-DRAFT-018): this draft's own failure entry decides —
  // another draft's failure or result can neither add nor remove it.
  const transportFailed = transportFailures.has(hash);
  // M5 (VAL-SETUP-010): the LOCAL half is ALWAYS rendered for a qualifying draft, with or
  // without a dispatch, a reply or an AI half-state. `autoAnalyze` gates the network call only —
  // it never removes the pill.
  const local = matchingReply?.local ?? scoreDraft(capture);
  const jev = deriveJevSection(
    settings,
    keyPresent,
    matchingReply,
    transportFailed && !matchingReply,
    pending.get(hash) ?? 0,
  );

  // Live-setting precedence again (VAL-DRAFT-021): with jevForDrafts off the panel is local-only —
  // the verdict and the analyzer's hybrid headline are suppressed no matter what settled.
  const verdict = settings.jevForDrafts ? matchingReply?.jev : undefined;
  return {
    phase: 'analyzed',
    local,
    headline: matchingReply
      ? settings.jevForDrafts
        ? matchingReply.meta.headline
        : local.headline
      : composeHeadline(local.headline, verdict?.ordinal),
    headlineSource: verdict ? 'hybrid' : 'local',
    // The Design 1b chip model: the row summary (top-2), the expanded block's chips (max 4) and
    // the "N neutral ›" count all derive from the SAME selection, so they can never disagree
    // (VAL-DRAFT-044).
    summary: summaryPhrases(local.signals),
    chips: signalChips(local.signals),
    neutralCount: neutralCount(local.signals),
    jev,
    optimizer: optimizerSection,
  };
}

/**
 * Derives the Optimize-half section (m4-optimizer). LIVE SETTINGS TAKE PRECEDENCE, mirroring the
 * Jev half: with `jevForDrafts` off, or without a key, the state is one the renderer HIDES
 * entirely (M6 user decision D3 — no optimizer button without AI), so only the remaining states
 * ever reach the DOM. Otherwise the draft's own slot decides: loading -> done/error, matched by
 * draft identity so a stale reply never paints a newer draft.
 */
function deriveOptimizerSection(
  settings: Settings,
  keyPresent: boolean,
  slot: OptimizerSlot | null,
  hash: string,
): OptimizerSection {
  if (!settings.jevForDrafts) return { state: 'off' };
  if (!keyPresent) return { state: 'no-key' };
  if (!slot || slot.hash !== hash) return { state: 'idle' };
  switch (slot.phase) {
    case 'loading':
      return { state: 'loading' };
    case 'done':
      return { state: 'done', optimization: slot.optimization };
    case 'error':
      return { state: 'error', reason: failureReason(slot.failure) };
  }
}
