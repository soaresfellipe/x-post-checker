import { beforeEach, describe, expect, it } from 'vitest';
import { findAll, findFirst, SELECTORS } from '../../src/selectors';
import { FIXTURE_POSTS, formatCount, renderFixtureHtml } from '../fixtures/x-fixture';

describe('x.com fixture + selector registry', () => {
  beforeEach(() => {
    document.body.innerHTML = renderFixtureHtml();
  });

  it('exposes a contenteditable composer with the real data-testid and a localized label', () => {
    const composer = findFirst(document, 'composer');
    expect(composer).not.toBeNull();
    expect(composer!.getAttribute('data-testid')).toBe('tweetTextarea_0');
    expect(composer!.getAttribute('role')).toBe('textbox');
    expect(composer!.getAttribute('contenteditable')).toBe('true');
    expect(composer!.getAttribute('aria-label')).toBe('Texto do post');
  });

  it('renders about ten timeline articles with the real inner data-testids', () => {
    const articles = findAll(document, 'article');
    expect(articles).toHaveLength(FIXTURE_POSTS.length);
    expect(articles.length).toBeGreaterThanOrEqual(10);
    for (const article of articles) {
      for (const key of ['tweetText', 'userName', 'timestamp', 'replyButton', 'retweetButton', 'likeButton', 'bookmarkButton'] as const) {
        expect(findFirst(article, key), key).not.toBeNull();
      }
      expect(article.querySelector('[data-testid="Tweet-User-Avatar"]')).not.toBeNull();
    }
  });

  it('marks verified authors with icon-verified and author links follow /handle/status/id', () => {
    const verifiedCount = FIXTURE_POSTS.filter((post) => post.verified).length;
    expect(document.querySelectorAll(SELECTORS.verifiedIcon[0])).toHaveLength(verifiedCount);
    const first = findAll(document, 'article')[0]!;
    const post = FIXTURE_POSTS[0]!;
    expect(first.querySelector(`a[href="/${post.handle}"]`)).not.toBeNull();
    expect(first.querySelector(`a[href="/${post.handle}/status/${post.id}"]`)).not.toBeNull();
  });

  it('uses time[datetime] with ISO timestamps matching the post age', () => {
    const times = [...document.querySelectorAll('time[datetime]')];
    expect(times).toHaveLength(FIXTURE_POSTS.length);
    const ageMs = Date.now() - Date.parse(times[0]!.getAttribute('datetime')!);
    expect(Math.abs(ageMs - FIXTURE_POSTS[0]!.ageMinutes * 60_000)).toBeLessThan(60_000);
  });

  it('carries localized (pt-BR) action labels and digit counts', () => {
    const like = findAll(document, 'article')[2]!.querySelector('[data-testid="like"]')!;
    expect(like.getAttribute('aria-label')).toBe('1,2 mil Curtidas. Curtir');
    expect(like.textContent).toContain('1,2 mil');
    const reply = findAll(document, 'article')[0]!.querySelector('[data-testid="reply"]')!;
    expect(reply.getAttribute('aria-label')).toBe('45 Respostas. Responder');
    expect(findAll(document, 'article')[0]!.querySelector('[data-testid="retweet"]')!.getAttribute('aria-label')).toBe('12 reposts. Repostar');
  });

  it('falls back to the structural composer selector when the primary testid is absent', () => {
    document.querySelector('[data-testid="tweetTextarea_0"]')!.setAttribute('data-testid', 'tweetTextarea_1');
    expect(findFirst(document, 'composer')?.getAttribute('data-testid')).toBe('tweetTextarea_1');
    document.querySelector('[data-testid="tweetTextarea_1"]')!.removeAttribute('data-testid');
    expect(findFirst(document, 'composer')?.classList.contains('public-DraftEditor-content')).toBe(true);
  });

  it('formats compact counts like x.com', () => {
    expect([formatCount(0), formatCount(14), formatCount(1200), formatCount(5400), formatCount(2000)]).toEqual(['', '14', '1,2 mil', '5,4 mil', '2 mil']);
  });
});
