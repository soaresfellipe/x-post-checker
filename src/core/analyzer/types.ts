/**
 * The analysis result contract the background returns for `analyze-draft` (architecture.md's
 * message protocol: `{local, jev?, meta}`). Pure data, JSON-serializable over runtime messaging.
 */
import type { AnalysisTrigger } from '@/core/draft-snapshot';
import type { LocalScore, JevVerdict } from '@/core/heuristic-engine';
import type { JevAnalysisFailure, MainWeaknessId } from '@/core/jev-client';

/** What happened to the Jev half of an analysis — the overlay renders each status differently. */
export type JevHalfStatus =
  /** A fresh exchange completed with a parsed verdict. */
  | 'ok'
  /** An identical draft's verdict was served from cache (no network call). */
  | 'cached'
  /** `jevForDrafts` is off: local-only by configuration. */
  | 'skipped-disabled'
  /** No key is configured: the overlay shows the "Connect Jev" prompt. */
  | 'skipped-no-key'
  | 'failed-network'
  | 'failed-http'
  | 'failed-malformed'
  | 'rate-limited';

export interface DraftAnalysisMeta {
  /** Epoch ms when the analysis completed (also the `recordAnalysis` time). */
  readonly analyzedAt: number;
  readonly trigger: AnalysisTrigger;
  /** Cache key of the analyzed draft: lets the overlay discard stale replies (VAL-DRAFT-011). */
  readonly draftHash: string;
  /** The headline the gauge shows: hybrid when a verdict exists, the local headline otherwise. */
  readonly headline: number;
  readonly jevStatus: JevHalfStatus;
  /** Fresh-exchange latency, when one ran. */
  readonly jevLatencyMs?: number;
  /** The typed reason the Jev half did not produce a verdict, for the degraded-mode notice. */
  readonly jevFailure?: JevAnalysisFailure;
  /** The raw weakness choice id, when a verdict exists. */
  readonly mainWeakness?: MainWeaknessId;
}

/** A completed analysis: the local score always, the Jev verdict when one was produced. */
export interface DraftAnalysis {
  readonly kind: 'analyzed';
  readonly local: LocalScore;
  readonly jev?: JevVerdict;
  readonly meta: DraftAnalysisMeta;
}

/**
 * Honest refusals (never fake scores): the master switch is off, or the draft is below the
 * configured minimum length. Neither is a completed analysis, so neither is recorded.
 */
export type DraftAnalysisResult =
  | DraftAnalysis
  | { readonly kind: 'disabled' }
  | { readonly kind: 'below-min-length'; readonly minDraftLength: number };
