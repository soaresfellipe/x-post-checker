/**
 * The optimizer's result contracts (m4-optimizer). Pure data, JSON-serializable over runtime
 * messaging. Jev is a DECISION model — it cannot write text (research/jev-typesafe) — so hook
 * variants are self-generated structural rewrites of the draft's own words, and Jev's verified
 * `noul` type (verified live in test/unit/optimizer-noul-live.test.ts) judges which rewrites
 * out-earn the original opening and which hashtags are topical.
 */

/** The structural hook kinds the generator can produce (VAL-OPT-003's "question vs number vs story vs bold claim"). */
export type HookKind = 'question' | 'number' | 'story' | 'claim';

import type { JevAnalysisFailure } from '@/core/jev-client/client';

/** One presented hook variant: the EXACT text a copy action puts on the clipboard (VAL-OPT-004). */
export interface HookVariant {
  /** Stable id (the kind); matches the Jev question id `variant_<kind>`. */
  readonly id: HookKind;
  readonly kind: HookKind;
  readonly text: string;
  /** Jev noul probability that this rewrite's opening out-earns the original's (0..1). */
  readonly probability: number;
  /** X-weighted character count (URLs 23, East Asian 2) for the 280-limit flag (VAL-OPT-007). */
  readonly weightedChars: number;
  readonly overLimit: boolean;
}

/** One topical hashtag with its one-line relevance rationale (VAL-OPT-006). */
export interface HashtagSuggestion {
  /** Without the leading `#`. */
  readonly tag: string;
  readonly rationale: string;
  /** Jev noul topicality probability (0..1). */
  readonly probability: number;
}

export interface HashtagAdvice {
  /** Ranked best-first, at most three (never more than three are recommended). */
  readonly suggestions: readonly HashtagSuggestion[];
  /** Present when the draft already carries excess hashtags: names which to drop. */
  readonly dropAdvice?: string;
}

/** A completed optimization: ranked variants + hashtag advice for one draft. */
export interface Optimization {
  /** The draft identity the overlay matches stale replies against (same key as draft analysis). */
  readonly draftHash: string;
  /** Ranked best-first, at most three; at least one whenever the exchange succeeded. */
  readonly variants: readonly HookVariant[];
  readonly hashtags: HashtagAdvice;
  /** `fresh` = a real Jev exchange just completed; `cache` = this draft's stored result. */
  readonly source: 'fresh' | 'cache';
  readonly latencyMs?: number;
}

/**
 * Typed outcomes the overlay renders distinctly: honest refusals (`disabled` master off,
 * `unavailable` — `jevForDrafts` off: the optimizer is an AI feature, `no-key` — Optimize stays
 * disabled with guidance to Options), a typed failure (non-blocking: local scoring and the
 * composer are untouched), or the full optimization.
 */
export type OptimizationResult =
  | { readonly kind: 'optimized'; readonly optimization: Optimization }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'no-key' }
  | { readonly kind: 'error'; readonly failure: JevAnalysisFailure };
