import { describe, expect, it } from 'vitest';
import { HEURISTIC_CONFIG, TARGET_CONFIG, scoreTarget, type SignalEntry, type TargetScore } from '../../src/core/heuristic-engine';
import type { PostSnapshot } from '../../src/core/post-snapshot';

/**
 * Snapshot factory mirroring the timeline scanner's extraction contract: single-signal pairs vary
 * ONE field at a time. Defaults are an unremarkable eligible post (original, out of network with
 * no visible marker, 90 minutes old, no counts) whose every signal scores 0 — base headline only.
 */
function snapshot(partial: Partial<PostSnapshot> & { id?: string; text?: string }): PostSnapshot {
  return {
    id: '1001',
    text: FILLER,
    authorHandle: 'someone',
    verified: false,
    hasMedia: false,
    isReply: false,
    inNetwork: false,
    ageMinutes: 90,
    url: `https://x.com/someone/status/${partial.id ?? '1001'}`,
    ...partial,
  };
}

/** The scorer under test, applied to a factory snapshot. */
function scored(partial: Partial<PostSnapshot> & { id?: string; text?: string }): TargetScore {
  return scoreTarget(snapshot(partial));
}

/** Neutral filler with no '?', no digits, and no bait/claim vocabulary (target signals only). */
const FILLER =
  'A quiet observation about ordinary things and the long middle of the work where nothing dramatic happens';

function byId(score: TargetScore, id: string): SignalEntry {
  const found = score.signals.find((signal) => signal.id === id);
  expect(found, `signal ${id} present in breakdown`).toBeDefined();
  return found as SignalEntry;
}

/** Sum of every per-signal contribution (the totalPoints invariant for eligible posts). */
function sumOfSignals(score: TargetScore): number {
  return score.signals.reduce((sum, signal) => sum + signal.points, 0);
}

describe('scoreTarget shape and neutral baseline', () => {
  it('an unremarkable eligible post sits at the neutral base with an all-zero breakdown', () => {
    const quiet = scored({});
    expect(quiet.eligible).toBe(true);
    expect(quiet.ineligibleReason).toBeUndefined();
    expect(quiet.headline).toBe(HEURISTIC_CONFIG.headline.base);
    expect(quiet.totalPoints).toBe(0);
    expect(quiet.signals.map((signal) => signal.id)).toEqual([
      'eligibility',
      'velocity',
      'reply-like-ratio',
      'question',
      'verified-author',
      'conversation-depth',
      'mutual-follow',
      'engagement-bait',
    ]);
  });

  it('totalPoints is the sum of the per-signal contributions and builds the headline', () => {
    const busy = scored({
      text: 'What did you learn the hard way about shipping products quickly but carefully this year?',
      inNetwork: true,
      verified: true,
      ageMinutes: 60,
      likeCount: 300,
      replyCount: 90,
      repostCount: 120,
    });
    expect(busy.totalPoints).toBe(sumOfSignals(busy));
    expect(busy.headline).toBe(
      Math.round(
        Math.min(
          HEURISTIC_CONFIG.headline.max,
          Math.max(HEURISTIC_CONFIG.headline.min, HEURISTIC_CONFIG.headline.base + busy.totalPoints),
        ),
      ),
    );
  });

  it('the eligibility entry describes the fresh state for eligible posts', () => {
    const entry = byId(scored({ ageMinutes: 90 }), 'eligibility');
    expect(entry.points).toBe(0);
    expect(entry.value).toContain('90min');
  });

  it('clamps the headline into 0-100 for extreme inputs', () => {
    const floored = scored({
      text: 'Like and retweet if you want free stuff and follow me for more of it every single day ok',
      isReply: true,
      inNetwork: true,
    });
    expect(floored.headline).toBe(0);
    const maxed = scored({
      text: 'What did you learn the hard way about shipping products quickly but carefully this year?',
      inNetwork: true,
      verified: true,
      ageMinutes: 60,
      likeCount: 1200,
      replyCount: 400,
      repostCount: 600,
    });
    expect(maxed.headline).toBeLessThanOrEqual(100);
    expect(maxed.headline).toBeGreaterThanOrEqual(0);
  });
});

