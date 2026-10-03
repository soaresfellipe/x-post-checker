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
