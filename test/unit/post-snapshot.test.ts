import { describe, expect, it } from 'vitest';
import {
  isPostSnapshot,
  parseLocalizedCount,
  parseStatusLink,
  postAgeMinutes,
  postPublishedAt,
  postMetricsSignature,
  type PostSnapshot,
} from '../../src/core/post-snapshot';

/** A valid snapshot to mutate per case; every contract field present. */
function snapshot(overrides: Partial<PostSnapshot> = {}): PostSnapshot {
  return {
    id: '1800000000000000001',
    text: 'What is the one tool you stopped using this year, and why?',
    authorHandle: 'ana_builds',
    verified: true,
    hasMedia: false,
    isReply: false,
    inNetwork: true,
    ageMinutes: 120,
    replyCount: 45,
    repostCount: 12,
    likeCount: 310,
    url: 'https://x.com/ana_builds/status/1800000000000000001',
    ...overrides,
  };
}

describe('parseLocalizedCount (digits-only from localized labels)', () => {
  it('parses plain digit counts regardless of surrounding words', () => {
    expect(parseLocalizedCount('310')).toBe(310);
    expect(parseLocalizedCount('45 Respostas. Responder')).toBe(45);
    expect(parseLocalizedCount('12 reposts. Repostar')).toBe(12);
    expect(parseLocalizedCount('Curtir 310')).toBe(310); // verb-first label shape
  });

  it('parses pt-BR compact counts with a decimal comma and the mil magnitude', () => {
    expect(parseLocalizedCount('1,2 mil')).toBe(1200);
    expect(parseLocalizedCount('1,2 mil Curtidas. Curtir')).toBe(1200);
    expect(parseLocalizedCount('5,4 mil')).toBe(5400);
    expect(parseLocalizedCount('2 mil')).toBe(2000);
    expect(parseLocalizedCount('12,3 mil Respostas')).toBe(12300);
  });

  it('parses dot-grouped and English compact forms', () => {
    expect(parseLocalizedCount('1.234')).toBe(1234);
    expect(parseLocalizedCount('1.234.567')).toBe(1234567);
    expect(parseLocalizedCount('12K')).toBe(12000);
    expect(parseLocalizedCount('1.5M Likes. Like')).toBe(1_500_000);
    expect(parseLocalizedCount('2B')).toBe(2_000_000_000);
  });

  it('returns undefined when the label carries no count', () => {
    expect(parseLocalizedCount('')).toBeUndefined();
    expect(parseLocalizedCount('Curtir')).toBeUndefined();
    expect(parseLocalizedCount('Responder. Reply')).toBeUndefined();
    expect(parseLocalizedCount('...')).toBeUndefined();
  });

  it('never derives its value from the label vocabulary', () => {
    // Same number, completely different (even nonsense) words around it: value is the digits'.
    expect(parseLocalizedCount('310 totally different words')).toBe(310);
    expect(parseLocalizedCount('word word word 310 word')).toBe(310);
  });
});

describe('postAgeMinutes', () => {
  it('computes whole minutes from an ISO datetime', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    expect(postAgeMinutes('2026-10-03T10:00:00Z', now)).toBe(120);
    expect(postAgeMinutes('2026-10-03T11:59:30Z', now)).toBe(1); // rounds to the nearest minute
  });

  it('clamps future datetimes (clock skew) to zero', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    expect(postAgeMinutes('2026-10-03T12:01:00Z', now)).toBe(0);
  });

  it('returns undefined for missing or unparseable datetimes', () => {
    expect(postAgeMinutes('', Date.now())).toBeUndefined();
    expect(postAgeMinutes('not a date', Date.now())).toBeUndefined();
    expect(postAgeMinutes(undefined, Date.now())).toBeUndefined();
  });
});

describe('parseStatusLink', () => {
  it('extracts the author handle and status id from canonical status URLs', () => {
    expect(parseStatusLink('/ana_builds/status/1800000000000000001')).toEqual({
      handle: 'ana_builds',
      id: '1800000000000000001',
    });
    expect(parseStatusLink('https://x.com/joaodev/status/42')).toEqual({ handle: 'joaodev', id: '42' });
  });

  it('rejects non-status, reserved, and malformed paths', () => {
    expect(parseStatusLink('/ana_builds')).toBeNull();
    expect(parseStatusLink('/i/status/1800000000000000001')).toBeNull(); // legacy redirect root
    expect(parseStatusLink('/intent/status/1')).toBeNull();
    expect(parseStatusLink('/ana_builds/status/notanumber')).toBeNull();
    expect(parseStatusLink('/ana_builds/status/1/replies')).toBeNull();
    expect(parseStatusLink('')).toBeNull();
    expect(parseStatusLink(undefined)).toBeNull();
  });
});

