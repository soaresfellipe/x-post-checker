import { describe, expect, it } from 'vitest';
import { parseHashtags, parseUrls, type DraftSnapshot } from '../../src/core/draft-snapshot';
import {
  classifyLink,
  composeHeadline,
  HEURISTIC_CONFIG,
  JEV_BAND_LABELS,
  mapJevBand,
  scoreDraft,
  toJevVerdict,
  type JevBand,
  type LocalScore,
  type SignalEntry,
} from '../../src/core/heuristic-engine';

/**
 * Snapshot factory: text-derived fields (hashtags, urls, charCount) are parsed exactly like the
 * composer watcher's extractor would, so single-signal pairs vary ONE signal at a time.
 */
function snapshot(partial: Partial<DraftSnapshot> & { text: string }): DraftSnapshot {
  return {
    hashtags: parseHashtags(partial.text),
    urls: parseUrls(partial.text),
    hasMedia: false,
    isReply: false,
    charCount: partial.text.length,
    capturedAt: 0,
    ...partial,
  };
}

/**
 * Neutral filler that lifts a draft into the ideal length band (100-280 chars) WITHOUT touching
 * any other signal: no digits, no '?', no '#', no URL, no bait/claim/DM/quotable/save keywords.
 */
const FILLER = ' More context follows here.';
function padTo(text: string, min = 120): string {
  let padded = text;
  while (padded.length < min) padded += FILLER;
  return padded;
}

function byId(score: LocalScore, id: string): SignalEntry {
  const found = score.signals.find((signal) => signal.id === id);
  expect(found, `signal ${id} present in breakdown`).toBeDefined();
  return found as SignalEntry;
}

const IDEAL_BAND = HEURISTIC_CONFIG.lengthBands.find((band) => band.id === 'ideal')!;

describe('hybrid headline formula (VAL-DRAFT-026)', () => {
  it.each([
    // [local, ordinal, expected] — hand-computed from round(0.6*local + 0.4*(ordinal/5*100)).
    [50, 3.44, 58], // contract example: 30 + 0.4*68.8 = 57.52 -> 58
    [80, 4.5, 84], // formula applied to the contract's (80, 4.5) pair: 48 + 0.4*90 = 84
    [80, 4.0, 80], // the pair consistent with the contract's "-> 80" result: 48 + 0.4*80 = 80
    [75, 3.7, 75], // 45 + 29.6 = 74.6 -> 75 (rounding case)
    [67, 2.9, 63], // 40.2 + 23.2 = 63.4 -> 63 (rounding case)
    [0, 0, 0],
    [0, 5, 40],
    [100, 0, 60],
    [100, 5, 100],
  ])('local %i + ordinal %s -> headline %i', (local, ordinal, expected) => {
    expect(composeHeadline(local, ordinal)).toBe(expected);
  });

  it('falls back to the local headline unchanged when no Jev verdict exists', () => {
    expect(composeHeadline(73)).toBe(73);
    expect(composeHeadline(73, undefined)).toBe(73);
    expect(composeHeadline(73, null)).toBe(73);
  });

  it('ignores non-finite ordinals and clamps out-of-range inputs defensively', () => {
    expect(composeHeadline(73, Number.NaN)).toBe(73);
    expect(composeHeadline(73, Number.POSITIVE_INFINITY)).toBe(73);
    expect(composeHeadline(80, 7)).toBe(88); // ordinal clamped to 5: 48 + 40
    expect(composeHeadline(80, -2)).toBe(48); // ordinal clamped to 0: 48 + 0
    expect(composeHeadline(120, 5)).toBe(100); // local clamped to 100
  });
});

