/**
 * DOM-side DraftSnapshot extraction. Reads ONLY structure (data-testid / role / contenteditable
 * plus composer-scoped regions) — never localized label text. Every selector comes from
 * `src/selectors.ts`.
 */
import { parseHashtags, parseUrls, type DraftSnapshot } from '@/core/draft-snapshot';
import { SELECTORS, findAllCandidates } from '@/selectors';

const COMPOSER_INDEX_PATTERN = /tweetTextarea_(\d+)$/;

/** Numbered-composer index of a `tweetTextarea_N` testid; null for the structural fallback. */
export function getComposerTestidIndex(composer: Element): number | null {
  const testid = composer.getAttribute('data-testid');
  if (!testid) return null;
  const match = COMPOSER_INDEX_PATTERN.exec(testid);
  return match ? Number(match[1]) : null;
}

/** Every element matching any composer chain level, chain priority preserved. */
export function findComposers(root: ParentNode): Element[] {
  return findAllCandidates(root, 'composer');
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

/** True only when a follow-state badge is VISIBLE in the composer region; never inferred. */
export function hasVisibleFollowIndicator(region: ParentNode): boolean {
  return SELECTORS.followIndicator.some((selector) => region.querySelector(selector) !== null);
}

function hasComposerMedia(region: ParentNode): boolean {
  return SELECTORS.composerMedia.some((selector) => region.querySelector(selector) !== null);
}

/** Full composer text: DraftEditor renders one block element per line; join those with newlines. */
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
    const inner = node.textContent ?? '';
    if (!inner) continue;
    const startsBlock = (node as Element).localName === 'div' || (node as Element).localName === 'p';
    text = text && startsBlock ? `${text}\n${inner}` : text + inner;
  }
  return text;
}

/**
 * Field-for-field DraftSnapshot from the live composer (VAL-DRAFT-030): text, hashtags, urls,
 * hasMedia, reply context (isReply, replyToHandle, replyToFollowedByViewer ONLY when visible),
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
    urls: parseUrls(text),
    hasMedia: hasComposerMedia(region),
    isReply,
    charCount: text.length,
    capturedAt: options.now ?? Date.now(),
  };
  if (replyToHandle !== undefined) snapshot.replyToHandle = replyToHandle;
  if (isReply && hasVisibleFollowIndicator(region)) snapshot.replyToFollowedByViewer = true;
  return snapshot;
}
