/**
 * ScoreOverlay type contracts: the pure view model (what renders, derived from the watcher's
 * captures, the live settings and the settled analyze-draft replies) and the controller API the
 * content script drives.
 */
import type { DraftSnapshot } from '@/core/draft-snapshot';
import type { JevVerdict, LocalScore } from '@/core/heuristic-engine';
import type { DraftAnalysis, DraftAnalysisResult } from '@/core/analyzer';
import type { Settings } from '@/core/settings-store';
import type { ComposerChangeEvent, DraftEvent } from '@/dom/composer-watcher';

/** Which Jev-half state the panel shows. `pending` = an analysis is in flight for this draft. */
export type JevSectionState = 'pending' | 'verdict' | 'no-key' | 'off' | 'error';

export interface JevSection {
  readonly state: JevSectionState;
  /** Present on 'verdict': band label, confidence and weakness/suggestion lines render from it. */
  readonly verdict?: JevVerdict;
  /** Present on 'error': the human-readable reason line. */
  readonly reason?: string;
}

/** The pure view model for the current draft (all DOM-free; `deriveOverlayView` produces it). */
export type OverlayView =
  | { readonly phase: 'empty'; readonly minDraftLength: number }
  | { readonly phase: 'ready' }
  | {
      readonly phase: 'analyzed';
      readonly local: LocalScore;
      /** The gauge number: hybrid when a verdict is in, the local headline otherwise. */
      readonly headline: number;
      readonly headlineSource: 'local' | 'hybrid';
      readonly jev: JevSection;
    };

/** Everything `deriveOverlayView` needs; the overlay controller keeps these slots current. */
export interface OverlayViewInputs {
  readonly settings: Settings;
  readonly keyPresent: boolean;
  /** Latest watcher capture; the newest draft wins (VAL-DRAFT-011). */
  readonly capture: DraftSnapshot | null;
  /** In-flight analyze-draft dispatches, keyed by draft hash (hash -> count). */
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
}

export interface ScoreOverlayOptions {
  /** Defaults to the current document. */
  doc?: Document;
  /** Live Jev-key PRESENCE (never the key itself — the content script must not hold it). */
  getKeyPresence: () => boolean;
  /** The explicit "Analyze" action: captures now and dispatches with trigger 'manual'. */
  requestAnalysis: () => boolean;
  /** Opens the extension Options page (via the background; content scripts cannot). */
  openOptions: () => void;
}

export interface ScoreOverlay {
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
  /** Removes the host and every listener (test teardown). */
  destroy(): void;
}
