/**
 * Central registry of every x.com selector the extension relies on.
 *
 * x.com renders localized aria-labels, so chains only use `data-testid`, `role` and
 * `contenteditable` plus structural fallbacks, never label text. Each chain is ordered from most
 * to least specific; callers take the first selector that matches.
 */
export const SELECTORS = {
  composer: [
    'div[data-testid="tweetTextarea_0"][role="textbox"][contenteditable="true"]',
    'div[data-testid^="tweetTextarea_"][role="textbox"][contenteditable="true"]',
    'div.public-DraftEditor-content[role="textbox"][contenteditable="true"]',
  ],
  /**
   * Recognized composer CONTAINERS (the real composer structure: the toolbar region wrapping the
   * `tweetTextarea_*RichTextInputContainer`). Only an editor inside one of these may match the
   * composer chain's STRUCTURAL fallback — an unrelated DraftEditor elsewhere on the page (e.g. a
   * search box on a composer-less route) must attract no watcher, overlay or analysis
   * (VAL-DRAFT-029).
   */
  composerContainer: ['[data-testid$="RichTextInputContainer"]', '[data-testid="toolBar"]'],
  /**
   * The composer FURNITURE row (media control, character counter, Post button) and the Post
   * button itself — PLACEMENT anchors only, never extraction scope. Real x.com (verified live
   * 2026-10-04, m5-overlay-scroll-reach survey) nests the editor in a tight text-row wrapper and
   * keeps the furniture row (`toolBar`) in a SIBLING subtree of the common composer block, so
   * overlay placement must anchor to a region that CONTAINS one of these (the expanded panel
   * anchors below it; the collapsed pill keeps clear of the Post button).
   */
  composerFurniture: ['[data-testid="toolBar"]', '[data-testid="tweetButtonInline"]', '[data-testid="tweetButton"]'],
  composerPostButton: ['[data-testid="tweetButtonInline"]', '[data-testid="tweetButton"]'],
  /** Media chips attached to a composer; always queried scoped to the composer region. */
  composerMedia: [
    '[data-testid="attachments"] [data-testid="tweetPhoto"]',
    '[data-testid="attachments"] [data-testid="videoPlayer"]',
    '[data-testid="attachments"] img',
    '[data-testid="tweetPhoto"]',
    '[data-testid="videoPlayer"]',
  ],
  /** Primary "replying to" handle chip in a composer region (structural fallback is scan-based). */
  replyToHandle: ['[data-testid="replyToHandle"]'],
  // NOTE: no follow-state selector is registered. The real reply composer exposes NO marker that
  // the viewer follows the reply target (verified read-only inspection 2026-10-03, see
  // library/x-dom.md); `socialContext` is generic context and `userFollowIndicator` means the
  // REVERSE ("Follows you"). A future verified marker gets its own entry with that proof.
  article: ['article[data-testid="tweet"]', 'article[role="article"]'],
  tweetText: ['[data-testid="tweetText"]'],
  userName: ['[data-testid="User-Name"]'],
  verifiedIcon: ['[data-testid="icon-verified"]'],
  timestamp: ['time[datetime]'],
  /** Media attached to a timeline post (article-scoped queries only). */
  postMedia: ['[data-testid="tweetPhoto"]', '[data-testid="videoPlayer"]'],
  /**
   * Timeline-article viewer-follows-author marker — the `inNetwork` extraction source. Real x.com
   * exposes NO viewer-follows-author marker in timeline articles (verified read-only inspection
   * 2026-10-03: the real Following feed had zero `socialContext`/`userFollowIndicator` nodes at
   * scan time — `library/x-dom.md`), so on the real site this chain matches nothing and
   * `inNetwork` extracts false — honest absence, never guessed. `socialContext` is deliberately
   * NOT used: on real x.com it is a generic context slot ("X liked"), and `userFollowIndicator`
   * means the REVERSE ("Follows you"). The fixture renders this marker (fixture contract) on
   * articles of authors the viewer follows; a future REAL marker gets registered here only with
   * the same evidence standard.
   */
  viewerFollowsAuthor: ['[data-testid="viewerFollowsAuthor"]'],
  replyButton: ['[data-testid="reply"]'],
  retweetButton: ['[data-testid="retweet"]'],
  likeButton: ['[data-testid="like"]'],
  bookmarkButton: ['[data-testid="bookmark"]'],
  statusLink: ['a[href*="/status/"]'],
  /** The visible count inside an engagement button (real x.com testid). */
  buttonCount: ['[data-testid="app-text-transition-container"]'],
} as const satisfies Record<string, readonly string[]>;

export type SelectorKey = keyof typeof SELECTORS;

/** First element matched by the highest-priority selector in the chain that matches anything. */
export function findFirst(root: ParentNode, key: SelectorKey): Element | null {
  for (const selector of SELECTORS[key]) {
    const match = root.querySelector(selector);
    if (match) return match;
  }
  return null;
}

/** All elements matched by the highest-priority selector in the chain that matches anything. */
export function findAll(root: ParentNode, key: SelectorKey): Element[] {
  for (const selector of SELECTORS[key]) {
    const matches = root.querySelectorAll(selector);
    if (matches.length > 0) return [...matches];
  }
  return [];
}

/**
 * True when the element sits INSIDE a recognized composer container (`RichTextInputContainer` /
 * `toolBar`). Gates the composer chain's structural fallback (VAL-DRAFT-029).
 */
export function isInsideComposerContainer(element: Element): boolean {
  return SELECTORS.composerContainer.some((selector) => element.closest(selector) !== null);
}

/**
 * Candidates across ALL chain levels (deduped, highest-priority level first): detection that must
 * rank alternatives (e.g. main vs. numbered reply composer) rather than take the first match.
 */
export function findAllCandidates(root: ParentNode, key: SelectorKey): Element[] {
  const seen = new Set<Element>();
  const candidates: Element[] = [];
  for (const selector of SELECTORS[key]) {
    for (const match of root.querySelectorAll(selector)) {
      if (seen.has(match)) continue;
      seen.add(match);
      candidates.push(match);
    }
  }
  return candidates;
}
