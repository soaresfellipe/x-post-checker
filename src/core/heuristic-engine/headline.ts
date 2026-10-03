/**
 * Score-display math (architecture, "Score display design"): the Jev band mapping and the hybrid
 * headline. Pure functions; the formula constants live in `./config`.
 */
import { HEURISTIC_CONFIG, JEV_BAND_LABELS } from './config';
import type { JevBand, JevVerdict, JevVerdictInput } from './types';

export { JEV_BAND_LABELS };

/**
 * Maps a Jev ordinal (0..5, may be fractional) to its rubric band: <1.5 Weak, [1.5,2.5) Below avg,
 * [2.5,3.5) Moderate, [3.5,4.5) Strong, >=4.5 Exceptional. Out-of-range ordinals are clamped and
 * non-finite ones fall back to the weakest band; the ordinal itself is never a probability.
 */
export function mapJevBand(ordinal: number): JevBand {
  const value = Number.isFinite(ordinal)
    ? Math.min(HEURISTIC_CONFIG.hybrid.ordinalMax, Math.max(0, ordinal))
    : 0;
  for (const threshold of HEURISTIC_CONFIG.jevBands.thresholds) {
    if (value < threshold.below) return threshold.band;
  }
  return HEURISTIC_CONFIG.jevBands.top;
}

/**
 * The hybrid headline: round(0.6*local + 0.4*(ordinal/5*100)) when a Jev verdict is present,
 * the local headline unchanged otherwise (disabled, absent key, pending, or failed request).
 */
export function composeHeadline(localHeadline: number, jevOrdinal?: number | null): number {
  const { headline, hybrid } = HEURISTIC_CONFIG;
  const local = Math.min(headline.max, Math.max(headline.min, localHeadline));
  if (jevOrdinal === null || jevOrdinal === undefined || !Number.isFinite(jevOrdinal)) return local;
  const normalized = (Math.min(hybrid.ordinalMax, Math.max(0, jevOrdinal)) / hybrid.ordinalMax) * 100;
  return Math.round(
    Math.min(headline.max, Math.max(headline.min, hybrid.localWeight * local + hybrid.jevWeight * normalized)),
  );
}

/** Builds the full verdict the overlay renders, deriving the band from the ordinal. */
export function toJevVerdict(input: JevVerdictInput): JevVerdict {
  return {
    ordinal: input.ordinal,
    confidence: input.confidence,
    band: mapJevBand(input.ordinal),
    strengths: input.strengths ?? [],
    weaknesses: input.weaknesses ?? [],
    suggestions: input.suggestions ?? [],
  };
}
