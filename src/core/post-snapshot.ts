/**
 * PostSnapshot — the timeline extraction contract every reply-target consumer depends on
 * (architecture.md, "DraftSnapshot / PostSnapshot (extraction contracts)"). Pure module: DOM
 * extraction lives in `src/dom/timeline-scanner/extract.ts`; this file holds the shared shape,
 * the pure parsers and the change-detection signature behind the rescoring policy.
 *
 * The field set IS the contract (VAL-TARGET-025): extraction matches it field-for-field, and
 * absent-when-unknown optional fields are omitted, never guessed.
 */

export interface PostSnapshot {
  /** The status id, taken from the post's own status URL. */
  id: string;
  text: string;
  authorHandle: string;
  /** The author carries the verified badge (`icon-verified`). Small positive modifier, never dominant. */
  verified: boolean;
  hasMedia: boolean;
  /** The article visibly sits in a reply thread ("replying to" context). */
  isReply: boolean;
  /**
   * The viewer follows the author, from a DOM indicator ONLY — never guessed. Real x.com exposes
   * NO viewer-follows-author marker in timeline articles (verified read-only inspection,
   * `library/x-dom.md`), so on the real site this extracts false (honest absence); the fixture
   * contract renders a `viewerFollowsAuthor` marker to exercise the extraction path.
   */
  inNetwork: boolean;
  /** Handle being replied to, without the `@` — only when a visible reply chip names it. */
  replyToHandle?: string;
  /** Whole minutes between `time[datetime]` and the capture, clamped at 0 (clock skew). */
  ageMinutes: number;
  /** Engagement counts parsed DIGITS-ONLY from localized button labels — absent when unshown. */
  likeCount?: number;
  replyCount?: number;
  repostCount?: number;
  url: string;
}

/** The handle + status id of a canonical `/<handle>/status/<id>` path. */
export interface StatusRouteTarget {
  handle: string;
  id: string;
}

/**
 * X top-level paths that can never be a handle (same reserved set as the draft status-route
 * rule — e.g. the legacy `/i/status/<id>` redirect root).
 */
const RESERVED_ROUTE_ROOTS = new Set(['i', 'intent']);

const STATUS_PATH_PATTERN = /^\/([A-Za-z0-9_]{1,20})\/status\/(\d+)$/;

/**
 * The handle + status id of a status URL (absolute or relative; only the PATH matters). Anything
 * else — non-status paths, reserved roots, malformed ids — yields null, never a guess.
 */
export function parseStatusLink(href: string | undefined | null, base: string = 'https://x.com'): StatusRouteTarget | null {
  if (!href) return null;
  let pathname: string;
  try {
    pathname = new URL(href, base).pathname;
  } catch {
    return null;
  }
  const match = STATUS_PATH_PATTERN.exec(pathname);
  if (!match) return null;
  const handle = match[1]!;
  if (RESERVED_ROUTE_ROOTS.has(handle.toLowerCase())) return null;
  return { handle, id: match[2]! };
}

/**
 * Whole minutes between an ISO `datetime` attribute and `now`, rounded to the nearest minute and
 * clamped at 0 (a future timestamp is clock skew, not negative age). Unparseable datetimes yield
 * undefined — the caller skips the article rather than guess an age.
 */
export function postAgeMinutes(datetime: string | undefined | null, now: number): number | undefined {
  if (!datetime) return undefined;
  const parsed = Date.parse(datetime);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.round((now - parsed) / 60_000));
}

/**
 * Compact-count magnitude suffixes. This is NUMBER-FORMATTING vocabulary, not metric
 * identification: which count a button holds always comes from its `data-testid`, and the count
 * VALUE always comes from the digits. The suffix only rescales the digits the way x.com's compact
 * labels do ("1,2 mil", "12K"), so a magnitude table over the observed short suffixes is not
 * label-word matching.
 */
const COUNT_MAGNITUDES: Readonly<Record<string, number>> = {
  k: 1e3,
  mil: 1e3,
  m: 1e6,
  mi: 1e6,
  b: 1e9,
  bi: 1e9,
  bn: 1e9,
};

/** First digits run with an optional trailing magnitude word: "1,2 mil", "1.234", "12K", "310". */
const COUNT_TOKEN_PATTERN = /(\d[\d.,]*)\s*([a-zA-Z]{1,4})?/;

/**
 * Digits-only count parsing from a localized label (VAL-TARGET-001): the value comes from the
 * digit characters — separators are structural (a separator followed by exactly three digits is
 * a thousands group, a separator followed by one or two is a decimal point) — and an optional
 * compact-magnitude suffix rescales them. Label WORDS are never anchors: a count is parsed
 * identically no matter which localized words surround it.
 */
export function parseLocalizedCount(text: string): number | undefined {
  const match = COUNT_TOKEN_PATTERN.exec(text);
  if (!match) return undefined;
  const value = numberFromToken(match[1]!) * (match[2] ? COUNT_MAGNITUDES[match[2]!.toLowerCase()] ?? 1 : 1);
  return Number.isFinite(value) ? Math.round(value) : undefined;
}

/** Digits + separator structure of one numeric token ("1,2" → 1.2, "1.234" → 1234). */
function numberFromToken(token: string): number {
  const trimmed = token.replace(/[.,]+$/, '');
  const decimal = /([.,])(\d{1,2})$/.exec(trimmed);
  const integer = (decimal ? trimmed.slice(0, decimal.index) : trimmed).replace(/[.,]/g, '');
  if (!/^\d+$/.test(integer)) return Number.NaN;
  return Number(decimal ? `${integer}.${decimal[2]}` : integer);
}

/**
 * Change signature over the CAPTURED METRICS for the scanner's rescoring policy: equal
 * signatures mean "same id, unchanged captured metrics" (no rescore); any metric change flips
 * the signature (rescore). The id is the map key, not part of the signature.
 */
export function postMetricsSignature(post: PostSnapshot): string {
  return JSON.stringify([
    post.text,
    post.authorHandle,
    post.verified,
    post.hasMedia,
    post.isReply,
    post.inNetwork,
    post.replyToHandle ?? null,
    post.ageMinutes,
    post.replyCount ?? null,
    post.repostCount ?? null,
    post.likeCount ?? null,
    post.url,
  ]);
}

/**
 * Runtime guard for snapshots crossing the message boundary: the scanner's extraction is
 * trusted, but a message payload is untrusted input. Optional fields must be absent-or-typed,
 * never wrong-typed.
 */
export function isPostSnapshot(value: unknown): value is PostSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    c.id !== '' &&
    typeof c.text === 'string' &&
    typeof c.authorHandle === 'string' &&
    typeof c.verified === 'boolean' &&
    typeof c.hasMedia === 'boolean' &&
    typeof c.isReply === 'boolean' &&
    typeof c.inNetwork === 'boolean' &&
    typeof c.ageMinutes === 'number' &&
    Number.isFinite(c.ageMinutes) &&
    c.ageMinutes >= 0 &&
    typeof c.url === 'string' &&
    (c.replyToHandle === undefined || typeof c.replyToHandle === 'string') &&
    isOptionalCount(c.likeCount) &&
    isOptionalCount(c.replyCount) &&
    isOptionalCount(c.repostCount)
  );
}

function isOptionalCount(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}
