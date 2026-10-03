import { describe, expect, it } from 'vitest';
import { generateHashtagCandidates, buildDropAdvice } from '@/core/optimizer/hashtags';
import type { DraftSnapshot } from '@/core/draft-snapshot';

/**
 * Hashtag suggestion logic (VAL-OPT-006): candidates are derived from the draft's own salient
 * words (Jev is a decision model and cannot invent tags), so topicality is inherent; Jev ranks
 * them later. Drop advice names which excess hashtags to drop and never recommends more than
 * three to keep.
 */
function draft(overrides: Partial<DraftSnapshot> = {}): DraftSnapshot {
  const text =
    overrides.text ??
    'I replaced my complicated productivity system with one daily checklist. The system now runs itself.';
  return {
    text,
    hashtags: overrides.hashtags ?? [],
    urls: [],
    hasMedia: false,
    isReply: false,
    charCount: text.length,
    capturedAt: 1_700_000_000_000,
  };
}

describe('hashtag candidate generation (VAL-OPT-006)', () => {
  it('derives candidates from the draft’s own salient words', () => {
    const tags = generateHashtagCandidates(draft()).map((candidate) => candidate.tag.toLowerCase());
    expect(tags).toContain('system');
    expect(tags).toContain('productivity');
    expect(tags).toContain('checklist');
  });

  it('never suggests a hashtag already present in the draft', () => {
    const tags = generateHashtagCandidates(draft({ hashtags: ['system'] })).map((candidate) =>
      candidate.tag.toLowerCase(),
    );
    expect(tags).not.toContain('system');
  });

  it('excludes stopwords and drafts made only of stopwords yield no candidates', () => {
    expect(generateHashtagCandidates(draft({ text: 'the and but for with you' }))).toEqual([]);
  });

  it('ranks by frequency, then length, then first appearance — deterministically', () => {
    const candidates = generateHashtagCandidates(draft());
    expect(candidates[0]!.tag.toLowerCase()).toBe('system'); // appears twice
    expect(candidates).toEqual(generateHashtagCandidates(draft()));
  });
});

describe('drop advice (VAL-OPT-006)', () => {
  it('names the excess hashtags to drop when the draft has more than three', () => {
    const advice = buildDropAdvice(draft({ hashtags: ['system', 'checklist', 'grind', 'hustle'] }), []);
    expect(advice).toBeTruthy();
    expect(advice).toContain('#grind');
    expect(advice).toContain('#hustle');
    expect(advice).toMatch(/drop/i);
  });

  it('keeps the topical hashtags (their words appear in the draft) and drops the rest', () => {
    const advice = buildDropAdvice(draft({ hashtags: ['system', 'checklist', 'grind', 'hustle'] }), []);
    expect(advice).toContain('#system');
    expect(advice).toContain('#checklist');
    expect(advice).not.toMatch(/keep[^.]*#grind/);
  });

  it('caps the keep list at three even when more are topical', () => {
    const advice = buildDropAdvice(
      draft({ text: 'systems checklists focus habits work', hashtags: ['systems', 'checklists', 'focus', 'habits', 'work'] }),
      [],
    );
    expect(advice).toBeTruthy();
    const kept = advice!.match(/keep ([^.]+)\./i)![1]!;
    expect(kept.split(',').length).toBeLessThanOrEqual(3);
  });

  it('gives no drop advice when the draft has three or fewer hashtags', () => {
    expect(buildDropAdvice(draft({ hashtags: ['system', 'checklist'] }), [])).toBeUndefined();
    expect(buildDropAdvice(draft(), [])).toBeUndefined();
  });

  it('prefers suggested hashtags when deciding what to keep', () => {
    const advice = buildDropAdvice(draft({ hashtags: ['system', 'checklist', 'grind', 'hustle'] }), [
      { tag: 'Grind' },
    ]);
    expect(advice).toBeTruthy();
    expect(advice).toContain('#grind');
    expect(advice).not.toMatch(/drop[^.]*#grind/i);
    expect(advice).toMatch(/drop[^.]*#hustle/i);
  });
});
