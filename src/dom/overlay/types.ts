/**
 * ScoreOverlay type contracts: the pure view model (what renders, derived from the watcher's
 * captures, the live settings and the settled analyze-draft replies) and the controller API the
 * content script drives.
 */
import type { DraftSnapshot } from '@/core/draft-snapshot';
import type { JevVerdict, LocalScore } from '@/core/heuristic-engine';
import type { DraftAnalysis, DraftAnalysisResult } from '@/core/analyzer';
import type { Optimization, OptimizationResult } from '@/core/optimizer';
import type { JevAnalysisFailure } from '@/core/jev-client/client';
import type { Settings } from '@/core/settings-store';
import type { ComposerChangeEvent, DraftEvent } from '@/dom/composer-watcher';
import type { SignalChip } from './chips';

/**
 * Which Jev-half state the panel shows. `pending` = an analysis is in flight for this draft;
 * `ready` = nothing is in flight because `autoAnalyze` is off and the user has not asked yet
 * (M5 / VAL-SETUP-010), which the panel renders as the explicit "Analyze with AI" action.
 */
export type JevSectionState = 'pending' | 'ready' | 'verdict' | 'no-key' | 'off' | 'error';

export interface JevSection {
  readonly state: JevSectionState;
  /** Present on 'verdict': band label, confidence and weakness/suggestion lines render from it. */
  readonly verdict?: JevVerdict;
  /** Present on 'error': the human-readable reason line. */
  readonly reason?: string;
}

/**
 * Which Optimize-half state the expanded block shows. M6 (user decision D3): `no-key` (and the
 * AI-off state) render NO optimizer section at all — the button is hidden entirely. `loading`/
 * `done`/`error` are the action's own lifecycle (loading -> success or explicit error,
 * VAL-OPT-002/010), tracked PER DRAFT like the analysis replies so a draft change resets it and
 * a stale reply never paints a newer draft.
 */
export type OptimizerSection =
  | { readonly state: 'idle' }
  | { readonly state: 'no-key' }
  | { readonly state: 'off' }
  | { readonly state: 'loading' }
  | { readonly state: 'done'; readonly optimization: Optimization }
  | { readonly state: 'error'; readonly reason: string };

/** The per-draft optimizer slot the controller keeps (matched by draft identity). */
export type OptimizerSlot =
  | { readonly hash: string; readonly phase: 'loading' }
  | { readonly hash: string; readonly phase: 'done'; readonly optimization: Optimization }
  | { readonly hash: string; readonly phase: 'error'; readonly failure: JevAnalysisFailure };

/**
 * The pure view model for the current draft (all DOM-free; `deriveOverlayView` produces it).
 * M6 (Design 1b): `empty` (no qualifying draft) renders NOTHING at all — no row, no expanded
 * block — and `analyzed` is what the collapsed status ROW renders from (plus the inline expanded
 * block, only after an explicit row click).
 */
export type OverlayView =
  | { readonly phase: 'empty'; readonly minDraftLength: number }
  | {
      readonly phase: 'analyzed';
      readonly local: LocalScore;
      /** The headline number: hybrid when a verdict is in, the local headline otherwise. */
      readonly headline: number;
      readonly headlineSource: 'local' | 'hybrid';
      /** Up to 2 short phrases of the highest-|points| signals (the row summary). */
      readonly summary: readonly string[];
      /** The expanded block's signal chips (max 4, |points| desc, signed points). */
      readonly chips: readonly SignalChip[];
      /** Signals not shown as chips — the "N" of the "N neutral ›" toggle. */
      readonly neutralCount: number;
      readonly jev: JevSection;
      readonly optimizer: OptimizerSection;
    };

/** Everything `deriveOverlayView` needs; the overlay controller keeps these slots current. */
export interface OverlayViewInputs {
  readonly settings: Settings;
  readonly keyPresent: boolean;
  /** Latest watcher capture; the newest draft wins (VAL-DRAFT-011). */
  readonly capture: DraftSnapshot | null;
  /**
   * In-flight analyze-draft dispatches, keyed by draft hash (hash -> count). No longer gates the
   * local half (M5 renders it unconditionally) — it is retained because the AI half's `pending`
   * state is derived from settings + key presence, and the controller still tracks these to keep
   * its `settlePending` bookkeeping honest.
   */
  readonly pending: ReadonlyMap<string, number>;
  /** The latest settled analyze-draft reply, when it matches the current draft's hash. */
  readonly reply: { readonly hash: string; readonly result: DraftAnalysis } | null;
  /**
   * Hashes whose latest dispatch settled as a transport failure (never a Jev failure — those
   * settle as replies), tracked PER DRAFT (VAL-DRAFT-018): a settling dispatch owns only its own
   * draft identity, so a failure for a non-current draft can never displace the current draft's
   * terminal state. Lets the panel keep the optimistic local score with an explicit error notice
   * instead of silently reverting.
   */
  readonly transportFailures: ReadonlySet<string>;
  /**
   * The latest Optimize lifecycle slot (loading/done/error), matched by draft identity: a draft
   * change resets it to null and a reply for a different draft never paints (VAL-DRAFT-011 rule).
   */
  readonly optimizer: OptimizerSlot | null;
}

