import type { AnalysisTrigger, DraftSnapshot } from '@/core/draft-snapshot';

/** What the watcher tells the analysis pipeline (content-script wiring owns the transport). */
export interface AnalysisDispatch {
  snapshot: DraftSnapshot;
  trigger: AnalysisTrigger;
}

/** A debounced capture of the composer — dispatched or not, listeners see every capture. */
export interface DraftEvent {
  kind: 'captured';
  snapshot: DraftSnapshot;
  /** `charCount >= minDraftLength`: whether analysis was allowed for this capture. */
  eligible: boolean;
}

/** Composer attachment lifecycle, e.g. for overlay anchoring across SPA navigation. */
export type ComposerChangeEvent = { type: 'attached'; composer: Element } | { type: 'detached'; composer: Element };

export interface ComposerWatcherOptions {
  /** Defaults to the current document. */
  doc?: Document;
  /** Debounce for the analysis trigger; defaults to DRAFT_DEBOUNCE_MS (~700ms). */
  debounceMs?: number;
  /** Live settings reads: both can change while the tab is open, without a reload. */
  getMinDraftLength: () => number;
  getAutoAnalyze: () => boolean;
  /** Analysis sink; the content script wires it to the typed background protocol. */
  dispatchAnalysis: (dispatch: AnalysisDispatch) => void;
}

export interface ComposerWatcher {
  /** Begins observing (DOM mutations + route signals). Idempotent. */
  start(): void;
  /** Fully stops: observers disconnected, listeners removed, pending captures canceled. */
  stop(): void;
  /**
   * The explicit "Analyze" action (overlay button when autoAnalyze is off): captures the composer
   * now and dispatches with trigger 'manual' when the draft qualifies. Returns whether it ran.
   */
  requestAnalysis(): boolean;
  getActiveComposer(): Element | null;
  /** Latest captured snapshot (any path), or null before the first capture. */
  getSnapshot(): DraftSnapshot | null;
  onDraft(listener: (event: DraftEvent) => void): () => void;
  onComposerChange(listener: (event: ComposerChangeEvent) => void): () => void;
  /**
   * Synchronous notification that the user edited the composer (input / compositionend / paste),
   * fired IMMEDIATELY on the real event — not on the debounced capture. The overlay uses it to
   * collapse its expanded panel the instant typing starts (VAL-DRAFT-036): waiting for the
   * ~700ms debounced capture would leave the panel covering the composer's own mention/emoji/GIF
   * popups for the whole typing burst, which is exactly the occlusion the model forbids.
   */
  onUserEdit(listener: () => void): () => void;
}
