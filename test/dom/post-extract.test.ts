import { beforeEach, describe, expect, it } from 'vitest';
import { extractPostSnapshot, getPostText } from '../../src/dom/timeline-scanner/extract';
import { FIXTURE_POSTS, formatCount, renderPost } from '../fixtures/x-fixture';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const MIN = 60_000;

/** Fixture time labels are baked relative to the render `now`; extraction is injected the same one. */
function articleFor(index: number): HTMLElement {
  document.body.innerHTML = renderPost(FIXTURE_POSTS[index]!, NOW);
  return document.querySelector('article[data-testid="tweet"]')!;
}

/** A fixture post's raw button label for a metric, e.g. the pt-BR like label "1,2 mil Curtidas. Curtir". */
function labelFor(postIndex: number, key: 'reply' | 'retweet' | 'like'): string {
  return articleFor(postIndex).querySelector(`[data-testid="${key}"]`)!.getAttribute('aria-label')!;
}

describe('PostSnapshot extraction, field-for-field (VAL-TARGET-025)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('extracts the first fixture post completely', () => {
    const post = FIXTURE_POSTS[0]!;
    const snapshot = extractPostSnapshot(articleFor(0), { now: NOW })!;

    expect(snapshot.id).toBe(post.id); // from the status URL
    expect(new URL(snapshot.url).pathname).toBe(`/${post.handle}/status/${post.id}`);
    expect(snapshot.text).toBe(post.text);
    expect(snapshot.authorHandle).toBe(post.handle);
    expect(snapshot.verified).toBe(true); // icon-verified present
    expect(snapshot.hasMedia).toBe(false);
    expect(snapshot.isReply).toBe(false);
    expect(snapshot.inNetwork).toBe(true); // the fixture's viewer-follows-author marker
    expect(snapshot.ageMinutes).toBe(post.ageMinutes); // from time[datetime]
    expect(snapshot.likeCount).toBe(post.likes);
    expect(snapshot.replyCount).toBe(post.replies);
    expect(snapshot.repostCount).toBe(post.reposts);
    expect('replyToHandle' in snapshot).toBe(false); // no reply chip: field absent, never guessed
  });

  it('marks verified only when icon-verified is present', () => {
    expect(extractPostSnapshot(articleFor(0), { now: NOW })!.verified).toBe(true); // ana_builds
    expect(extractPostSnapshot(articleFor(1), { now: NOW })!.verified).toBe(false); // joaodev
  });

  it('detects media from the article structure', () => {
    expect(extractPostSnapshot(articleFor(2), { now: NOW })!.hasMedia).toBe(true); // tweetPhoto
    expect(extractPostSnapshot(articleFor(1), { now: NOW })!.hasMedia).toBe(false);
  });

  it('reads reply context from the visible reply chip, not from post text', () => {
    const reply = extractPostSnapshot(articleFor(4), { now: NOW })!; // carla_ml replying to ana_builds
    expect(reply.isReply).toBe(true);
    expect(reply.replyToHandle).toBe('ana_builds');

    // A mention in the post TEXT is not reply context: only a visible chip outside tweetText is.
    const plain = extractPostSnapshot(articleFor(1), { now: NOW })!;
    expect(plain.isReply).toBe(false);
  });

  it('isReply stays false when a mention link lives inside the tweet text', () => {
    document.body.innerHTML = renderPost(FIXTURE_POSTS[1]!, NOW);
    const article = document.querySelector('article[data-testid="tweet"]')!;
    const tweetText = article.querySelector('[data-testid="tweetText"]')!;
    const mention = document.createElement('a');
    mention.setAttribute('href', '/ana_builds');
    mention.setAttribute('role', 'link');
    mention.textContent = '@ana_builds';
    tweetText.prepend(mention);

    const snapshot = extractPostSnapshot(article, { now: NOW })!;
    expect(snapshot.isReply).toBe(false);
    expect('replyToHandle' in snapshot).toBe(false);
  });

  it('extracts inNetwork false when no follow marker is present', () => {
    expect(extractPostSnapshot(articleFor(1), { now: NOW })!.inNetwork).toBe(false);
  });

  it('parses engagement counts digits-only from the localized (pt-BR) labels', () => {
    // ana_builds: 45 replies / 12 reposts / 310 likes — labels say "45 Respostas. Responder" etc.
    const first = extractPostSnapshot(articleFor(0), { now: NOW })!;
    expect([first.replyCount, first.repostCount, first.likeCount]).toEqual([45, 12, 310]);
    expect(labelFor(0, 'like')).toContain('Curtidas'); // the words are present but never anchors

    // Compact counts: 1200 renders "1,2 mil", 5400 renders "5,4 mil" — both parse to the digits.
    expect(labelFor(2, 'like')).toBe(`${formatCount(1200)} Curtidas. Curtir`);
    const marina = extractPostSnapshot(articleFor(2), { now: NOW })!;
    expect([marina.replyCount, marina.repostCount, marina.likeCount]).toEqual([88, 140, 1200]);
    const weekly = extractPostSnapshot(articleFor(5), { now: NOW })!;
    expect([weekly.replyCount, weekly.repostCount, weekly.likeCount]).toEqual([210, 980, 5400]);
  });

  it('parses identical counts when the label words change entirely (digits are the source)', () => {
    document.body.innerHTML = renderPost(FIXTURE_POSTS[0]!, NOW);
    const article = document.querySelector('article[data-testid="tweet"]')!;
    // Relabel every button with different words around the SAME digits (even English ones).
    for (const [testid, words] of [
      ['reply', 'answers'],
      ['retweet', 'echoes'],
      ['like', 'hearts'],
    ] as const) {
      const button = article.querySelector(`[data-testid="${testid}"]`)!;
      const digits = /[\d.,]+/.exec(button.getAttribute('aria-label')!)![0];
      button.setAttribute('aria-label', `${digits} ${words}`);
    }
    const snapshot = extractPostSnapshot(article, { now: NOW })!;
    expect([snapshot.replyCount, snapshot.repostCount, snapshot.likeCount]).toEqual([45, 12, 310]);
  });

  it('omits count fields the article does not display (zero-count posts show no count)', () => {
    const snapshot = extractPostSnapshot(articleFor(6), { now: NOW })!; // newbie_01: all zero
    expect('replyCount' in snapshot).toBe(false);
    expect('repostCount' in snapshot).toBe(false);
    expect('likeCount' in snapshot).toBe(false);
  });

  it('joins multi-line post text with newlines at the <br> boundaries', () => {
    const snapshot = extractPostSnapshot(articleFor(5), { now: NOW })!; // tech_weekly list
    expect(snapshot.text).toBe(FIXTURE_POSTS[5]!.text);
    expect(snapshot.text).toContain('\n');
    expect(getPostText(articleFor(5))).toBe(FIXTURE_POSTS[5]!.text);
  });

  it('returns null for articles without the structural minimum (status link + time + author)', () => {
    // No timestamp: age is not determinable — skip the article entirely.
    document.body.innerHTML = renderPost(FIXTURE_POSTS[0]!, NOW);
    document.querySelector('time[datetime]')!.closest('a')!.remove();
    expect(extractPostSnapshot(document.querySelector('article')!, { now: NOW })).toBeNull();

    // No status link: no id, no url — skip.
    document.body.innerHTML = renderPost(FIXTURE_POSTS[0]!, NOW);
    for (const link of document.querySelectorAll('a[href*="/status/"]')) link.remove();
    expect(extractPostSnapshot(document.querySelector('article')!, { now: NOW })).toBeNull();

    // No article furniture at all.
    document.body.innerHTML = '<article><p>not a post</p></article>';
    expect(extractPostSnapshot(document.querySelector('article')!, { now: NOW })).toBeNull();
  });

  it('clamps a skewed future timestamp to age 0 instead of a negative age', () => {
    document.body.innerHTML = renderPost(FIXTURE_POSTS[1]!, NOW);
    const article = document.querySelector('article[data-testid="tweet"]')!;
    article.querySelector('time')!.setAttribute('datetime', new Date(NOW + 5 * MIN).toISOString());
    expect(extractPostSnapshot(article, { now: NOW })!.ageMinutes).toBe(0);
  });

  it('skips articles whose status link is a reserved non-handle route', () => {
    document.body.innerHTML = renderPost(FIXTURE_POSTS[0]!, NOW);
    const article = document.querySelector('article[data-testid="tweet"]')!;
    article.querySelector('a[href*="/status/"]')!.setAttribute('href', '/i/status/1800000000000000001');
    expect(extractPostSnapshot(article, { now: NOW })).toBeNull();
  });
});
