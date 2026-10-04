/**
 * DOM-side DraftSnapshot extraction. Reads ONLY structure (data-testid / role / contenteditable
 * plus composer-scoped regions) — never localized label text. Every selector comes from
 * `src/selectors.ts`.
 */
import { parseHashtags, parseUrls, statusRouteHandle, type DraftSnapshot } from '@/core/draft-snapshot';
import { SELECTORS, findAllCandidates, isInsideComposerContainer } from '@/selectors';

const COMPOSER_INDEX_PATTERN = /tweetTextarea_(\d+)$/;

/** Numbered-composer index of a `tweetTextarea_N` testid; null for the structural fallback. */
export function getComposerTestidIndex(composer: Element): number | null {
  const testid = composer.getAttribute('data-testid');
  if (!testid) return null;
  const match = COMPOSER_INDEX_PATTERN.exec(testid);
  return match ? Number(match[1]) : null;
}

/**
 * Every element matching any composer chain level, chain priority preserved. The structural
 * fallback level (a `public-DraftEditor-content` textbox) counts ONLY inside a recognized
 * composer container — an unrelated editor on a composer-less route attracts no watcher, no
 * overlay and no analysis (VAL-DRAFT-029).
 */
export function findComposers(root: ParentNode): Element[] {
  return findAllCandidates(root, 'composer').filter((candidate) => {
    // Primary chain levels carry a real tweetTextarea testid and are trusted on their own; the
    // testid-less structural fallback must additionally sit inside a composer container.
    return getComposerTestidIndex(candidate) !== null || isInsideComposerContainer(candidate);
  });
}

/**
 * Highest-priority active composer: numbered reply composers (tweetTextarea_1+) win over the main
 * composer (a reply dialog is the active typing surface even when the home composer stays behind
 * it), the main composer wins over the structural fallback, and DOM order breaks remaining ties.
 * Returns null when nothing matches (nothing is injected, no error).
 */
export function findComposer(root: ParentNode): Element | null {
  const candidates = findComposers(root);
  let best: { element: Element; group: number; tiebreak: number; order: number } | null = null;
  for (let order = 0; order < candidates.length; order += 1) {
    const element = candidates[order]!;
    const index = getComposerTestidIndex(element);
    // group 0: numbered reply composer · 1: main composer · 2: structural fallback
    const group = index === null ? 2 : index >= 1 ? 0 : 1;
    const tiebreak = index === null ? 0 : -index;
    const better =
      best === null ||
      group < best.group ||
      (group === best.group && tiebreak < best.tiebreak) ||
      (group === best.group && tiebreak === best.tiebreak && order < best.order);
    if (better) best = { element, group, tiebreak, order };
  }
  return best === null ? null : best.element;
}

/**
 * The region around a composer that may hold its media chips, reply context and follow badge:
 * the parent of its `*RichTextInputContainer` (x.com keeps composer furniture there, timelines
 * outside it). Falls back to the immediate parent for structural-only variants.
 */
export function findComposerRegion(composer: Element): ParentNode {
  const container = composer.closest('[data-testid$="RichTextInputContainer"]');
  return container?.parentElement ?? composer.parentElement ?? composer;
}

/**
 * Bounded climb while looking for the furniture-containing ancestor: the real composer block is
 * a handful of nesting levels above the editor (19 measured live), and the cap keeps a
 * furniture-less page from walking into the document root.
 */
const MAX_FURNITURE_CLIMB = 24;

/**
 * The region overlay PLACEMENT anchors to (m5-overlay-scroll-reach): the lowest ancestor of the
 * composer's extraction region that ALSO contains the composer furniture row (media control,
 * character counter, Post button — `SELECTORS.composerFurniture`).
 *
 * Verified live on logged-in x.com (2026-10-04 survey): the home composer's extraction region is
 * a TIGHT text-row wrapper and the furniture row (`toolBar`) is a SIBLING subtree of the common
 * composer block — anchoring placement to the tight wrapper made the expanded panel cover the
 * Post button, the character counter and the media controls. The climb fixes placement while
 * EXTRACTION keeps its tight region (`findComposerRegion`): media/reply chips must never be read
 * from foreign subtrees the climb adds (a status page's primary post is not composer content).
 *
 * Where the extraction region already contains the furniture (the fixture's home composer, the
 * reply composer containers) this returns it unchanged, and with no furniture anywhere it falls
 * back to the extraction region — placement degrades, never breaks.
 */
export function findComposerAnchorRegion(composer: Element): ParentNode {
  const start = findComposerRegion(composer);
  let region: ParentNode = start;
  for (let levels = 0; levels < MAX_FURNITURE_CLIMB; levels += 1) {
    if (SELECTORS.composerFurniture.some((selector) => region.querySelector(selector) !== null)) return region;
    const parent = region.parentElement;
    if (parent === null) break;
    region = parent;
  }
  return start;
}

/**
 * The handle of the visible reply context ("replying to @x") without the `@`, or undefined.
 * Primary: the registered testid chain. Structural fallback: a profile link whose visible text
 * starts with `@` (the `@` glyph is not localized) — this cannot match timeline profile rows
 * because the search is scoped to the composer region.
 */
export function findReplyToHandle(region: ParentNode): string | undefined {
  for (const selector of SELECTORS.replyToHandle) {
    const chip = region.querySelector(selector);
    if (!chip) continue;
    const link = chip.matches('a[href]') ? chip : chip.querySelector('a[href]');
    const handle = handleFromLink(link) ?? handleFromText(chip.textContent);
    if (handle !== undefined) return handle;
  }
  for (const link of region.querySelectorAll('a[href^="/"][role="link"]')) {
    const handle = handleFromLink(link);
    if (handle !== undefined && (link.textContent ?? '').trim().startsWith('@')) return handle;
  }
  return undefined;
}

