/**
 * Output contracts for the local heuristic engine (architecture: "Local score: 0-100 (normalized
 * from weighted signals) + per-signal breakdown" and the score display design).
 */

/** Direction a signal contributed to the score. */
export type SignalDirection = 'positive' | 'negative' | 'neutral';

/**
 * One row of the per-signal breakdown. Values are concrete ("3 hashtags - diminishing (3)") so the
 * overlay can show WHY a score moved, never an unexplained raw number.
 */
export interface SignalEntry {
  /** Stable machine id, e.g. `reply-magnet`, `hashtags`, `reply-mutual`. */
  readonly id: string;
  /** English UI label. */
  readonly label: string;
  /** Concrete value/state for THIS draft. */
  readonly value: string;
  /** Contribution in headline points (negative = penalty). */
  readonly points: number;
  readonly direction: SignalDirection;
  /** False when the signal exists but did not affect the score (e.g. follow state not visible). */
  readonly applied: boolean;
}

/** The local heuristic result for one draft. Pure data; rendering belongs to the overlay. */
export interface LocalScore {
  /** 0-100 normalized headline. */
  readonly headline: number;
  /** Raw weighted sum of the signal points (headline = clamp(round(base + totalPoints))). */
  readonly totalPoints: number;
  /** Per-signal breakdown, stable order, one entry per evaluated signal. */
  readonly signals: readonly SignalEntry[];
}

/** Qualitative Jev rubric band derived from the ordinal score (never shown as a probability). */
export type JevBand = 'weak' | 'below-average' | 'moderate' | 'strong' | 'exceptional';

/** What the Jev client hands the overlay for one analysis (built via `toJevVerdict`). */
export interface JevVerdict {
  /** Ordinal rubric score 0..5, may be fractional. NEVER displayed as a probability/percentage. */
  readonly ordinal: number;
  /** Model confidence, 0..1. */
  readonly confidence: number;
  /** Derived via `mapJevBand(ordinal)`. */
  readonly band: JevBand;
  readonly strengths: readonly string[];
  readonly weaknesses: readonly string[];
  readonly suggestions: readonly string[];
}

/** Verdict fields as they arrive from the Jev response, before the band is derived. */
export interface JevVerdictInput {
  readonly ordinal: number;
  readonly confidence: number;
  readonly strengths?: readonly string[];
  readonly weaknesses?: readonly string[];
  readonly suggestions?: readonly string[];
}
