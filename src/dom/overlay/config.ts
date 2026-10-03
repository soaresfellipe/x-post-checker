/**
 * The one place every ScoreOverlay UI constant and English string lives: host identity, panel
 * metrics, placement margins and ALL user-facing copy (the mission's English-only requirement
 * makes a single copy table the audit surface — VAL-CROSS-016).
 */

/** Light-DOM host identity: appended to document.body, exactly like the marker. */
export const OVERLAY_HOST_ID = 'amplifyx-overlay-host';

/** Shadow-DOM panel test id (plus the data-testid of every sub-element, for tests and E2E). */
export const OVERLAY_TESTID = 'amplifyx-overlay';

export const OVERLAY_TESTIDS = {
  panel: OVERLAY_TESTID,
  empty: 'overlay-empty',
  ready: 'overlay-ready',
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
} as const;

/** Placement metrics (px): the gap below the composer region and the viewport clamp margin. */
export const OVERLAY_PLACEMENT = Object.freeze({
  gap: 8,
  viewportMargin: 8,
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

/** Every string the overlay renders. English only — no i18n layer (single-language product). */
export const OVERLAY_COPY = Object.freeze({
  panelTitle: 'AmplifyX',
  panelSubtitle: 'Draft analysis',
  empty: 'Type a post to see its viral-potential score.',
  emptyMinHint: 'Drafts need at least {n} characters to analyze.',
  ready: 'Your draft is ready to analyze.',
  analyzeButton: 'Analyze',
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
  errorReasons: Object.freeze({
    network: 'Could not reach the AI service.',
    http: (status: number) => `The AI service returned an error (HTTP ${status}).`,
    malformed: 'The AI service returned an unreadable response.',
    rateLimited: 'AI analysis is rate-limited right now - try again shortly.',
    /** The analyze-draft message itself failed (background unreachable), not the Jev call. */
    transport: 'The analysis service did not respond. Try analyzing again.',
  }),
});