export interface ScoreOverlayOptions {
  /** Defaults to the current document. */
  doc?: Document;
  /** Live Jev-key PRESENCE (never the key itself — the content script must not hold it). */
  getKeyPresence: () => boolean;
  /**
   * The explicit "Analyze with AI" action: captures now and dispatches with trigger 'manual'.
   * Only reachable from the EXPANDED panel, and only meaningful while `autoAnalyze` is off
   * (VAL-SETUP-010: typing then stays local-only and free; activating this runs exactly one Jev
   * analysis for the current draft).
   */
  requestAnalysis: () => boolean;
  /** Opens the extension Options page (via the background; content scripts cannot). */
  openOptions: () => void;
  /**
   * The explicit "Optimize" action for the given draft: dispatches `optimize-draft` through the
   * background. The reply lands in `onOptimizeResult`/`onOptimizeFailed`. When omitted (tests),
   * the Optimize button click does nothing.
   */
  requestOptimize?: (draft: DraftSnapshot) => void;
  /**
   * Puts text on the clipboard for a variant's copy action — the transfer mechanism at this
   * scope (VAL-OPT-004): the composer is never touched, copying is the explicit user action.
   * Defaults to `navigator.clipboard.writeText`.
   */
  copyVariant?: (text: string) => Promise<void>;
}

export interface ScoreOverlay {
  /**
   * Collapses an expanded panel back to the pill WITHOUT touching the captured draft (idempotent,
   * a no-op when nothing is expanded). Wired to the watcher's immediate user-edit lane so typing
   * collapses the panel at the keystroke rather than ~700ms later, when the debounced capture
   * lands (VAL-DRAFT-036) — waiting out the debounce would leave the panel over the composer's own
   * mention/emoji/GIF popups for the whole typing burst.
   */
  collapsePanel(): void;
  /**
   * Applies a settings snapshot (either delivery path — broadcast or storage event): enables or
   * disables the overlay per `settings.enabled`, restamps the revision on the host, and
   * re-renders so preference changes (minDraftLength, jevForDrafts, autoAnalyze) apply to the
   * open tab without a reload.
   */
  onSettings(settings: Settings, revision?: number): void;
  /** The watcher's debounced captures — the newest draft wins. */
  onDraftCaptured(event: DraftEvent): void;
  /** Composer attach/detach (SPA navigation): anchors, resets state, mounts/unmounts the host. */
  onComposerChange(event: ComposerChangeEvent): void;
  /** An analyze-draft dispatch left the tab: the Jev half is now in flight for this draft. */
  onAnalysisDispatched(snapshot: DraftSnapshot): void;
  /**
   * A settled analyze-draft reply (discarded unless it matches the current draft's hash). Honest
   * refusals may carry the dispatch's snapshot so ITS pending entry settles — never the oldest
   * one's (VAL-DRAFT-018).
   */
  onAnalysisResult(result: DraftAnalysisResult, dispatched?: DraftSnapshot): void;
  /**
   * The analyze-draft transport failed for THIS draft's dispatch: the failure carries the failing
   * draft's snapshot (the same identity successes use), so only that dispatch settles and its
   * local score shows with an explicit transport error instead of an endless spinner
   * (VAL-DRAFT-018). Unrelated in-flight dispatches stay pending.
   */
  onAnalysisFailed(snapshot: DraftSnapshot): void;
  /**
   * A settled `optimize-draft` reply, with the dispatched draft so the reply settles THAT draft's
   * identity (a reply for a different draft never paints — VAL-DRAFT-011 rule). Honest refusals
   * (disabled/unavailable/no-key) just clear the loading state: the section derives its gate
   * states live from settings and key presence.
   */
  onOptimizeResult(result: OptimizationResult, dispatched: DraftSnapshot): void;
  /** The optimize-draft transport failed for THIS draft's dispatch: explicit error, non-blocking. */
  onOptimizeFailed(dispatched: DraftSnapshot): void;
  /** Removes the host and every listener (test teardown). */
  destroy(): void;
}