describe('48-hour recency filter (VAL-TARGET-010)', () => {
  const counts = { likeCount: 50_000, replyCount: 9_000, repostCount: 20_000 };

  it('a post older than 48 hours is ineligible regardless of engagement counts', () => {
    const old = scored({ id: 'old', ageMinutes: TARGET_CONFIG.recency.maxAgeMinutes + 1, ...counts });
    const fresh = scored({ id: 'fresh', ageMinutes: TARGET_CONFIG.recency.maxAgeMinutes, ...counts });
    expect(old.eligible).toBe(false);
    expect(old.ineligibleReason).toBe('stale-over-48h');
    expect(old.headline).toBe(0);
    expect(old.totalPoints).toBe(0);
    expect(fresh.eligible).toBe(true);
    expect(fresh.headline).toBeGreaterThan(old.headline);
  });

  it('boundary: exactly 48 hours stays eligible, strictly older is excluded', () => {
    expect(scored({ ageMinutes: TARGET_CONFIG.recency.maxAgeMinutes - 1 }).eligible).toBe(true);
    expect(scored({ ageMinutes: TARGET_CONFIG.recency.maxAgeMinutes }).eligible).toBe(true);
    expect(scored({ ageMinutes: TARGET_CONFIG.recency.maxAgeMinutes + 1 }).eligible).toBe(false);
  });

  it('the ineligible breakdown explains the exclusion and nothing else', () => {
    const old = scored({ ageMinutes: 72 * 60, ...counts });
    expect(old.signals).toHaveLength(1);
    const entry = old.signals[0]!;
    expect(entry.id).toBe('eligibility');
    expect(entry.applied).toBe(true);
    expect(entry.direction).toBe('negative');
    expect(entry.value).toContain('48h');
    expect(entry.value).toContain('72h');
  });
});

describe('out-of-network reply exclusion (VAL-TARGET-013)', () => {
  it('excludes only the out-of-network reply; OON originals and in-network replies stay eligible', () => {
    const oonReply = scored({ id: 'oon-reply', isReply: true, inNetwork: false });
    const oonOriginal = scored({ id: 'oon-original', isReply: false, inNetwork: false });
    const inNetworkReply = scored({ id: 'in-reply', isReply: true, inNetwork: true });

    expect(oonReply.eligible).toBe(false);
    expect(oonReply.ineligibleReason).toBe('out-of-network-reply');
    expect(oonReply.headline).toBe(0);
    expect(oonOriginal.eligible).toBe(true);
    expect(inNetworkReply.eligible).toBe(true);
  });

  it('the exclusion names the rule in the breakdown', () => {
    const oonReply = scored({ isReply: true, inNetwork: false });
    expect(oonReply.signals).toHaveLength(1);
    const entry = oonReply.signals[0]!;
    expect(entry.id).toBe('eligibility');
    expect(entry.value).toContain('out-of-network');
    expect(entry.value).toContain('does not follow');
  });
});