describe('Jev band mapping', () => {
  it.each([
    [0, 'weak'],
    [1, 'weak'],
    [1.49, 'weak'],
    [1.5, 'below-average'],
    [2, 'below-average'],
    [2.49, 'below-average'],
    [2.5, 'moderate'],
    [3, 'moderate'],
    [3.49, 'moderate'],
    [3.5, 'strong'],
    [4, 'strong'],
    [4.49, 'strong'],
    [4.5, 'exceptional'],
    [5, 'exceptional'],
  ] as const)('ordinal %s maps to band %s', (ordinal, band) => {
    expect(mapJevBand(ordinal)).toBe(band);
  });

  it('clamps out-of-range and non-finite ordinals into the table', () => {
    expect(mapJevBand(-1)).toBe('weak');
    expect(mapJevBand(9)).toBe('exceptional');
    expect(mapJevBand(Number.NaN)).toBe('weak');
  });

  it('exposes English display labels for every band', () => {
    const bands: JevBand[] = ['weak', 'below-average', 'moderate', 'strong', 'exceptional'];
    for (const band of bands) {
      expect(JEV_BAND_LABELS[band]).toMatch(/^[A-Z][A-Za-z ]+$/);
    }
    expect(JEV_BAND_LABELS['below-average']).toBe('Below avg');
  });

  it('builds a full verdict from an ordinal + confidence, deriving the band', () => {
    const verdict = toJevVerdict({ ordinal: 4.2, confidence: 0.81, weaknesses: ['No question'] });
    expect(verdict.band).toBe('strong');
    expect(verdict.strengths).toEqual([]);
    expect(verdict.weaknesses).toEqual(['No question']);
    expect(verdict.suggestions).toEqual([]);
  });
});

