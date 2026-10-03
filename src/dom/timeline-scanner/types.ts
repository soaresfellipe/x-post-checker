import type { PostSnapshot } from '@/core/post-snapshot';

/** Why a scanned article produced an event: new id, changed metrics, or unchanged (no rescore). */
export type ScanReason = 'new' | 'changed' | 'unchanged';

export interface ScanEvent {
  post: PostSnapshot;
  /** The article's CURRENT element — captured fresh in this scan pass, never cached. */
  article: Element;
  /** The article's ONE badge host (created on first sight, reused across re-renders). */
  host: HTMLElement;
  reason: ScanReason;
}

export interface TimelineScannerOptions {
  /** Defaults to the current document. */
  doc?: Document;
  /**
   * The scoring sink for posts that need scoring (new ids and changed metrics only). The content
   * script wires it to the typed background protocol; unchanged posts are never re-dispatched.
   */
  dispatchScoring?: (event: ScanEvent) => void;
  /** Minimum interval between scan passes; defaults to SCAN_THROTTLE_MS. */
  throttleMs?: number;
  /**
   * Visibility predicate for scan candidates; defaults to the viewport-intersection check
   * (off-screen posts are not scanned until visible). Injectable for deterministic DOM tests.
   */
  isArticleVisible?: (article: Element) => boolean;
  /** Extraction clock (ages); defaults to Date.now(). Injectable for deterministic DOM tests. */
  now?: () => number;
}

export interface TimelineScanner {
  /** Begins observing (DOM mutations + scroll/resize/route signals). Idempotent. */
  start(): void;
  /**
   * Fully stops: observers disconnected, listeners removed, pending scans canceled, and every
   * mounted badge host removed — zero extension presence remains in the timeline.
   */
  stop(): void;
  /** An immediate scan pass (bypasses the throttle for explicit callers and tests). */
  rescan(): void;
  /**
   * Every scanned (visible) article per pass — including unchanged ones, so badge rendering can
   * idempotently re-sync content (e.g. after a master-switch re-enable re-creates empty hosts).
   */
  onScan(listener: (event: ScanEvent) => void): () => void;
  /** Distinct post ids currently tracked in the diff state (diagnostics). */
  getTrackedCount(): number;
}
