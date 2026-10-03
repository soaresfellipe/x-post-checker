/**
 * DOM-side PostSnapshot extraction from timeline articles. Reads ONLY structure (data-testid /
 * role / href shapes) — never localized label text: metric buttons are identified by
 * `data-testid` and their counts parsed digits-only. Every selector comes from
 * `src/selectors.ts`. Normative rules: `docs/timeline-scanner.md`.
 */
import {
  parseLocalizedCount,
  parseStatusLink,
  postAgeMinutes,
  postPublishedAt,
  type PostSnapshot,
  type StatusRouteTarget,
} from '@/core/post-snapshot';
import { findFirst, SELECTORS } from '@/selectors';

/** A profile link's handle (`/<handle>` path), or undefined. */
function handleFromProfileHref(href: string | undefined | null): string | undefined {
  if (!href) return undefined;
  try {
    const match = /^\/([A-Za-z0-9_]{1,20})$/.exec(new URL(href, 'https://x.com').pathname);
    return match ? match[1]! : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The author handle from the article's name row: the `@handle` link first (the `@` glyph is not
 * localized), else the first `/<handle>` profile link in the row. Undefined when the row is
 * absent or malformed.
 */
function findNameRowHandle(article: Element): string | undefined {
  const nameRow = findFirst(article, 'userName');
  if (!nameRow) return undefined;
  const links = [...nameRow.querySelectorAll('a[href]')];
  for (const link of links) {
    if (!(link.textContent ?? '').trim().startsWith('@')) continue;
    const handle = handleFromProfileHref(link.getAttribute('href'));
    if (handle !== undefined) return handle;
  }
  for (const link of links) {
    const handle = handleFromProfileHref(link.getAttribute('href'));
    if (handle !== undefined) return handle;
  }
  return undefined;
}

/**
 * The article's own status target. Primary: the timestamp's permalink (`<a>` wrapping
 * `time[datetime]` — the article's canonical status link on the fixture and the real site).
 * Fallback: a canonical `/<handle>/status/<id>` link OUTSIDE the tweet text, preferring the name
 * row's handle (a mention-link inside the text and quoted-post links must never win).
 */
export function findStatusTarget(article: Element): (StatusRouteTarget & { href: string }) | null {
  for (const link of article.querySelectorAll('a[href]')) {
    if (!link.querySelector('time[datetime]')) continue;
    const target = parseStatusLink(link.getAttribute('href'));
    if (target) return { ...target, href: link.getAttribute('href')! };
  }
  const tweetText = findFirst(article, 'tweetText');
  const nameHandle = findNameRowHandle(article);
  let fallback: (StatusRouteTarget & { href: string }) | null = null;
  for (const link of article.querySelectorAll('a[href]')) {
    if (tweetText?.contains(link)) continue;
    const target = parseStatusLink(link.getAttribute('href'));
    if (!target) continue;
    if (nameHandle !== undefined && target.handle === nameHandle) return { ...target, href: link.getAttribute('href')! };
    fallback ??= { ...target, href: link.getAttribute('href')! };
  }
  return fallback;
}

/** The post text: the tweetText block's content, `<br>` boundaries joined with newlines. */
export function getPostText(article: Element): string {
  const tweetText = findFirst(article, 'tweetText');
  if (!tweetText) return '';
  let text = '';
  const walk = (node: Node): void => {
    if (node.nodeType === node.TEXT_NODE) {
      text += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== node.ELEMENT_NODE) return;
    const element = node as Element;
    if (element.localName === 'br') {
      text += '\n';
      return;
    }
    for (const child of element.childNodes) walk(child);
  };
  for (const child of tweetText.childNodes) walk(child);
  return text;
}

/**
 * The handle of the visible reply chip ("replying to @x"), or undefined. Chip candidates are
 * `@`-prefixed profile links OUTSIDE the name row and the tweet text — a mention inside the post
 * body is not reply context, and the name row is the author's own identity. The author's own
 * handle never counts (self-links appear next to the name row).
 */
function findReplyTarget(article: Element, authorHandle: string): string | undefined {
  const tweetText = findFirst(article, 'tweetText');
  const nameRow = findFirst(article, 'userName');
  for (const link of article.querySelectorAll('a[href]')) {
    if (tweetText?.contains(link) || nameRow?.contains(link)) continue;
    if (link.querySelector('time[datetime]')) continue;
    if (!(link.textContent ?? '').trim().startsWith('@')) continue;
    const handle = handleFromProfileHref(link.getAttribute('href'));
    if (handle !== undefined && handle !== authorHandle) return handle;
  }
  return undefined;
}

/** Digits-only count of one engagement button (identified by testid); absent when unshown. */
function buttonCount(article: Element, key: 'replyButton' | 'retweetButton' | 'likeButton' | 'bookmarkButton'): number | undefined {
  const button = findFirst(article, key);
  if (!button) return undefined;
  // Preferred source: the visible count span (real x.com testid). Fallback: the aria-label's
  // leading token. Both are parsed digits-only.
  const countSpan = button.querySelector(SELECTORS.buttonCount[0]);
  const source = countSpan?.textContent ?? button.getAttribute('aria-label') ?? '';
  return parseLocalizedCount(source);
}

/**
 * Field-for-field PostSnapshot from a live timeline article (VAL-TARGET-025), or null when the
 * article lacks the structural minimum (its own timestamp link — no status link means no id, no
 * url, no author identity; no parseable timestamp means no age). Extraction never guesses: the
 * reply handle is set only from a visible chip, inNetwork only from a registered follow marker,
 * and counts only from digits actually shown.
 */
export function extractPostSnapshot(article: Element, options: { now?: number } = {}): PostSnapshot | null {
  const now = options.now ?? Date.now();
  const time = findFirst(article, 'timestamp');
  if (!time) return null;
  // The EXACT publication instant first (the hard 48h eligibility gate consumes it); the rounded
  // capture age is derived from the same attribute for display/signature granularity.
  const publishedAt = postPublishedAt(time.getAttribute('datetime'));
  if (publishedAt === undefined) return null; // unparseable timestamp: no age, no instant — skip
  const ageMinutes = postAgeMinutes(time.getAttribute('datetime'), now);
  if (ageMinutes === undefined) return null;
  const status = findStatusTarget(article);
  if (!status) return null;

  const replyToHandle = findReplyTarget(article, status.handle);
  const snapshot: PostSnapshot = {
    id: status.id,
    text: getPostText(article),
    authorHandle: status.handle,
    verified: findFirst(article, 'verifiedIcon') !== null,
    hasMedia: SELECTORS.postMedia.some((selector) => article.querySelector(selector) !== null),
    isReply: replyToHandle !== undefined,
    inNetwork: findFirst(article, 'viewerFollowsAuthor') !== null,
    ageMinutes,
    publishedAt,
    url: absoluteUrl(article, status.href),
  };
  if (replyToHandle !== undefined) snapshot.replyToHandle = replyToHandle;
  const replyCount = buttonCount(article, 'replyButton');
  const repostCount = buttonCount(article, 'retweetButton');
  const likeCount = buttonCount(article, 'likeButton');
  if (replyCount !== undefined) snapshot.replyCount = replyCount;
  if (repostCount !== undefined) snapshot.repostCount = repostCount;
  if (likeCount !== undefined) snapshot.likeCount = likeCount;
  return snapshot;
}

/** Absolute form of the status href (resolved against the article's document). */
function absoluteUrl(article: Element, href: string | undefined): string {
  if (!href) return '';
  const base = article.ownerDocument?.baseURI || article.ownerDocument?.defaultView?.location.href || 'https://x.com';
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}
