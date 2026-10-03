/**
 * The one place every optimizer constant lives (AGENTS.md: weights/coefficients in one config
 * module). The `noul` question type is VERIFIED live (test/unit/optimizer-noul-live.test.ts,
 * 2026-10-03: HTTP 200, answer `{type:'noul', noul:<0..1>}`) — the approved fallback
 * (score-ranked variants) is deliberately unused.
 */

/** The structural hook kinds the generator can produce (see ./types). */
import type { HookKind } from './types';

/** Bump when the optimize rubric or its state format changes: folded into the cache key. */
export const OPTIMIZER_RUBRIC_VERSION = 'optimizer-rubric-v1';

/** Variants presented after ranking (Jev may evaluate more). */
export const OPTIMIZER_MAX_VARIANTS_PRESENTED = 3;

/** Never recommend more than three hashtags (VAL-OPT-006). */
export const OPTIMIZER_MAX_HASHTAG_SUGGESTIONS = 3;

/** Hashtag candidates generated locally and evaluated by Jev in the same single request. */
export const OPTIMIZER_HASHTAG_CANDIDATES = 5;

/** Human-readable hook-kind labels shown above each variant (English-only surface). */
export const VARIANT_LABELS: Readonly<Record<HookKind, string>> = Object.freeze({
  question: 'Question hook',
  number: 'Number lead',
  story: 'Story teaser',
  claim: 'Claim first',
});
