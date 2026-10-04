/**
 * The one place every ScoreOverlay UI constant and English string lives: host identity, pill and
 * panel metrics, placement margins and ALL user-facing copy (the mission's English-only
 * requirement makes a single copy table the audit surface — VAL-CROSS-016).
 */

/** Light-DOM host identity: appended to document.body, exactly like the marker. */
export const OVERLAY_HOST_ID = 'amplifyx-overlay-host';

/** Shadow-DOM panel test id (plus the data-testid of every sub-element, for tests and E2E). */
export const OVERLAY_TESTID = 'amplifyx-overlay';

/** The collapsed pill's test id: the ONLY surface that exists while the user types. */
export const OVERLAY_PILL_TESTID = 'amplifyx-overlay-pill';

export const OVERLAY_TESTIDS = {
  panel: OVERLAY_TESTID,
  pill: OVERLAY_PILL_TESTID,
  empty: 'overlay-empty',
  /** The explicit AI-analysis action inside the expanded panel (autoAnalyze off). */
  analyze: 'overlay-analyze',
  gauge: 'overlay-gauge',
  headline: 'overlay-headline',
  signals: 'overlay-signals',
  jev: 'overlay-jev',
  jevPending: 'overlay-jev-pending',
  jevBand: 'overlay-jev-band',
  jevConfidence: 'overlay-jev-confidence',
  jevWeaknesses: 'overlay-jev-weaknesses',
  jevSuggestions: 'overlay-jev-suggestions',
  jevNotice: 'overlay-jev-notice',
  connectJev: 'overlay-connect-jev',
  /** Which AI judgment state the pill is currently advertising (pending/verdict/no-key/off/error). */
  pillJevState: 'overlay-pill-jev-state',
  optimizer: 'overlay-optimizer',
  optimize: 'overlay-optimize',
  optimizerNotice: 'overlay-optimizer-notice',
  optimizerPending: 'overlay-optimizer-pending',
  optimizerVariants: 'overlay-optimizer-variants',
  optimizerVariant: 'overlay-optimizer-variant',
  optimizerVariantText: 'overlay-optimizer-variant-text',
  optimizerVariantChars: 'overlay-optimizer-variant-chars',
  optimizerCopy: 'overlay-optimizer-copy',
  optimizerHashtags: 'overlay-optimizer-hashtags',
  optimizerHashtag: 'overlay-optimizer-hashtag',
  optimizerDropAdvice: 'overlay-optimizer-drop-advice',
  optimizerConnect: 'overlay-optimizer-connect',
} as const;

/** Placement metrics (px): the gap below the composer region and the viewport clamp margin. */
export const OVERLAY_PLACEMENT = Object.freeze({
  gap: 8,
  viewportMargin: 8,
  /**
   * The collapsed pill's bottom-right offset INSIDE the composer region (px). Keeping the pill
   * inside the region — the composer furniture row holding the character counter, the media
   * controls and the Post button — is what structurally guarantees VAL-DRAFT-033: the pill can
   * never overlap the text area (it sits in the furniture row's own band) and it deliberately
   * stops short of the Post button's own box, which is the rightmost control in that row.
   */
  pillInsetRight: 44,
  pillInsetBottom: 6,
  /** The pill's compact footprint, used for measurement fallback where no layout engine runs. */
  pillWidth: 44,
  pillHeight: 22,
  /** Measurement fallbacks for engines without layout (happy-dom): the panel's design size. */
  fallbackWidth: 340,
  fallbackHeight: 240,
  /** Approximate px per wheel LINE unit (Firefox line-mode deltas) for capped-panel scrolling. */
  wheelLineHeight: 19,
});

/** Headline color tiers for the gauge number (display only; scoring lives in the engine config). */
export const OVERLAY_HEADLINE_TIERS = Object.freeze({
  good: 70,
  ok: 40,
});

/** Optimizer UI timing (ms): how long a copy button shows "Copied" before reverting. */
export const OPTIMIZER_COPY_RESET_MS = 1500;

/** Every string the overlay renders. English only — no i18n layer (single-language product). */
export const OVERLAY_COPY = Object.freeze({
  panelTitle: 'AmplifyX',
  panelSubtitle: 'Draft analysis',
  /**
   * The collapsed pill's copy. The VISIBLE label is the headline number ALONE (VAL-DRAFT-032):
   * the accessible name lives in `pillLabel` so screen readers get the full sentence while the
   * surface itself shows nothing but the score.
   */
  pillLabel: 'AmplifyX viral potential score: {n} out of 100. Activate for the full draft analysis.',
  empty: 'Type a post to see its viral-potential score.',
  emptyMinHint: 'Drafts need at least {n} characters to analyze.',
  /**
   * The AI-judgment half's "nothing is running" copy (autoAnalyze off, jevForDrafts on). It
   * explains that the pill's local score is real and complete while the network half waits for
   * the explicit action — never that AI already ran.
   */
  ready: 'Local score ready. AI judgment runs only when you ask for it.',
  analyzeButton: 'Analyze with AI',
  gaugeLabel: 'Viral potential',
  hybridNote: 'Algorithm signals + AI judgment',
  localNote: 'Algorithm signals only',
  signalsHeading: 'Algorithm signals',
  jevHeading: 'AI judgment',
  pending: 'Analyzing with AI…',
  noKey: 'Local signals only. Connect Jev to add AI judgment.',
  connectJev: 'Connect Jev',
  off: 'Local signals only. AI analysis is off in Settings.',
  error: 'AI judgment unavailable - local signals still apply.',
  confidenceLabel: 'Confidence',
  weaknessHeading: 'Main weakness',
  suggestionsHeading: 'Suggestions',
  optimizerHeading: 'Optimizer',
  optimizeButton: 'Optimize',
  optimizerPending: 'Finding stronger hooks…',
  optimizerOff: 'AI optimization is off in Settings.',
  optimizerNoKey: 'Connect Jev in Options to get AI hook variants.',
  optimizerError: 'Optimization failed - your draft and local score are untouched.',
  copyButton: 'Copy',
  copiedLabel: 'Copied',
  charNote: '{n} characters (X-weighted)',
  overLimitFlag: 'Over the 280-character limit ({n} weighted) - trim before posting.',
  hashtagHeading: 'Hashtag suggestions',
  noHashtags: 'No hashtag suggestions for this draft.',
  errorReasons: Object.freeze({
    network: 'Could not reach the AI service.',
    http: (status: number) => `The AI service returned an error (HTTP ${status}).`,
    malformed: 'The AI service returned an unreadable response.',
    rateLimited: 'AI analysis is rate-limited right now - try again shortly.',
    /** The analyze-draft message itself failed (background unreachable), not the Jev call. */
    transport: 'The analysis service did not respond. Try analyzing again.',
  }),
});
