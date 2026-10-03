/**
 * The ONE place every heuristic weight, band, threshold and pattern lives. No scoring logic may
 * inline its own numbers (AGENTS.md: "Weights/coefficients live in one config module").
 *
 * Grounding: research/x-algorithm/heuristics.md (public xai-org/x-algorithm coefficients).
 * Weights are expressed on the headline scale, where 1 point moves the 0-100 headline by ~1 from
 * the neutral base. Coefficient provenance is noted per weight; values are directional heuristics
 * for a writing assistant, NOT a reproduction of Phoenix's per-viewer predictions.
 */

/** A contiguous character-count band; the first band containing the char count wins. */
export interface LengthBand {
  readonly id: 'ideal' | 'good' | 'short' | 'very-short' | 'overlong';
  readonly label: string;
  readonly min: number;
  /** Inclusive upper bound; use `Number.POSITIVE_INFINITY` for the open-ended band. */
  readonly max: number;
  readonly points: number;
}

/** Hashtag-count band; the first band whose `max` reaches the count wins. */
export interface HashtagBand {
  readonly max: number;
  readonly points: number;
  readonly note: string;
}

/** One detectable copy-link shareable format (architecture: lists, stats, quotable lines, "save this"). */
export interface ShareableFormat {
  readonly id: 'list' | 'stats' | 'quotable' | 'save-this';
  readonly label: string;
  readonly patterns: readonly RegExp[];
}

export const HEURISTIC_CONFIG = {
  /** Headline scale: raw signal points map onto the 0-100 headline from this neutral base. */
  headline: { base: 50, min: 0, max: 100 },

  /** Single-action weights, one per draft signal (headline-scale points). */
  weights: {
    /** x-algorithm favorite coefficient (+0.5): the floor every eligible draft starts from. */
    likeBaseline: 0.5,
    /** x-algorithm share-via-copy-link coefficient (+20.0) — the largest positive discrete action. */
    copyLinkTrigger: 20,
    /** x-algorithm share-via-DM coefficient (+5.0). */
    shareDmTrigger: 5,
    /**
     * Architecture decision: open-link is +0.2 in the public weights, but external links
     * historically reduce reply/share rates, so a draft link is a MINOR negative for engagement.
     * Off-platform destinations ONLY (scrutiny round-1 fix): links to x.com/twitter.com and
     * unexpanded t.co wrappers take no penalty (classification in ./links).
     */
    externalLink: -2,
    /** Media flag: small positive (photo-expand/video-open are +0.05/+0.07; no large media bonus is public). */
    media: 1,
    /**
     * Engagement-bait downrank. The public model has no bait coefficient; the magnitude mirrors the
     * strong negative-feedback coefficients ("not interested" -47.52, mute -58.8). One flat penalty
     * per draft, regardless of how many bait patterns match.
     */
    engagementBait: -50,
    /**
     * Reply drafts replying to an account the VIEWER visibly follows (`replyToFollowedByViewer`:
     * the viewer follows the reply target — never the reverse). Grounded in
     * BidirectionalFollowReplyWeightBoost (+15 added to the reply coefficient); per the validation
     * contract the source's +15 is NOT reused as a literal extension score.
     */
    replyMutualBoost: 5,
  },

  /** Reply-magnet patterns (questions, strong claims) weigh highest: reply +5.0 vs like +0.5 (10x). */
  replyMagnet: {
    /** A question invites predicted replies (the +5.0 reply coefficient). */
    question: 5,
    /** A strong/controversial claim invites quote-replies (same coefficient). */
    strongClaim: 5,
    /** Both together cap here so reply-magnet cannot swamp every other signal. */
    maxPoints: 10,
  },

  /** Length bands; "~100-280 chars primary" per architecture. First match wins. */
  lengthBands: [
    { id: 'ideal', label: 'ideal (100-280 chars)', min: 100, max: 280, points: 3 },
    { id: 'good', label: 'good (70-99 chars)', min: 70, max: 99, points: 1 },
    { id: 'good', label: 'good (281-400 chars)', min: 281, max: 400, points: 1 },
    { id: 'short', label: 'short (40-69 chars)', min: 40, max: 69, points: 0 },
    { id: 'very-short', label: 'very short (under 40 chars)', min: 0, max: 39, points: -1.5 },
    { id: 'overlong', label: 'overlong (over 400 chars)', min: 401, max: Number.POSITIVE_INFINITY, points: -2 },
  ] as readonly LengthBand[],

  /** Hashtag counts: diminishing beyond 2, negative beyond 3 (first band whose max reaches the count wins). */
  hashtagBands: [
    { max: 0, points: 0, note: 'none' },
    { max: 2, points: 2, note: 'optimal (1-2)' },
    { max: 3, points: 0.5, note: 'diminishing (3)' },
    { max: 4, points: -2, note: 'penalized (4)' },
    { max: Number.POSITIVE_INFINITY, points: -4, note: 'penalized (5+)' },
  ] as readonly HashtagBand[],

  /** ALL-CAPS / rage-bait moderation flags (visibility-filtering-inspired penalties). */
  moderation: {
    allCapsPoints: -8,
    excessivePunctuationPoints: -4,
    /** Shouting needs at least this many letters... */
    allCapsMinLetters: 12,
    /** ...of which at least this ratio are uppercase. */
    allCapsRatio: 0.6,
    /** A run of !/? at least this long counts as excessive punctuation. */
    punctuationRunLength: 3,
  },

  /** Detection thresholds that are not themselves weights. */
  detection: {
    /** Line-start bullets needed before a draft counts as a list. */
    minListItems: 2,
  },

  /**
   * Link-classification hosts for the draft link signal (classification in ./links): on-platform
   * destinations take NO external-link penalty, shortener wrappers without a visible expansion
   * stay unknown (destination never guessed). Exact host or subdomain matches — www.x.com and
   * mobile.twitter.com count as on-platform, lookalikes like xcompany.com do not.
   */
  linkHosts: {
    onPlatform: ['x.com', 'twitter.com'],
    shortener: ['t.co'],
  },

  /**
   * Hybrid headline (architecture, VAL-DRAFT-026): round(localWeight*local + jevWeight*(ordinal /
   * ordinalMax * 100)) when a Jev verdict is present; the local headline otherwise.
   */
  hybrid: { localWeight: 0.6, jevWeight: 0.4, ordinalMax: 5 },

  /**
   * Jev band mapping for the ordinal score (0-ordinalMax, may be fractional): the first threshold
   * the ordinal falls below wins; ordinalMax or above maps to the exceptional band.
   */
  jevBands: {
    thresholds: [
      { below: 1.5, band: 'weak' },
      { below: 2.5, band: 'below-average' },
      { below: 3.5, band: 'moderate' },
      { below: 4.5, band: 'strong' },
    ] as readonly { below: number; band: 'weak' | 'below-average' | 'moderate' | 'strong' }[],
    top: 'exceptional' as const,
  },
} as const;