describe('scoreDraft — signal direction table (VAL-DRAFT-027)', () => {
  it('a question draft outscores its plain-statement twin', () => {
    const question = scoreDraft(snapshot({ text: padTo('What is the one metric you check first every single morning when you open your analytics dashboard at work?') }));
    const statement = scoreDraft(snapshot({ text: padTo('Tell me which metric you check first every single morning when you open your analytics dashboard at work') }));
    expect(question.headline).toBeGreaterThan(statement.headline);
    expect(byId(question, 'reply-magnet').points).toBe(HEURISTIC_CONFIG.replyMagnet.question);
    expect(byId(statement, 'reply-magnet').points).toBe(0);
    expect(byId(question, 'reply-magnet').value).toContain('question');
  });

  it('a strong-claim draft outscores its hedged twin', () => {
    const claim = scoreDraft(snapshot({ text: padTo('Remote work is the best thing that ever happened to focused engineering teams, and the data agrees') }));
    const hedged = scoreDraft(snapshot({ text: padTo('Remote work seems like a good thing that happened to focused engineering teams, and the data agrees') }));
    expect(claim.headline).toBeGreaterThan(hedged.headline);
    expect(byId(claim, 'reply-magnet').points).toBe(HEURISTIC_CONFIG.replyMagnet.strongClaim);
  });

  it('question + strong claim together weigh highest but stay capped', () => {
    const both = scoreDraft(snapshot({ text: padTo('What is the single worst habit that always kills team focus, and why does nobody talk about it?') }));
    const magnet = byId(both, 'reply-magnet');
    expect(magnet.points).toBe(HEURISTIC_CONFIG.replyMagnet.maxPoints);
    expect(magnet.value).toContain('question');
    expect(magnet.value).toContain('strong claim');
  });

  it.each([
    ['stats', 'The numbers are in: 71% of new founders quit within their first two years, and the data explains why', 'Most founders walk away within their first two years, and the data does a decent job explaining why'],
    ['list', 'Monday plan is short and simple today so nothing slips through the cracks before noon\n- review metrics\n- ship one fix', 'Monday plan is short and simple today so nothing slips through the cracks before noon: review metrics and ship one fix'],
    ['quotable', 'Reminder: focus compounds quietly over months, and the boring routine beats motivation every time here', 'A gentle reminder that focus compounds quietly over months, and the boring routine beats motivation here'],
    ['save-this', 'Save this checklist before your next product launch so you do not repeat the mistakes that cost me months', 'Keep the launch checklist handy before your next product release so you avoid the mistakes that cost me months'],
  ])('a shareable-format draft (%s) outscores plain prose', (format, shareable, prose) => {
    const shareableScore = scoreDraft(snapshot({ text: padTo(shareable) }));
    const proseScore = scoreDraft(snapshot({ text: padTo(prose) }));
    expect(shareableScore.headline).toBeGreaterThan(proseScore.headline);
    const entry = byId(shareableScore, 'copy-link');
    expect(entry.points).toBe(HEURISTIC_CONFIG.weights.copyLinkTrigger);
    expect(entry.direction).toBe('positive');
    expect(entry.value).toContain(format);
    expect(byId(proseScore, 'copy-link').points).toBe(0);
  });

  it('a DM-share draft outscores its send-to-nobody twin', () => {
    const dm = scoreDraft(snapshot({ text: 'This checklist will save you hours of setup work every single week, so send this to a friend who dreads configuring tools' }));
    const plain = scoreDraft(snapshot({ text: 'This checklist will save you hours of setup work every single week, and every friend who dreads configuring tools needs it' }));
    expect(dm.headline).toBeGreaterThan(plain.headline);
    expect(byId(dm, 'share-dm').points).toBe(HEURISTIC_CONFIG.weights.shareDmTrigger);
    expect(byId(plain, 'share-dm').points).toBe(0);
  });

  it('hashtags follow the diminishing/negative band table', () => {
    const base = padTo('Building in public keeps me accountable while I ship small features and write honest notes about growth');
    const counts = [0, 1, 2, 3, 4, 5];
    const tags = ['#buildinpublic', '#shipping', '#startup', '#saas', '#devlife'];
    const scores = counts.map((count) =>
      scoreDraft(snapshot({ text: `${base} ${tags.slice(0, count).join(' ')}`.trim() })),
    );
    scores.forEach((score, index) => {
      const count = counts[index]!;
      const band = HEURISTIC_CONFIG.hashtagBands.find((candidate) => count <= candidate.max)!;
      const hashtagEntry = byId(score, 'hashtags');
      expect(hashtagEntry.value).toContain(`${count}`);
      expect(hashtagEntry.points).toBe(band.points);
    });
    // Approved directions: 1-2 optimal, 3 diminishing, 4+ penalized.
    expect(scores[1]!.headline).toBeGreaterThan(scores[3]!.headline);
    expect(scores[2]!.headline).toBeGreaterThan(scores[3]!.headline);
    expect(scores[3]!.headline).toBeGreaterThan(scores[4]!.headline);
    expect(scores[4]!.headline).toBeGreaterThan(scores[5]!.headline);
    expect(byId(scores[3]!, 'hashtags').direction).toBe('positive'); // diminishing, still positive
    expect(byId(scores[4]!, 'hashtags').direction).toBe('negative'); // beyond 3 turns negative
  });

  it('a draft with more than 3 hashtags scores below the same draft with 1-2 hashtags (VAL-DRAFT-027)', () => {
    const base = padTo('Building in public keeps me accountable while I ship small features and write honest notes about growth');
    const few = scoreDraft(snapshot({ text: `${base} #buildinpublic #shipping` }));
    const many = scoreDraft(snapshot({ text: `${base} #buildinpublic #shipping #startup #saas #devlife` }));
    expect(few.headline).toBeGreaterThan(many.headline);
    const delta = byId(few, 'hashtags').points - byId(many, 'hashtags').points;
    expect(delta).toBeGreaterThan(0);
  });

  it('external links are a minor negative against a link-free twin', () => {
    const text = 'Read the full analysis on our blog and tell us what you think about it when you can';
    const withLink = scoreDraft(snapshot({ text, urls: ['https://example.com/full-analysis'] }));
    const withoutLink = scoreDraft(snapshot({ text }));
    expect(withLink.headline).toBeLessThan(withoutLink.headline);
    const entry = byId(withLink, 'external-link');
    expect(entry.points).toBe(HEURISTIC_CONFIG.weights.externalLink);
    expect(entry.direction).toBe('negative');
    expect(entry.value).toContain('1');
    expect(byId(withoutLink, 'external-link').points).toBe(0);
  });

  it('media presence is a small positive flag', () => {
    const text = padTo('A quick note with the launch photo attached for those who asked about it last week');
    const withMedia = scoreDraft(snapshot({ text, hasMedia: true }));
    const withoutMedia = scoreDraft(snapshot({ text }));
    expect(withMedia.headline).toBeGreaterThan(withoutMedia.headline);
    expect(byId(withMedia, 'media').points).toBe(HEURISTIC_CONFIG.weights.media);
    expect(byId(withoutMedia, 'media').points).toBe(0);
  });

  it.each([
    ['like-and-retweet bait', 'Like and retweet if you want more practical writing advice like this in your feed every week going forward', 'Retweets help practical writing advice reach readers who want it in their feed every week going forward'],
    ['follow begging', 'Follow me if you want daily advice about writing and growing an audience from someone who ships every week', 'Daily advice about writing and growing an audience from someone who ships every single week, worth reading'],
  ])('engagement bait is heavily penalized below its clean twin (%s)', (_label, bait, clean) => {
    const baitScore = scoreDraft(snapshot({ text: padTo(bait) }));
    const cleanScore = scoreDraft(snapshot({ text: padTo(clean) }));
    expect(baitScore.headline).toBeLessThan(cleanScore.headline);
    const entry = byId(baitScore, 'engagement-bait');
    expect(entry.points).toBe(HEURISTIC_CONFIG.weights.engagementBait);
    expect(entry.direction).toBe('negative');
    expect(entry.value.toLowerCase()).toContain('bait');
    expect(byId(cleanScore, 'engagement-bait').points).toBe(0);
  });

  it('ALL-CAPS shouting is a moderation penalty against the same text in normal case', () => {
    const base = padTo('stop scrolling and read this part twice before you post anything else online today');
    const shouting = scoreDraft(snapshot({ text: base.toUpperCase() }));
    const calm = scoreDraft(snapshot({ text: base.toLowerCase() }));
    expect(shouting.headline).toBeLessThan(calm.headline);
    const entry = byId(shouting, 'moderation');
    expect(entry.points).toBe(HEURISTIC_CONFIG.moderation.allCapsPoints);
    expect(entry.value).toContain('ALL-CAPS');
    expect(byId(calm, 'moderation').points).toBe(0);
  });

  it('excessive punctuation runs are a moderation penalty', () => {
    const base = padTo('This launch news is genuinely huge for the whole community');
    const hyped = scoreDraft(snapshot({ text: `${base}!!!` }));
    const plain = scoreDraft(snapshot({ text: `${base}.` }));
    expect(hyped.headline).toBeLessThan(plain.headline);
    expect(byId(hyped, 'moderation').points).toBe(HEURISTIC_CONFIG.moderation.excessivePunctuationPoints);
  });

  it('length bands: ideal outscores very short, overlong is penalized', () => {
    const ideal = scoreDraft(snapshot({ text: padTo('Quick note about shipping small things') }));
    const veryShort = scoreDraft(snapshot({ text: 'Quick note today.' }));
    const overlong = scoreDraft(snapshot({ text: padTo(idealText(), HEURISTIC_CONFIG.lengthBands.find((b) => b.id === 'overlong')!.min + 5) }));
    expect(byId(ideal, 'length').points).toBe(IDEAL_BAND.points);
    expect(byId(veryShort, 'length').points).toBeLessThan(0);
    expect(byId(overlong, 'length').points).toBeLessThan(0);
    expect(ideal.headline).toBeGreaterThan(veryShort.headline);
  });

  it('a question mark inside a URL does not count as a question', () => {
    const score = scoreDraft(snapshot({ text: padTo('Full config guide lives at https://example.com/settings?page=2 if you want every option explained') }));
    expect(byId(score, 'reply-magnet').points).toBe(0);
    expect(byId(score, 'reply-magnet').value).toContain('none');
  });
});

