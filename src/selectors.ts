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
  replyButton: ['[data-testid="reply"]'],
  retweetButton: ['[data-testid="retweet"]'],
  likeButton: ['[data-testid="like"]'],
  bookmarkButton: ['[data-testid="bookmark"]'],
  statusLink: ['a[href*="/status/"]'],
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
