/**
 * The one place every ScoreOverlay UI constant and English string lives: host identity, the
 * status row and expanded-block geometry, and ALL user-facing copy (the mission's English-only
 * requirement makes a single copy table the audit surface — VAL-CROSS-016). The copy is VERBATIM
 * from the Design 1b spec (`library/design-1b.md` §3/§4/§5/§6, user-approved 2026-10-05).
 */
import type { JevBand } from '@/core/heuristic-engine';

/** Light-DOM host identity: inserted before the composer's toolBar (fallback: document.body). */
export const OVERLAY_HOST_ID = 'amplifyx-overlay-host';

/** Shadow-DOM expanded-block test id (plus the data-testid of every sub-element, for tests). */
export const OVERLAY_TESTID = 'amplifyx-overlay';

/** The collapsed status row's test id: the ONLY surface that exists while the user types (M6). */
export const OVERLAY_ROW_TESTID = 'amplifyx-overlay-row';

export const OVERLAY_TESTIDS = {
  panel: OVERLAY_TESTID,
  row: OVERLAY_ROW_TESTID,
  /** The row's headline number (the hybrid value only when an AI verdict is displayed). */
  headline: 'overlay-headline',
  /** The row's up-to-2-signal summary (ellipsis-truncated). */
  summary: 'overlay-summary',
  /** The row's AI-state dot + short label. */
  aiState: 'overlay-ai-state',
  /** The expanded block's signal-chips group (with the "N neutral ›" toggle). */
  signals: 'overlay-signals',
  /** One signal chip (points ≠ 0, signed points). */
  chip: 'overlay-chip',
  /** The "N neutral ›" toggle chip. */
  neutralToggle: 'overlay-neutral-toggle',
  /** The full rows list (label / value / points) the toggle reveals. */
  signalRows: 'overlay-signal-rows',
  jev: 'overlay-jev',
  /** The verdict chip "AI · {band}". */
  jevBand: 'overlay-jev-band',
  /** The verdict's first weakness (the rest live in the full rows list). */
  jevWeakness: 'overlay-jev-weakness',
  /** The "Try: {suggestion[0]} · {confidence}% confidence" line. */
  jevTryLine: 'overlay-jev-try-line',
  jevNotice: 'overlay-jev-notice',
  /** The explicit "Analyze with AI" link (autoAnalyze off). */
  analyze: 'overlay-analyze',
  /** The "Retry" link (AI error state). */
  retry: 'overlay-retry',
  connectJev: 'overlay-connect-jev',
  optimizer: 'overlay-optimizer',
  /** The "Find stronger hooks" outline action (hidden entirely without a Jev key — D3). */
  optimize: 'overlay-optimize',
  optimizerPending: 'overlay-optimizer-pending',
  optimizerVariants: 'overlay-optimizer-variants',
  optimizerVariant: 'overlay-optimizer-variant',
  optimizerVariantText: 'overlay-optimizer-variant-text',
  optimizerVariantChars: 'overlay-optimizer-variant-chars',
  optimizerCopy: 'overlay-optimizer-copy',
  optimizerHashtags: 'overlay-optimizer-hashtags',
  optimizerHashtag: 'overlay-optimizer-hashtag',
  optimizerDropAdvice: 'overlay-optimizer-drop-advice',
  optimizerNotice: 'overlay-optimizer-notice',
} as const;

/**
 * Overlay geometry (px). The collapsed row is IN FLOW (inserted before the toolBar) — no
 * placement math; the numbers below are its fixed anatomy and the expanded block's internal
 * scroll budget. `computeAnchorPosition` (fallback placement only, toolbar not found) uses the
 * gap/margin pair.
 */
export const OVERLAY_PLACEMENT = Object.freeze({
  /** The collapsed row's fixed height — it never changes while the user types (design-1b §3). */
  rowHeight: 36,
  /**
   * The expanded block's MAX HEIGHT with internal wheel/trackpad scroll (user decision D2):
   * content beyond this budget scrolls inside the block, so expansion never grows without bound.
   */
  expandedMaxHeight: 420,
  /** Fallback placement (toolbar not found): gap below the composer region, viewport clamp. */
  gap: 8,
  viewportMargin: 8,
  /** Fallback-mode measurement fallbacks for engines without layout (happy-dom). */
  fallbackWidth: 340,
  fallbackHeight: 36,
});

