import { describe, expect, it } from 'vitest';
import {
  DRAFT_DEBOUNCE_MS,
  isDraftEligible,
  parseHashtags,
  parseUrls,
  type DraftSnapshot,
} from '../../src/core/draft-snapshot';

const BASE_SNAPSHOT: DraftSnapshot = {
  text: 'Hello #world',
  hashtags: ['world'],
  urls: [],
  hasMedia: false,
  isReply: false,
  charCount: 12,
  capturedAt: 0,
};

describe('DraftSnapshot contract', () => {
  it('carries every contract field', () => {
    expect(Object.keys(BASE_SNAPSHOT).sort()).toEqual(
      ['capturedAt', 'charCount', 'hashtags', 'hasMedia', 'isReply', 'text', 'urls'].sort(),
    );
  });

  it('allows the optional reply fields to be absent (never guessed)', () => {
    expect('replyToHandle' in BASE_SNAPSHOT).toBe(false);
    expect('replyToFollowedByViewer' in BASE_SNAPSHOT).toBe(false);
  });
});

describe('parseHashtags', () => {
  it('extracts hashtags from word boundaries without the # sign', () => {
    expect(parseHashtags('Shipping #buildinpublic and #shipping today')).toEqual(['buildinpublic', 'shipping']);
  });

  it('keeps hashtags attached to punctuation and line starts', () => {
    expect(parseHashtags('(#lead)\n#trailing')).toEqual(['lead', 'trailing']);
  });

  it('accepts digits and underscores in hashtag words', () => {
    expect(parseHashtags('#v2_0 rocks')).toEqual(['v2_0']);
  });

  it('ignores # signs that do not start a tag (URL fragments, lone #)', () => {
    expect(parseHashtags('see https://example.com/page#section and #')).toEqual([]);
  });
});

describe('parseUrls', () => {
  it('extracts http(s) URLs', () => {
    expect(parseUrls('read https://example.com/a/b now')).toEqual(['https://example.com/a/b']);
  });

  it('extracts www. shorthand URLs', () => {
    expect(parseUrls('see www.example.com/page for more')).toEqual(['www.example.com/page']);
  });

  it('strips trailing punctuation and dedupes, preserving order', () => {
    expect(parseUrls('visit https://a.co/x, then https://a.co/x, then https://b.co/y.')).toEqual([
      'https://a.co/x',
      'https://b.co/y',
    ]);
  });
});

describe('isDraftEligible (minDraftLength gate)', () => {
  it('is a raw character-count boundary: N-1 below, N at', () => {
    const snapshot = (text: string): DraftSnapshot => ({ ...BASE_SNAPSHOT, text, charCount: text.length });
    expect(isDraftEligible(snapshot('123456789'), 10)).toBe(false);
    expect(isDraftEligible(snapshot('1234567890'), 10)).toBe(true);
  });

  it('counts spaces and newlines like any other character', () => {
    const snapshot: DraftSnapshot = { ...BASE_SNAPSHOT, text: 'a b c d e ', charCount: 10 };
    expect(isDraftEligible(snapshot, 10)).toBe(true);
  });
});

describe('DRAFT_DEBOUNCE_MS', () => {
  it('is the ~700ms analysis cadence from the architecture', () => {
    expect(DRAFT_DEBOUNCE_MS).toBe(700);
  });
});