function handleFromLink(link: Element | null): string | undefined {
  const href = link?.getAttribute('href');
  const match = href ? /^\/([A-Za-z0-9_]{1,20})$/.exec(href) : null;
  return match ? match[1]! : undefined;
}

function handleFromText(text: string | null | undefined): string | undefined {
  const match = text ? /@([A-Za-z0-9_]{1,20})/.exec(text) : null;
  return match ? match[1]! : undefined;
}

function hasComposerMedia(region: ParentNode): boolean {
  return SELECTORS.composerMedia.some((selector) => region.querySelector(selector) !== null);
}

/**
 * Full composer text: DraftEditor renders one block element per line; join those with newlines.
 * Every line block is newline-separated from what precedes it — including EMPTY blocks, whose
 * newlines are raw characters the user entered (leading, interior and trailing blank lines all
 * count toward charCount: VAL-DRAFT-030, VAL-SETUP-014). The single untouched-placeholder block
 * (one empty block, nothing before it) contributes nothing, so the empty state survives
 * (VAL-DRAFT-005) — but as soon as anything precedes a block, that block joins with its newline.
 */
export function getComposerText(composer: Element): string {
  let text = '';
  // Whether anything was emitted before the current node: a prior line block (EVEN a blank one —
  // the user entered its newline) or a non-blank inline run. A blank line's newline is raw text.
  let sawContent = false;
  for (const node of composer.childNodes) {
    if (node.nodeType === node.TEXT_NODE) {
      // DraftEditor keeps all text inside line blocks; stray whitespace-only top-level nodes are
      // markup formatting, not draft content.
      const value = node.textContent ?? '';
      if (value.trim()) {
        text += value;
        sawContent = true;
      }
      continue;
    }
    if (node.nodeType !== node.ELEMENT_NODE) continue;
    const element = node as Element;
    const inner = element.textContent ?? '';
    if (element.localName === 'div' || element.localName === 'p') {
      text = sawContent ? `${text}\n${inner}` : inner;
      sawContent = true;
      continue;
    }
    text += inner; // inline markup inside the flow: no line break of its own
    if (inner.trim()) sawContent = true;
  }
  return text;
}

/**
 * The composer document's current route pathname (kept fresh by the SPA), or '' when unavailable.
 */
function routePathname(composer: Element): string {
  return composer.ownerDocument?.defaultView?.location?.pathname ?? '';
}

/**
 * Field-for-field DraftSnapshot from the live composer (VAL-DRAFT-030): text, hashtags, urls
 * (t.co-expanded when the markup exposes the destination), hasMedia, reply context (isReply,
 * replyToHandle) and raw charCount + capturedAt.
 *
 * Reply context (M2 scrutiny round 3) comes from the composer's actual context, evaluated at
 * capture time so SPA route changes re-classify:
 * - the status-page ROUTE `/<handle>/status/<id>`: the inline "Post your reply" composer under
 *   the primary post is verified real x.com shape (`tweetTextarea_0`, NO reply chip in its
 *   region — `library/x-dom.md`) and is a reply to that post;
 * - a numbered composer (`tweetTextarea_1+`, the reply dialog) or a visible in-region reply
 *   chip (the dialog/fixture shapes).
 *
 * `replyToHandle` is set ONLY from a verifiable visible source — the in-region chip first (the
 * dialog's reply line is the more specific target on nested replies), else the status route's
 * handle segment; absent when neither is determinable, never guessed.
 *
 * `replyToFollowedByViewer` is NEVER set here: the real reply composer exposes no marker that
 * the viewer follows the reply target (verified read-only x.com inspection 2026-10-03 — see
 * `library/x-dom.md`). Any badge near the reply-to line (socialContext / userFollowIndicator)
 * is at best generic context or the reverse-direction "Follows you", so the field stays absent
 * and the breakdown honestly reads "not visible" (never guessed, architecture.md).
 */
export function extractDraftSnapshot(composer: Element, options: { now?: number } = {}): DraftSnapshot {
  const text = getComposerText(composer);
  const region = findComposerRegion(composer);
  const replyToHandle = findReplyToHandle(region) ?? statusRouteHandle(routePathname(composer));
  const index = getComposerTestidIndex(composer);
  const isReply = (index !== null && index >= 1) || replyToHandle !== undefined;

  const snapshot: DraftSnapshot = {
    text,
    hashtags: parseHashtags(text),
    urls: snapshotUrls(composer, text),
    hasMedia: hasComposerMedia(region),
    isReply,
    charCount: text.length,
    capturedAt: options.now ?? Date.now(),
  };
  if (replyToHandle !== undefined) snapshot.replyToHandle = replyToHandle;
  return snapshot;
}

/**
 * URLs from the draft text with visible t.co expansions applied (architecture contract: snapshot
 * urls are t.co-expanded). A short URL expands when the composer markup exposes its destination —
 * a link chip whose visible text is the short form and whose `data-expanded-url`/`href` carries
 * the destination. Without visible expansion the short form is kept as written.
 */
function snapshotUrls(composer: Element, text: string): string[] {
  const urls: string[] = [];
  for (const url of parseUrls(text)) {
    const expanded = expandedShortUrl(composer, url);
    if (!urls.includes(expanded)) urls.push(expanded);
  }
  return urls;
}

/** The expanded destination for a short URL, or the short form when no expansion is visible. */
function expandedShortUrl(composer: Element, short: string): string {
  for (const link of composer.querySelectorAll('a[href]')) {
    if ((link.textContent ?? '').trim() !== short) continue;
    const candidate = link.getAttribute('data-expanded-url') ?? link.getAttribute('href');
    if (candidate && candidate !== short && /^https?:\/\//i.test(candidate)) return candidate;
  }
  return short;
}