function idealText(): string {
  return 'Quick note about shipping small things';
}

describe('reply-draft mutual signal (VAL-DRAFT-028)', () => {
  const text = padTo('Happy to dig deeper into this thread and share the numbers behind the launch next week');
  const replyBase: Partial<DraftSnapshot> = { isReply: true, replyToHandle: 'someone' };

  it('a reply draft with a visible followed target scores higher than without the field', () => {
    const withFollow = scoreDraft(snapshot({ text, ...replyBase, replyToFollowedByViewer: true }));
    const withoutField = scoreDraft(snapshot({ text, ...replyBase }));
    expect(withFollow.headline).toBeGreaterThan(withoutField.headline);
    const boost = byId(withFollow, 'reply-mutual');
    expect(boost.applied).toBe(true);
    expect(boost.points).toBe(HEURISTIC_CONFIG.weights.replyMutualBoost);
    expect(boost.direction).toBe('positive');
  });

  it('applies no boost when the follow field is absent — never guessed', () => {
    const withoutField = scoreDraft(snapshot({ text, ...replyBase }));
    const entry = byId(withoutField, 'reply-mutual');
    expect(entry.applied).toBe(false);
    expect(entry.points).toBe(0);
    expect(entry.direction).toBe('neutral');
    expect(entry.value).toContain('not visible');
  });

  it('applies no boost when the visible state says the target does NOT follow the viewer', () => {
    const notFollowed = scoreDraft(snapshot({ text, ...replyBase, replyToFollowedByViewer: false }));
    const entry = byId(notFollowed, 'reply-mutual');
    expect(entry.applied).toBe(false);
    expect(entry.points).toBe(0);
  });

  it('never applies the boost to a non-reply draft', () => {
    const original = scoreDraft(snapshot({ text }));
    const entry = byId(original, 'reply-mutual');
    expect(entry.applied).toBe(false);
    expect(entry.points).toBe(0);
    expect(original.headline).toBe(scoreDraft(snapshot({ text, replyToFollowedByViewer: true })).headline);
  });

  it('the reply-context entry reflects the reply state in the breakdown (VAL-DRAFT-019 support)', () => {
    const reply = scoreDraft(snapshot({ text, ...replyBase }));
    const original = scoreDraft(snapshot({ text }));
    expect(byId(reply, 'reply-mutual').value).toContain('reply');
    expect(byId(original, 'reply-mutual').value).toContain('not a reply');
  });
});

