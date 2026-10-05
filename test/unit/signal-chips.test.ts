import { describe, expect, it } from 'vitest';
import { chipEligible, neutralCount, signalChips, summaryPhrases, type SignalChip } from '../../src/dom/overlay/chips';
import type { SignalEntry } from '../../src/core/heuristic-engine';

/**
 * The Design 1b chip model (library/design-1b.md §3/§4.1, VAL-DRAFT-044): only signals that
 * scored appear; chips cap at 4 ordered by |points| descending (ties keep the engine's stable
 * order); the row summary shows up to 2 phrases; everything not shown as a chip counts into the
 * "N neutral ›" toggle, whose full rows list also carries the baseline and zero-point entries.
 */

function signal(overrides: Partial<SignalEntry> & Pick<SignalEntry, 'id' | 'points'>): SignalEntry {
  return {
    label: overrides.id,
    value: 'v',
    direction: overrides.points > 0 ? 'positive' : overrides.points < 0 ? 'negative' : 'neutral',
    applied: overrides.points !== 0,
    ...overrides,
  } as SignalEntry;
}

describe('chip eligibility', () => {
  it('drops zero-point signals, unapplied entries and the baseline (no short phrase)', () => {
    const signals: SignalEntry[] = [
      signal({ id: 'baseline', points: 0.5 }), // no `short`: the floor, never a chip
      signal({ id: 'length', points: 0, short: undefined }),
      signal({ id: 'media', points: 1, short: 'Media attached' }),
      signal({ id: 'hashtags', points: -4, short: 'Too many hashtags (5)' }),
    ];
    expect(chipEligible(signals).map((s) => s.id)).toEqual(['hashtags', 'media']);
  });

  it('orders by |points| descending and keeps the engine order for ties', () => {
    const signals: SignalEntry[] = [
      signal({ id: 'a', points: 5, short: 'A' }),
      signal({ id: 'b', points: 20, short: 'B' }),
      signal({ id: 'c', points: -50, short: 'C' }),
      signal({ id: 'd', points: 5, short: 'D' }),
    ];
    expect(chipEligible(signals).map((s) => s.id)).toEqual(['c', 'b', 'a', 'd']);
  });
});

describe('signalChips (VAL-DRAFT-044 cap and ordering)', () => {
  it('caps at 4 chips by |points| descending', () => {
    const signals: SignalEntry[] = [
      signal({ id: 'a', points: 1, short: 'A' }),
      signal({ id: 'b', points: 2, short: 'B' }),
      signal({ id: 'c', points: 3, short: 'C' }),
      signal({ id: 'd', points: -50, short: 'D' }),
      signal({ id: 'e', points: 20, short: 'E' }),
      signal({ id: 'f', points: 0.5, short: 'F' }),
    ];
    const chips: SignalChip[] = signalChips(signals);
    expect(chips.map((c) => c.id)).toEqual(['d', 'e', 'c', 'b']);
    expect(chips[0]).toMatchObject({ phrase: 'D', points: -50, direction: 'negative' });
  });

  it('shows every eligible signal as a chip when there are four or fewer', () => {
    const signals: SignalEntry[] = [
      signal({ id: 'a', points: 3, short: 'A' }),
      signal({ id: 'b', points: -2, short: 'B' }),
    ];
    expect(signalChips(signals)).toHaveLength(2);
  });
});

describe('summaryPhrases (the row summary, up to 2)', () => {
  it('returns the top-2 phrases by |points|', () => {
    const signals: SignalEntry[] = [
      signal({ id: 'a', points: 5, short: 'Question' }),
      signal({ id: 'b', points: -50, short: 'Engagement bait: "like and retweet if"' }),
      signal({ id: 'c', points: 1, short: 'Media attached' }),
    ];
    expect(summaryPhrases(signals)).toEqual(['Engagement bait: "like and retweet if"', 'Question']);
  });

  it('is empty when nothing scored', () => {
    expect(summaryPhrases([signal({ id: 'a', points: 0 })])).toEqual([]);
  });
});

describe('neutralCount (the "N neutral ›" toggle)', () => {
  it('counts every entry not shown as a chip: zero-point, baseline and beyond-cap signals', () => {
    const signals: SignalEntry[] = [
      signal({ id: 'baseline', points: 0.5 }), // never a chip (no short phrase)
      signal({ id: 'a', points: 0 }), // neutral
      signal({ id: 'b', points: 0 }), // neutral
      signal({ id: 'c', points: 20, short: 'C' }),
      signal({ id: 'd', points: 3, short: 'D' }),
      signal({ id: 'e', points: 2, short: 'E' }),
      signal({ id: 'f', points: 1, short: 'F' }),
      signal({ id: 'g', points: 1, short: 'G' }), // beyond the 4-chip cap
      signal({ id: 'h', points: -4, short: 'H' }), // beyond the 4-chip cap
    ];
    expect(signalChips(signals)).toHaveLength(4);
    expect(neutralCount(signals)).toBe(5); // baseline + 2 neutrals + 2 beyond-cap
  });

  it('is zero when every signal is a chip', () => {
    const signals: SignalEntry[] = [
      signal({ id: 'a', points: 3, short: 'A' }),
      signal({ id: 'b', points: -2, short: 'B' }),
    ];
    expect(neutralCount(signals)).toBe(0);
  });
});