describe('postMetricsSignature (change detection for the rescoring policy)', () => {
  it('is equal for identical captured metrics', () => {
    expect(postMetricsSignature(snapshot())).toBe(postMetricsSignature(snapshot()));
  });

  it('changes whenever any captured metric changes', () => {
    const base = postMetricsSignature(snapshot());
    const changes: Array<Partial<PostSnapshot>> = [
      { text: 'edited' },
      { authorHandle: 'someone_else' },
      { verified: false },
      { hasMedia: true },
      { isReply: true },
      { inNetwork: false },
      { replyToHandle: 'ana_builds' },
      { ageMinutes: 121 },
      { publishedAt: Date.parse('2026-10-03T09:00:00Z') },
      { likeCount: 311 },
      { replyCount: 46 },
      { repostCount: 13 },
      { url: 'https://x.com/ana_builds/status/2' },
    ];
    for (const change of changes) {
      expect(postMetricsSignature(snapshot(change)), JSON.stringify(change)).not.toBe(base);
    }
  });

  it('treats an absent optional field and a present one as different metrics', () => {
    const bare = snapshot({ replyCount: undefined, repostCount: undefined, likeCount: undefined, replyToHandle: undefined });
    expect(postMetricsSignature(bare)).not.toBe(postMetricsSignature(snapshot()));
  });
});

describe('isPostSnapshot (message-boundary runtime guard)', () => {
  it('accepts a valid snapshot, with or without optional fields', () => {
    expect(isPostSnapshot(snapshot())).toBe(true);
    expect(
      isPostSnapshot({
        id: '1', text: '', authorHandle: 'a', verified: false, hasMedia: false,
        isReply: false, inNetwork: false, ageMinutes: 0, url: 'https://x.com/a/status/1',
      }),
    ).toBe(true);
  });

  it('accepts the optional exact publication instant and rejects non-finite values', () => {
    expect(isPostSnapshot(snapshot({ publishedAt: Date.parse('2026-10-03T10:00:00Z') }))).toBe(true);
    expect(isPostSnapshot(snapshot({ publishedAt: Number.NaN }))).toBe(false);
    expect(isPostSnapshot(snapshot({ publishedAt: '2026-10-03T10:00:00Z' as unknown as number }))).toBe(false);
  });

  it('rejects wrong types, missing fields, and non-objects', () => {
    expect(isPostSnapshot(null)).toBe(false);
    expect(isPostSnapshot('post')).toBe(false);
    expect(isPostSnapshot(snapshot({ id: 1 as unknown as string }))).toBe(false);
    expect(isPostSnapshot(snapshot({ verified: 'yes' as unknown as boolean }))).toBe(false);
    expect(isPostSnapshot(snapshot({ ageMinutes: -1 }))).toBe(false);
    expect(isPostSnapshot(snapshot({ ageMinutes: Number.NaN }))).toBe(false);
    expect(isPostSnapshot(snapshot({ likeCount: '310' as unknown as number }))).toBe(false);
    expect(isPostSnapshot(snapshot({ replyToHandle: 5 as unknown as string }))).toBe(false);
    const { url: _url, ...withoutUrl } = snapshot();
    expect(isPostSnapshot(withoutUrl)).toBe(false);
  });
});

describe('postPublishedAt (the exact instant behind the hard 48h gate)', () => {
  it('returns the exact epoch ms of the datetime, unrounded', () => {
    expect(postPublishedAt('2026-10-03T10:00:30.500Z')).toBe(Date.parse('2026-10-03T10:00:30.500Z'));
  });

  it('returns undefined for missing or unparseable datetimes', () => {
    expect(postPublishedAt('')).toBeUndefined();
    expect(postPublishedAt('not a date')).toBeUndefined();
    expect(postPublishedAt(undefined)).toBeUndefined();
  });
});