describe('link classification by expanded destination (scrutiny round-1 fix)', () => {
  // Filler text free of every other signal (no digits, '?', '#', bait/claim/DM/quotable/save
  // words), so the url list below is the ONLY varying input of each pair.
  const linkText = padTo('Read the whole breakdown of how this launch came together and what the team learned building it');
  const INTERNAL_URL = 'https://x.com/someone/status/456';
  const EXTERNAL_URL = 'https://example.com/full-analysis';
  const SHORT_URL = 'https://t.co/abc123';

  function linkEntry(urls: string[]): SignalEntry {
    return byId(scoreDraft(snapshot({ text: linkText, urls })), 'external-link');
  }

  it('an internal x.com status link takes no external-link penalty and is never labeled external', () => {
    const entry = linkEntry([INTERNAL_URL]);
    expect(entry.points).toBe(0);
    expect(entry.applied).toBe(false);
    expect(entry.direction).toBe('neutral');
    expect(entry.label.toLowerCase()).not.toContain('external');
    expect(entry.value.toLowerCase()).not.toContain('external');
    expect(entry.value).toContain('on-platform');
    expect(entry.value).toContain('x.com');
  });

  it('an internal link scores exactly like its link-free twin', () => {
    const internal = scoreDraft(snapshot({ text: linkText, urls: [INTERNAL_URL] }));
    const linkFree = scoreDraft(snapshot({ text: linkText }));
    expect(internal.headline).toBe(linkFree.headline);
    expect(internal.totalPoints).toBe(linkFree.totalPoints);
  });

  it.each([
    ['status permalink', 'https://x.com/someone/status/456'],
    ['twitter.com status permalink', 'https://twitter.com/someone/status/456'],
    ['www subdomain', 'https://www.x.com/someone/status/456'],
    ['mobile subdomain', 'https://mobile.twitter.com/someone/status/456'],
    ['profile destination', 'https://x.com/someone'],
    ['case-insensitive host', 'https://X.com/someone/status/456'],
  ])('on-platform destinations go unpenalized (%s)', (_label, url) => {
    const entry = linkEntry([url]);
    expect(entry.points, url).toBe(0);
    expect(entry.applied, url).toBe(false);
    expect(entry.value.toLowerCase(), url).not.toContain('external');
  });

  it('an off-platform link keeps the configured minor negative', () => {
    const entry = linkEntry([EXTERNAL_URL]);
    expect(entry.points).toBe(HEURISTIC_CONFIG.weights.externalLink);
    expect(entry.direction).toBe('negative');
    expect(entry.applied).toBe(true);
    expect(entry.value).toContain('external');
    expect(scoreDraft(snapshot({ text: linkText, urls: [EXTERNAL_URL] })).headline).toBeLessThan(
      scoreDraft(snapshot({ text: linkText })).headline,
    );
  });

  it('lookalike hosts do not pass as on-platform', () => {
    for (const url of ['https://xcompany.com/page', 'https://x.com.evil.io/page']) {
      const entry = linkEntry([url]);
      expect(entry.points, url).toBe(HEURISTIC_CONFIG.weights.externalLink);
      expect(entry.direction, url).toBe('negative');
    }
  });

  it('an unexpandable t.co link gets no penalty and shows the short URL - destination never guessed', () => {
    const entry = linkEntry([SHORT_URL]);
    expect(entry.points).toBe(0);
    expect(entry.applied).toBe(false);
    expect(entry.direction).toBe('neutral');
    expect(entry.value).toContain(SHORT_URL);
    expect(entry.value).toContain('never guessed');
    expect(entry.value.toLowerCase()).not.toContain('external');
    expect(scoreDraft(snapshot({ text: linkText, urls: [SHORT_URL] })).headline).toBe(
      scoreDraft(snapshot({ text: linkText })).headline,
    );
  });

  it('a mixed draft penalizes only the off-platform link', () => {
    const mixed = linkEntry([INTERNAL_URL, EXTERNAL_URL]);
    expect(mixed.points).toBe(HEURISTIC_CONFIG.weights.externalLink);
    expect(mixed.value).toContain('on-platform');
    expect(mixed.value).toContain('external');
    // The internal link adds nothing on top of the off-platform one (one flat penalty per draft).
    expect(scoreDraft(snapshot({ text: linkText, urls: [INTERNAL_URL, EXTERNAL_URL] })).headline).toBe(
      scoreDraft(snapshot({ text: linkText, urls: [EXTERNAL_URL] })).headline,
    );
  });

  it('expanded upstream: text keeps the short form while urls carry the real destination', () => {
    // m2-fix-composer-extraction shape: `text` holds t.co as typed, snapshot.urls the destination.
    const expanded = scoreDraft(snapshot({ text: `${linkText} ${SHORT_URL}`, urls: [EXTERNAL_URL] }));
    expect(byId(expanded, 'external-link').points).toBe(HEURISTIC_CONFIG.weights.externalLink);
    expect(byId(expanded, 'reply-magnet').value).toContain('none'); // the URL fakes no content signal
    expect(byId(expanded, 'copy-link').points).toBe(0);
  });

  it('classifyLink pins the destination table for defensive reuse', () => {
    const onPlatform = [
      INTERNAL_URL,
      'https://twitter.com/someone',
      'https://www.x.com/i/web/status/1',
      'https://mobile.twitter.com/home',
      'www.x.com/status/1',
    ];
    for (const url of onPlatform) expect(classifyLink(url), url).toBe('on-platform');
    expect(classifyLink(SHORT_URL)).toBe('unknown');
    expect(classifyLink('https://www.t.co/abc123')).toBe('unknown');
    expect(classifyLink('not-a-url')).toBe('unknown');
    expect(classifyLink('definitely not a url')).toBe('unknown');
    for (const url of [EXTERNAL_URL, 'https://xcompany.com/page', 'https://x.com.evil.io/page']) {
      expect(classifyLink(url), url).toBe('off-platform');
    }
  });
});