/** Canonical English display labels for the Jev bands (VAL-DRAFT-009 wording). */
export const JEV_BAND_LABELS: Readonly<Record<string, string>> = {
  weak: 'Weak',
  'below-average': 'Below avg',
  moderate: 'Moderate',
  strong: 'Strong',
  exceptional: 'Exceptional',
};

/** Strong/definitive claims that invite quote-replies ("strong claims" in the reply-magnet signal). */
export const STRONG_CLAIM_PATTERNS: readonly RegExp[] = [
  /\b(?:always|never)\b/i,
  /\b(?:everyone|nobody|no one)\b/i,
  /\b(?:best|worst)\b/i,
  /\bmust\b/i,
  /\bunpopular\s+opinion\b/i,
  /\bhot\s+take\b/i,
  /\bthe\s+truth\b/i,
  /\bcontroversial\b/i,
];

/** Patterns marking content people send friends privately (share-to-DM trigger). */
export const DM_SHARE_PATTERNS: readonly RegExp[] = [
  /\bsend\s+(?:this|it)\s+to\b/i,
  /\bshare\s+(?:this|it)\s+with\b/i,
  /\bforward\s+this\b/i,
];

/** Downrank patterns the architecture calls engagement-bait ("like & retweet if", follow-begging). */
export const BAIT_PATTERNS: readonly RegExp[] = [
  /\blike\s+(?:and|&)\s+(?:re)?(?:tweet|post)\b/i,
  /\b(?:rt|repost)\s+if\b/i,
  /\blike\s+if\b/i,
  /\bfollow\s+(?:me|back)\b/i,
  /\btag\s+(?:someone|a friend)\b/i,
  /\bdrop\s+a\s+(?:like|comment|follow)\b/i,
  /\bsmash\s+(?:that|the)\s+(?:like|follow|upvote)\b/i,
  /\bwho\s+else\s+agrees\b/i,
  /\bcomment\s+below\b/i,
];

/** One line-start bullet (`-`, `*`, `•`, or `1.`), for list detection. */
export const LIST_ITEM_PATTERN = /(?:^|\n)[ \t]*(?:[-•*]|\d+[.)])[ \t]+\S/g;

/** The shareable copy-link formats (architecture: lists, stats, quotable lines, "save this" utility). */
export const SHAREABLE_FORMATS: readonly ShareableFormat[] = [
  {
    id: 'stats',
    label: 'stats',
    patterns: [/\b\d+(?:[.,]\d+)?\s?%/, /\b\d+\s?[x×]\b/i, /\$\s?\d+/, /\b\d{3,}\b/],
  },
  {
    id: 'quotable',
    label: 'quotable line',
    patterns: [
      /\bthe\s+key\s+(?:to|is)\b/i,
      /\bthe\s+secret\b/i,
      /\blesson\s*:/i,
      /\bhard\s+truth\b/i,
      /\breminder\s*:/i,
      /\bpsa\s*:/i,
      /\bpro\s+tip\b/i,
      /\blife\s+hack\b/i,
      /\btil\b/i,
    ],
  },
  {
    id: 'save-this',
    label: 'save-this utility',
    patterns: [/\bsave\s+(?:this|it)\b/i, /\bbookmark\s+(?:this|it)\b/i, /\bkeep\s+this\b/i],
  },
];
