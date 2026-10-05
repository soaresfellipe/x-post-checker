/**
 * The Design 1b chip model (library/design-1b.md §3/§4.1): only signals that SCORED appear as
 * chips — ordered by |points| descending, capped at 4 — and everything else (zero-point entries,
 * the baseline, signals beyond the cap) counts into the "N neutral ›" toggle, whose full rows
 * list renders label / value / points. The short phrases themselves are produced by the engine
 * (`SignalEntry.short`, the verbatim §5 copy table); this module only selects and orders.
 *
 * Pure and DOM-free: the same selection feeds the status row's summary (up to 2 phrases) and the
 * expanded block's chips, so the two can never disagree.
 */
import type { SignalDirection, SignalEntry } from '@/core/heuristic-engine';

/** Maximum chips rendered in the expanded block (VAL-DRAFT-044). */
export const CHIP_CAP = 4;

/** Maximum short phrases in the collapsed row's summary (design-1b §3). */
export const SUMMARY_MAX = 2;

export interface SignalChip {
  readonly id: string;
  readonly phrase: string;
  readonly points: number;
  readonly direction: SignalDirection;
}

/**
 * Chip-eligible signals: a non-zero contribution AND a Design 1b short phrase. The baseline
 * scores +0.5 on every eligible draft but carries no phrase — it is the score's floor, not an
 * applied signal, so it never renders as a chip (it stays visible in the full rows list).
 * Stable sort: ties keep the engine's canonical breakdown order.
 */
export function chipEligible(signals: readonly SignalEntry[]): SignalEntry[] {
  return signals
    .filter((signal) => signal.points !== 0 && signal.short !== undefined)
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
}

/** The expanded block's chips: at most `CHIP_CAP`, best-|points| first. */
export function signalChips(signals: readonly SignalEntry[]): SignalChip[] {
  return chipEligible(signals)
    .slice(0, CHIP_CAP)
    .map((signal) => ({
      id: signal.id,
      phrase: signal.short!,
      points: signal.points,
      direction: signal.direction,
    }));
}

/** The collapsed row's summary phrases: at most `SUMMARY_MAX`, best-|points| first. */
export function summaryPhrases(signals: readonly SignalEntry[]): string[] {
  return chipEligible(signals)
    .slice(0, SUMMARY_MAX)
    .map((signal) => signal.short!);
}

/**
 * The "N" of the "N neutral ›" toggle: every breakdown entry the chips do not show — zero-point
 * signals, the baseline, and eligible signals beyond the cap. All of them render in the toggle's
 * full rows list.
 */
export function neutralCount(signals: readonly SignalEntry[]): number {
  return signals.length - signalChips(signals).length;
}
