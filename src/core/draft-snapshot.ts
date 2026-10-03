/**
 * DraftSnapshot — the extraction contract every analysis consumer depends on (architecture.md,
 * "DraftSnapshot / PostSnapshot (extraction contracts)"). Pure module: DOM extraction lives in
 * `src/dom/composer-watcher/extract.ts`; this file holds the shared shape, the pure text parsers
 * and the eligibility gate.
 */

export interface DraftSnapshot {
  /** Full composer text, line blocks joined with newlines. */
  text: string;
  /** Hashtag words without the leading `#`, in order of appearance. */
  hashtags: string[];
  /**
   * URLs from the draft text, t.co-EXPANDED when the composer markup exposes the destination
   * (link chip href / data); the short form is kept only when no expansion is visible. `text`
   * still holds the URL exactly as typed.
   */
  urls: string[];
  /** The composer shows a media chip (photo/video attachment). */
  hasMedia: boolean;
  /** The draft is a reply (numbered composer or visible reply context). */
  isReply: boolean;
  /** Handle being replied to, without the `@`. Only present when visible in the DOM. */
  replyToHandle?: string;
  /**
   * Follow state between the viewer and `replyToHandle` — NEVER set by composer extraction: the
   * real reply composer exposes no marker that the viewer follows the reply target (verified
   * read-only x.com inspection 2026-10-03; `library/x-dom.md`). The field stays in the contract
   * for the pure scoring engine (VAL-DRAFT-028) and possible future verified sources; absent
   * means unknown, never guessed.
   */
  replyToFollowedByViewer?: boolean;
  /** Raw character count of `text` (no X-style URL/CJK weighting — the contract is raw). */
  charCount: number;
  /** Epoch milliseconds when the snapshot was captured. */
  capturedAt: number;
}

/** What set off an analysis: the debounced typing path or the overlay's explicit "Analyze" action. */
export type AnalysisTrigger = 'auto' | 'manual';

/**
 * Analysis cadence after the last keystroke/paste/composition-end (~700ms per architecture).
 * Shared contract value: the watcher debounces by it, so tests and the overlay can rely on it.
 */
export const DRAFT_DEBOUNCE_MS = 700;

/**
 * `#` not preceded by another word character or `#` (so URL fragments like `page#section` are
 * out, while `(#tag)` counts — x.com accepts punctuation-adjacent tags); word characters incl.
 * unicode letters/digits.
 */
const HASHTAG_PATTERN = /(^|[^\p{L}\p{N}_#])#([\p{L}\p{N}_]+)/gu;

/** `https?://` or `www.` up to the first whitespace or angle/quote. */
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

/** Trailing punctuation that belongs to the sentence, not the URL. */
const URL_TRAILING_PUNCTUATION = /[.,;:!?"'»›)\]}]+$/;

export function parseHashtags(text: string): string[] {
  const tags: string[] = [];
  for (const match of text.matchAll(HASHTAG_PATTERN)) tags.push(match[2]!);
  return tags;
}

export function parseUrls(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(URL_TRAILING_PUNCTUATION, '');
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

/**
 * The minDraftLength gate: raw char count, so `N - 1` chars stay below and `N` chars qualify.
 * Runs on BOTH analysis paths (automatic debounce and the explicit "Analyze" action).
 */
export function isDraftEligible(snapshot: Pick<DraftSnapshot, 'charCount'>, minDraftLength: number): boolean {
  return snapshot.charCount >= minDraftLength;
}

/**
 * Runtime guard for snapshots crossing the message boundary (`analyze-draft`): the shape the
 * watcher extracts is trusted, but a message payload is untrusted input. Optional fields must be
 * absent-or-typed, never wrong-typed.
 */
export function isDraftSnapshot(value: unknown): value is DraftSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.text === 'string' &&
    Array.isArray(candidate.hashtags) &&
    candidate.hashtags.every((tag) => typeof tag === 'string') &&
    Array.isArray(candidate.urls) &&
    candidate.urls.every((url) => typeof url === 'string') &&
    typeof candidate.hasMedia === 'boolean' &&
    typeof candidate.isReply === 'boolean' &&
    typeof candidate.charCount === 'number' &&
    Number.isFinite(candidate.charCount) &&
    typeof candidate.capturedAt === 'number' &&
    Number.isFinite(candidate.capturedAt) &&
    (candidate.replyToHandle === undefined || typeof candidate.replyToHandle === 'string') &&
    (candidate.replyToFollowedByViewer === undefined || typeof candidate.replyToFollowedByViewer === 'boolean')
  );
}
