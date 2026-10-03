/**
 * DOM-side DraftSnapshot extraction. Reads ONLY structure (data-testid / role / contenteditable
 * plus composer-scoped regions) — never localized label text. Every selector comes from
 * `src/selectors.ts`.
 */
import { parseHashtags, parseUrls, type DraftSnapshot } from '@/core/draft-snapshot';
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

/**
 * True only when a follow-state badge is VISIBLE on screen and BOUND to the reply target:
 * - visible: neither the badge nor an ancestor is hidden (`hidden` attribute, display:none,
 *   visibility:hidden) — a hidden badge proves nothing the viewer can see;
 * - bound: the badge sits with the visible reply-to line for `handle` (inside the line's own
 *   block, or beside it under the same parent) — a social-context badge nested elsewhere in the
 *   composer region says nothing about THIS reply target.
 * The badge text is localized, so only structure and visibility are read. Association with the
 * reply-to line is positional; real-x follow-badge semantics stay unverified, so the badge is
 * never documented as a general marker.
 */
export function hasVisibleFollowIndicatorForReplyTarget(region: ParentNode, handle: string | undefined): boolean {
  if (!handle) return false; // no visible reply target to bind a badge to: never guess
  const anchors = replyTargetAnchors(region, handle);
  if (anchors.length === 0) return false;
  for (const selector of SELECTORS.followIndicator) {
    for (const badge of region.querySelectorAll(selector)) {
      if (!isVisible(badge)) continue;
      if (!bindsToReplyTarget(badge, anchors)) continue;
      return true;
    }
  }
  return false;
}

/** Elements in the region that visibly reference the reply target handle. */
function replyTargetAnchors(region: ParentNode, handle: string): Element[] {
  const anchors: Element[] = [];
  for (const selector of SELECTORS.replyToHandle) {
    for (const chip of region.querySelectorAll(selector)) {
      const link = chip.matches('a[href]') ? chip : chip.querySelector('a[href]');
      if (handleFromLink(link) === handle || handleFromText(chip.textContent) === handle) anchors.push(chip);
    }
  }
  for (const link of region.querySelectorAll('a[href^="/"][role="link"]')) {
    if (handleFromLink(link) === handle && (link.textContent ?? '').trim().startsWith('@')) anchors.push(link);
  }
  return anchors;
}

/** The badge rides with the reply-to line: inside its block, or a sibling under the same parent. */
function bindsToReplyTarget(badge: Element, anchors: Element[]): boolean {
  for (const anchor of anchors) {
    const line = anchor.parentElement;
    if (!line) continue;
    if (line.contains(badge)) return true;
    if (badge.parentElement === line.parentElement) return true;
  }
  return false;
}

/** Rendered on screen: no `hidden` attribute and no display:none / visibility:hidden ancestor. */
function isVisible(element: Element): boolean {
  let node: Element | null = element;
  while (node !== null) {
    if (node.hasAttribute('hidden')) return false;
    const win: Window | null = node.ownerDocument?.defaultView ?? null;
    const style = win?.getComputedStyle(node);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    node = node.parentElement;
  }
  return true;
}

function hasComposerMedia(region: ParentNode): boolean {
  return SELECTORS.composerMedia.some((selector) => region.querySelector(selector) !== null);
}

/**
 * Full composer text: DraftEditor renders one block element per line; join those with newlines.
 * Empty line blocks are REAL lines — a `<div><br></div>` block contributes the newline that
 * separates it, so blank lines count toward the raw charCount (VAL-DRAFT-030, VAL-SETUP-014).
 * Leading empty blocks are the untouched-composer placeholder shape and stay zero chars, so the
 * empty state survives (VAL-DRAFT-005).
 */
export function getComposerText(composer: Element): string {
  let text = '';
  for (const node of composer.childNodes) {
    if (node.nodeType === node.TEXT_NODE) {
      // DraftEditor keeps all text inside line blocks; stray whitespace-only top-level nodes are
      // markup formatting, not draft content.
      const value = node.textContent ?? '';
      if (value.trim()) text += value;
      continue;
    }
    if (node.nodeType !== node.ELEMENT_NODE) continue;
    const element = node as Element;
    const inner = element.textContent ?? '';
    if (element.localName === 'div' || element.localName === 'p') {
      // Line block: newline-separate it from prior content; an empty block keeps its separator
      // (the blank line's raw newline) unless no content precedes it (placeholder shape).
      text = text ? `${text}\n${inner}` : inner;
      continue;
    }
    text += inner; // inline markup inside the flow: no line break of its own
  }
  return text;
}

/**
 * Field-for-field DraftSnapshot from the live composer (VAL-DRAFT-030): text, hashtags, urls
 * (t.co-expanded when the markup exposes the destination), hasMedia, reply context (isReply,
 * replyToHandle, replyToFollowedByViewer ONLY with a visible, target-specific follow badge),
 * raw charCount and capturedAt.
 */
export function extractDraftSnapshot(composer: Element, options: { now?: number } = {}): DraftSnapshot {
  const text = getComposerText(composer);
  const region = findComposerRegion(composer);
  const replyToHandle = findReplyToHandle(region);
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
  if (replyToHandle !== undefined && hasVisibleFollowIndicatorForReplyTarget(region, replyToHandle)) {
    snapshot.replyToFollowedByViewer = true;
  }
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