describe('single-signal direction table (VAL-TARGET-023)', () => {
  it('a high reply:like ratio (active conversation) outscores a low-ratio twin', () => {
    const active = scored({ id: 'active', likeCount: 200, replyCount: 60 });
    const quiet = scored({ id: 'quiet', likeCount: 200, replyCount: 2 });
    expect(active.headline).toBeGreaterThan(quiet.headline);
    const activeEntry = byId(active, 'reply-like-ratio');
    expect(activeEntry.points).toBe(TARGET_CONFIG.replyRatioBands[0]!.points);
    expect(activeEntry.value).toContain('60 replies / 200 likes');
    expect(byId(quiet, 'reply-like-ratio').points).toBeLessThan(activeEntry.points);
  });

  it('a verified author outscores an unverified twin by a small, non-dominant margin', () => {
    const verified = scored({ id: 'verified', verified: true });
    const unverified = scored({ id: 'unverified', verified: false });
    expect(verified.headline).toBeGreaterThan(unverified.headline);
    const entry = byId(verified, 'verified-author');
    expect(entry.applied).toBe(true);
    expect(entry.points).toBe(TARGET_CONFIG.weights.verified);
    expect(entry.value).toContain('verified');
  });

  it('the verified gain stays smaller than the reply-ratio gain', () => {
    const verifiedGain =
      byId(scored({ verified: true }), 'verified-author').points -
      byId(scored({ verified: false }), 'verified-author').points;
    const ratioGain =
      byId(scored({ likeCount: 200, replyCount: 60 }), 'reply-like-ratio').points -
      byId(scored({ likeCount: 200, replyCount: 2 }), 'reply-like-ratio').points;
    expect(verifiedGain).toBeGreaterThan(0);
    expect(ratioGain).toBeGreaterThan(verifiedGain);
  });

  it('a shallow (original) conversation outscores an equivalent deep-thread reply', () => {
    // Both hold no network boost (the original shows no marker; replies never get one), so the
    // whole delta is the depth signal.
    const shallow = scored({ id: 'shallow', isReply: false, inNetwork: false });
    const deepThread = scored({ id: 'deep', isReply: true, inNetwork: true });
    expect(deepThread.eligible).toBe(true);
    expect(shallow.headline).toBeGreaterThan(deepThread.headline);
    const entry = byId(deepThread, 'conversation-depth');
    expect(entry.points).toBe(TARGET_CONFIG.weights.deepThreadPenalty);
    expect(entry.direction).toBe('negative');
    expect(entry.value).toContain('deep');
    expect(byId(shallow, 'conversation-depth').points).toBe(0);
  });

  it('a question post outscores a plain-statement twin', () => {
    const question = scored({
      id: 'question',
      text: 'What is the one workflow change that saved your team the most time this year? Curious how teams handle it',
    });
    const statement = scored({
      id: 'statement',
      text: 'Tell me the one workflow change that saved your team the most time this year and how teams handle it',
    });
    expect(question.headline).toBeGreaterThan(statement.headline);
    const entry = byId(question, 'question');
    expect(entry.points).toBe(TARGET_CONFIG.weights.question);
    expect(entry.value).toContain('question');
    expect(byId(statement, 'question').points).toBe(0);
  });
});

describe('composite preference (VAL-TARGET-009)', () => {
  const questionText =
    'What is the one workflow change that saved your team the most time this year? Curious how teams handle it';
  const promoText =
    'Check out our new product launch page for every detail about pricing and the full feature list today';

  it('a fresh high-velocity question post outscores a stale self-promotional post', () => {
    const question = scored({
      id: 'q1',
      text: questionText,
      ageMinutes: 120,
      likeCount: 1200,
      replyCount: 240,
      repostCount: 300,
    });
    const stale = scored({
      id: 's1',
      text: promoText,
      ageMinutes: 72 * 60,
      likeCount: 1200,
      replyCount: 240,
      repostCount: 300,
    });
    expect(stale.eligible).toBe(false); // the 48h filter removes it before any counting matters
    expect(stale.headline).toBe(0);
    expect(question.headline).toBeGreaterThan(stale.headline);
  });

  it('the question post also wins while both posts are eligible', () => {
    const question = scored({ id: 'q2', text: questionText, ageMinutes: 120, likeCount: 400, replyCount: 80, repostCount: 100 });
    const promo = scored({ id: 'p2', text: promoText, ageMinutes: 43 * 60, likeCount: 3, replyCount: 0, repostCount: 1 });
    expect(question.eligible).toBe(true);
    expect(promo.eligible).toBe(true);
    expect(question.headline).toBeGreaterThan(promo.headline);
    expect(byId(question, 'velocity').points).toBeGreaterThan(byId(promo, 'velocity').points);
  });
});

describe('engagement-bait downrank (VAL-TARGET-011)', () => {
  it.each([
    [
      'like-and-retweet bait',
      'Like and retweet if you want the full checklist in your feed next week, no other strings attached at all',
      'Retweets put the full checklist in the feed of people who want it next week, no other strings attached at all',
    ],
    [
      'follow begging',
      'Follow me if you want practical advice about shipping products in your feed every single week going forward',
      'Practical advice about shipping products lands in your feed every single week going forward, worth the read',
    ],
  ] as const)('bait "%s" downranks below its clean twin', (_label, bait, clean) => {
    const baitScore = scored({ id: 'bait', text: bait, ageMinutes: 120, likeCount: 500, replyCount: 100, repostCount: 50 });
    const cleanScore = scored({ id: 'clean', text: clean, ageMinutes: 120, likeCount: 500, replyCount: 100, repostCount: 50 });
    expect(baitScore.eligible).toBe(true); // bait is a downrank, not an exclusion
    expect(baitScore.headline).toBeLessThan(cleanScore.headline);
    const entry = byId(baitScore, 'engagement-bait');
    expect(entry.points).toBe(TARGET_CONFIG.weights.engagementBait);
    expect(entry.direction).toBe('negative');
    expect(entry.value).toContain('bait pattern');
    expect(byId(cleanScore, 'engagement-bait').points).toBe(0);
  });
});