/** Headline color tiers for the dot/score (display only; scoring lives in the engine config). */
export const OVERLAY_HEADLINE_TIERS = Object.freeze({
  good: 70,
  ok: 40,
});

/** The verdict chip's treatment per band (design-1b §4.2): good-bg / hover / weak-bg. */
export const JEVD_BAND_TREATMENT: Readonly<Record<JevBand, 'good' | 'ok' | 'weak'>> = Object.freeze({
  strong: 'good',
  exceptional: 'good',
  moderate: 'ok',
  'below-average': 'weak',
  weak: 'weak',
});

/** Optimizer UI timing (ms): how long a copy button shows "Copied" before reverting. */
export const OPTIMIZER_COPY_RESET_MS = 1500;

/**
 * Every string the overlay renders. English only — no i18n layer. VERBATIM from the Design 1b
 * spec copy tables; where the spec embeds a link inside a sentence the sentence is split into
 * before/link/after parts (no innerHTML is ever used).
 */
export const OVERLAY_COPY = Object.freeze({
  /** The row's accessible name ({n} = headline, {aiLong} = the AI state's long form). */
  rowLabel:
    'AmplifyX viral potential score: {n} out of 100. {aiLong}. Activate for the full draft analysis.',
  /** The row's fixed label (design-1b §3, verbatim). */
  viralLabel: 'Viral potential',
  /** The "N neutral ›" toggle chip ({n} = signals not shown as chips). */
  neutralToggle: (n: number) => `${n} neutral ›`,

  // AI states — design-1b §6 copy table, VERBATIM.
  pendingShort: 'Analyzing…',
  pendingLong: 'AI judgment on its way — the local score above already counts.',
  readyShort: 'Local score',
  readyLongBefore: 'Local score ready. ',
  readyLink: 'Analyze with AI',
  readyLongAfter: ' runs once, only when you ask.',
  verdictShortPrefix: 'AI: ',
  verdictChipPrefix: 'AI · ',
  noKeyShort: 'Local only',
  noKeyLongBefore: 'Local signals only. ',
  noKeyLink: 'Connect Jev',
  noKeyLongAfter: ' to add AI judgment and hook variants.',
  offShort: 'Local only',
  offLong: 'Local signals only. AI analysis is off in Settings.',
  errorShort: 'AI unavailable',
  errorLong: (n: number, reason: string) => `AI unavailable — the ${n} above still applies. ${reason}`,
  retryLink: 'Retry',
  tryPrefix: 'Try:',
  confidenceSuffix: (pct: number) => ` · ${pct}% confidence`,
  confidenceOnly: (pct: number) => `${pct}% confidence`,
  connectJev: 'Connect Jev',

  // Optimizer — design-1b §4.3, VERBATIM.
  optimizeButton: 'Find stronger hooks',
  optimizerPending: 'Finding stronger hooks…',
  optimizerHeading: 'Stronger hooks',
  optimizerCaption: 'copy only · composer untouched',
  optimizerError: 'Optimization failed — your draft and local score are untouched.',
  copyButton: 'Copy',
  copiedLabel: 'Copied',
  charNote: (n: number) => `${n} chars`,
  overLimitFlag: (n: number) => `${n} · over limit`,
  hashtagAdd: 'Add',
  noHashtags: 'No hashtag suggestions for this draft.',

  /** Human-readable reasons for a typed Jev failure (rendered inside the error state's copy). */
  errorReasons: Object.freeze({
    network: 'Could not reach the AI service.',
    http: (status: number) => `The AI service returned an error (HTTP ${status}).`,
    malformed: 'The AI service returned an unreadable response.',
    rateLimited: 'AI analysis is rate-limited right now - try again shortly.',
    /** The analyze-draft message itself failed (background unreachable), not the Jev call. */
    transport: 'The analysis service did not respond. Try analyzing again.',
  }),
});