describe('LocalScore output contract', () => {
  it('every score carries a per-signal breakdown with concrete values and directions', () => {
    const score = scoreDraft(snapshot({ text: padTo('What is the secret to a good launch? Sending this to a friend worked for me') }));
    expect(score.signals.length).toBeGreaterThan(0);
    for (const signal of score.signals) {
      expect(signal.id.length).toBeGreaterThan(0);
      expect(signal.label.length).toBeGreaterThan(0);
      expect(signal.value.length).toBeGreaterThan(0);
      expect(['positive', 'negative', 'neutral']).toContain(signal.direction);
      expect(typeof signal.points).toBe('number');
      expect(Number.isFinite(signal.points)).toBe(true);
      expect(signal.applied).toBe(signal.points !== 0);
    }
  });

  it('groups the six contract signals as separate entries for a rich draft', () => {
    const rich = snapshot({
      text: padTo('What always works for a launch? The numbers: 71% of signups came from one change. Save this checklist. #buildinpublic #launch https://example.com/notes'),
      hasMedia: true,
      isReply: true,
      replyToHandle: 'someone',
    });
    const ids = scoreDraft(rich).signals.map((signal) => signal.id);
    for (const expected of ['reply-magnet', 'length', 'hashtags', 'external-link', 'media', 'reply-mutual']) {
      expect(ids, `breakdown entry ${expected}`).toContain(expected);
    }
  });

  it('headline equals the clamped rounding of the neutral base plus total points', () => {
    const score = scoreDraft(snapshot({ text: padTo('What is the one metric you check first every single morning when you open your analytics dashboard at work?') }));
    const total = score.signals.reduce((sum, signal) => sum + signal.points, 0);
    const expected = Math.round(
      Math.min(HEURISTIC_CONFIG.headline.max, Math.max(HEURISTIC_CONFIG.headline.min, HEURISTIC_CONFIG.headline.base + total)),
    );
    expect(score.headline).toBe(expected);
    expect(score.totalPoints).toBeCloseTo(total, 10);
  });

  it('keeps the headline inside 0-100 for maximal penalties and maximal positives', () => {
    const worst = scoreDraft(snapshot({
      text: 'Too short!!!',
      urls: ['https://example.com/a'],
      hashtags: ['a', 'b', 'c', 'd', 'e'],
    }));
    const baitAndShout = scoreDraft(snapshot({ text: `${'LIKE AND RETWEET IF YOU WANT MORE OF THIS '.repeat(6)}FOLLOW ME!!!` }));
    expect(worst.headline).toBeGreaterThanOrEqual(0);
    expect(baitAndShout.headline).toBeGreaterThanOrEqual(0);
    const best = scoreDraft(snapshot({
      text: padTo('What always works? The key is retention: 71% of churn happens in month one.\n- onboard daily\n- measure weekly. Send this to a friend. Save this checklist. #buildinpublic #metrics'),
      hasMedia: true,
      isReply: true,
      replyToFollowedByViewer: true,
    }));
    expect(best.headline).toBeLessThanOrEqual(100);
    expect(baitAndShout.headline).toBeLessThan(best.headline);
  });

  it('does not mutate the snapshot (pure function)', () => {
    const input = snapshot({ text: padTo('What is the one metric you check first every single morning at work?'), isReply: true, replyToFollowedByViewer: true });
    const before = JSON.stringify(input);
    scoreDraft(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('derives every applied point from the central config (no stray weights)', () => {
    const configured = new Set<number>([
      HEURISTIC_CONFIG.weights.likeBaseline,
      HEURISTIC_CONFIG.weights.copyLinkTrigger,
      HEURISTIC_CONFIG.weights.shareDmTrigger,
      HEURISTIC_CONFIG.weights.externalLink,
      HEURISTIC_CONFIG.weights.media,
      HEURISTIC_CONFIG.weights.engagementBait,
      HEURISTIC_CONFIG.weights.replyMutualBoost,
      HEURISTIC_CONFIG.replyMagnet.question,
      HEURISTIC_CONFIG.replyMagnet.strongClaim,
      HEURISTIC_CONFIG.replyMagnet.maxPoints,
      HEURISTIC_CONFIG.moderation.allCapsPoints,
      HEURISTIC_CONFIG.moderation.excessivePunctuationPoints,
      ...HEURISTIC_CONFIG.lengthBands.map((band) => band.points),
      ...HEURISTIC_CONFIG.hashtagBands.map((band) => band.points),
    ]);
    for (const value of Object.values(HEURISTIC_CONFIG.weights)) {
      expect(configured.has(value), `weight ${value} lives in the central config`).toBe(true);
    }
    expect(HEURISTIC_CONFIG.headline.base).toBeGreaterThanOrEqual(0);
    expect(HEURISTIC_CONFIG.hybrid.localWeight + HEURISTIC_CONFIG.hybrid.jevWeight).toBe(1);
  });
});