describe('mutual-follow boost (VAL-TARGET-012)', () => {
  it('a visible network relationship boosts the original post only', () => {
    const mutualOriginal = scored({ id: 'mutual', inNetwork: true });
    const nonMutualOriginal = scored({ id: 'nonmutual', inNetwork: false });

    expect(mutualOriginal.headline).toBeGreaterThan(nonMutualOriginal.headline);
    const boost = byId(mutualOriginal, 'mutual-follow');
    expect(boost.applied).toBe(true);
    expect(boost.points).toBe(TARGET_CONFIG.weights.mutualBoost);
    expect(boost.direction).toBe('positive');
    expect(boost.value).toContain('follows');
    expect(byId(nonMutualOriginal, 'mutual-follow').applied).toBe(false);
  });

  it('never applies the boost to replies used as targets', () => {
    const inNetworkReply = scored({ isReply: true, inNetwork: true });
    const entry = byId(inNetworkReply, 'mutual-follow');
    expect(entry.applied).toBe(false);
    expect(entry.points).toBe(0);
    expect(entry.value).toContain('not applied');
  });

  it('never guesses the boost when the follow marker is absent', () => {
    const unmarked = scored({ inNetwork: false });
    const entry = byId(unmarked, 'mutual-follow');
    expect(entry.applied).toBe(false);
    expect(entry.points).toBe(0);
    expect(entry.value).toContain('never guessed');
  });
});

describe('engagement-velocity signal', () => {
  it('bands visible counts per post age', () => {
    const fast = scored({ id: 'fast', ageMinutes: 60, likeCount: 240, replyCount: 60, repostCount: 100 }); // 400/h
    const slow = scored({ id: 'slow', ageMinutes: 43 * 60, likeCount: 40, replyCount: 10, repostCount: 12 }); // ~1.4/h
    expect(byId(fast, 'velocity').points).toBe(TARGET_CONFIG.velocityBands[0]!.points);
    expect(byId(slow, 'velocity').points).toBe(3);
    expect(fast.headline).toBeGreaterThan(slow.headline);
    expect(byId(fast, 'velocity').value).toContain('400 engagements');
  });

  it('never guesses velocity when no engagement counts are visible', () => {
    const entry = byId(scored({}), 'velocity');
    expect(entry.applied).toBe(false);
    expect(entry.points).toBe(0);
    expect(entry.value).toContain('never guessed');
  });

  it('zero visible engagement scores no velocity', () => {
    const entry = byId(scored({ likeCount: 0, replyCount: 0, repostCount: 0 }), 'velocity');
    expect(entry.applied).toBe(false);
    expect(entry.points).toBe(0);
    expect(entry.value).toContain('no visible engagement');
  });

  it('a brand-new post with engagement reads as top-band velocity (age clamped at 1 minute)', () => {
    const entry = byId(scored({ ageMinutes: 0, likeCount: 10, replyCount: 2, repostCount: 0 }), 'velocity');
    expect(entry.applied).toBe(true);
    expect(entry.points).toBe(TARGET_CONFIG.velocityBands[0]!.points);
  });
});

describe('reply:like ratio signal details', () => {
  it('never guesses the ratio when either count is missing', () => {
    expect(byId(scored({ replyCount: 40 }), 'reply-like-ratio').applied).toBe(false);
    expect(byId(scored({ likeCount: 40 }), 'reply-like-ratio').applied).toBe(false);
  });

  it('replies with zero likes are the top of the conversation bands', () => {
    const entry = byId(scored({ likeCount: 0, replyCount: 5 }), 'reply-like-ratio');
    expect(entry.applied).toBe(true);
    expect(entry.points).toBe(TARGET_CONFIG.replyRatioBands[0]!.points);
  });

  it('a post with no replies shows an unstarted conversation, not a ratio', () => {
    const entry = byId(scored({ likeCount: 300, replyCount: 0 }), 'reply-like-ratio');
    expect(entry.applied).toBe(false);
    expect(entry.points).toBe(0);
    expect(entry.value).toContain('no replies');
  });
});
