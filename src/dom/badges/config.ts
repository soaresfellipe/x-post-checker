/**
 * The one place every TargetBadges/popover UI constant and English string lives: host identity,
 * test ids, placement metrics and ALL user-facing copy (the mission's English-only requirement
 * makes a single copy table the audit surface — VAL-CROSS-016). Anatomy and copy are VERBATIM
 * from the Design 1b spec (`library/design-1b.md` §7/§8, user-approved 2026-10-05); all colors
 * resolve through the shared theme tokens (`src/dom/theme/tokens.ts`).
 */
import { OVERLAY_HEADLINE_TIERS } from '@/dom/overlay/config';

/** Light-DOM host id of the ONE popover (appended to document.body, like the score overlay). */
export const POPOVER_HOST_ID = 'amplifyx-target-popover-host';

/** The badge button rendered inside each article's scanner-provided host. */
export const BADGE_TESTID = 'amplifyx-target-badge';

export const BADGE_TESTIDS = {
  badge: BADGE_TESTID,
  score: 'amplifyx-badge-score',
  /** The "·" separator rendered inside the badge host, before the chip (design-1b §7). */
  separator: 'amplifyx-badge-separator',
  /** The hover/focus tooltip "{reason} · reply target" (the reason leaves the chip surface). */
  tooltip: 'amplifyx-badge-tooltip',
} as const;

export const POPOVER_TESTIDS = {
  panel: 'amplifyx-target-popover',
  close: 'amplifyx-popover-close',
  localScore: 'amplifyx-popover-local-score',
  title: 'amplifyx-popover-title',
  caption: 'amplifyx-popover-caption',
  signals: 'amplifyx-popover-signals',
  chip: 'amplifyx-popover-chip',
  neutralToggle: 'amplifyx-popover-neutral-toggle',
  signalRows: 'amplifyx-popover-signal-rows',
  aiSection: 'amplifyx-popover-ai',
  aiNotice: 'amplifyx-popover-ai-notice',
  deepAnalysis: 'amplifyx-popover-deep-analysis',
  retry: 'amplifyx-popover-retry',
  connectJev: 'amplifyx-popover-connect-jev',
  verdictBand: 'amplifyx-popover-verdict-band',
  verdictConfidence: 'amplifyx-popover-verdict-confidence',
  verdictAngle: 'amplifyx-popover-verdict-angle',
} as const;

/** Popover placement metrics (document-absolute positioning, like the score overlay). */
export const POPOVER_PLACEMENT = {
  width: 300,
  gap: 6,
  viewportMargin: 8,
} as const;

/**
 * The chip's green-tone split (design-1b §7): above-threshold posts at headline ≥ 70 render the
 * green treatment; above-threshold posts BELOW 70 (possible when the user lowered the threshold)
 * render the neutral style instead — never green. The configured badge threshold stays a separate
 * setting; this split is the display rule.
 */
export const BADGE_GREEN_MIN = OVERLAY_HEADLINE_TIERS.good;

/**
 * Concise English badge phrases, one per scorer signal id (VAL-TARGET-006: the reason must
 * correspond to at least one contributing signal). Depth and bait read differently by direction.
 */
export const BADGE_COPY = Object.freeze({
  /** The chip's accessible name (VAL-TARGET-006/026). */
  badgeLabel: (score: number, reason: string): string => `Reply target score ${score}: ${reason}`,
  /** The hover/focus tooltip content (design-1b §7, verbatim shape). */
  tooltip: (reason: string): string => `${reason} · reply target`,
  reasons: Object.freeze({
    velocity: 'High engagement velocity',
    'reply-like-ratio': 'Active conversation',
    question: 'Question post',
    'verified-author': 'Verified author',
    'mutual-follow': 'Author you follow',
    'conversation-depth': 'Deep thread',
    'engagement-bait': 'Engagement bait',
    eligibility: 'Within the 48-hour reply window',
  }),
  /** The separator glyph before the chip (in --fg2). */
  separator: '·',
  popoverTitle: 'Reply target',
  /** Header caption (design-1b §8, verbatim shape): which sources fed the score + the author. */
  caption: (withAi: boolean, handle: string): string => `${withAi ? 'local signals + AI' : 'local signals'} · @${handle}`,
  /** The "N neutral ›" toggle chip ({n} = signals not shown as chips). */
  neutralToggle: (n: number): string => `${n} neutral ›`,

  // Footer per AI state — design-1b §8 pulling the §6 state phrases, VERBATIM.
  footerIdle: 'AI judgment, once, cached',
  deepAnalysis: 'Deep analysis',
  pending: 'Analyzing with AI…',
  verdictChipPrefix: 'AI · ',
  angleLine: (angle: string): string => `Suggested angle: ${angle}`,
  verdictConfidence: (pct: number): string => `${pct}% confidence · a heuristic, not a prediction`,
  noKeyBefore: 'Local signals only. ',
  noKeyLink: 'Connect Jev',
  noKeyAfter: ' to add AI judgment and hook variants.',
  off: 'Local signals only. AI analysis is off in Settings.',
  errorLine: (n: number, reason: string): string => `AI unavailable — the ${n} above still applies. ${reason}`,
  retry: 'Retry',
  close: 'Close',
  errorReasons: Object.freeze({
    network: 'Could not reach the AI service.',
    http: (status: number): string => `The AI service returned an error (HTTP ${status}).`,
    malformed: 'The AI service returned an unreadable response.',
    rateLimited: 'AI analysis is rate-limited right now - try again shortly.',
    /** The analyze-target message itself failed (background unreachable), not the Jev call. */
    transport: 'The analysis service did not respond. Try again.',
  }),
});

/**
 * Badge chip look (design-1b §7): a score-only 18px pill in the tier tint, preceded by the "·"
 * separator, with the inverted hover/focus treatment and the tooltip. Pointer events stay OFF on
 * the host and ON only for the chip button itself (AGENTS.md rule).
 */
export const BADGE_STYLE = `
  :host { all: initial; position: relative; display: inline-flex; align-items: center; pointer-events: none; }
  .sep { color: var(--fg2); font: 400 13px/1 system-ui, -apple-system, sans-serif; }
  .chip {
    pointer-events: auto;
    display: inline-flex; align-items: center; justify-content: center;
    height: 18px; padding: 0 6px;
    border: 0; border-radius: 999px;
    background: var(--good-bg); color: var(--good);
    font: 700 12px/1 system-ui, -apple-system, sans-serif;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }
  .chip[data-tone='neutral'] { background: var(--hover); color: var(--fg2); }
  .chip[data-tone='good']:hover, .chip[data-tone='good']:focus-visible { background: var(--good); color: #ffffff; }
  .chip[data-tone='neutral']:hover, .chip[data-tone='neutral']:focus-visible { background: var(--fg2); color: var(--bg); }
  .chip:focus-visible { outline: 1px solid var(--accent); }
  .tooltip {
    display: none; position: absolute; top: calc(100% + 6px); left: 0; z-index: 1;
    background: var(--fg); color: var(--bg);
    font: 400 12px/1.4 system-ui, -apple-system, sans-serif;
    border-radius: 4px; padding: 5px 8px; white-space: nowrap;
  }
  .chip:hover + .tooltip, .chip:focus-visible + .tooltip { display: block; }
`;

/**
 * Popover panel look (design-1b §8): a 300px radius-16 borderless card on the --shadow hovercard
 * shadow; the host and panel never capture pointer input, only the panel's own buttons do.
 */
export const POPOVER_STYLE = `
  :host { all: initial; position: absolute; z-index: 2147483000; pointer-events: none; }
  .panel { pointer-events: none; }
  .panel {
    box-sizing: border-box;
    width: min(300px, calc(100vw - 16px));
    overflow-y: auto;
    display: flex; flex-direction: column; gap: 10px;
    padding: 12px 14px 14px;
    border-radius: 16px;
    background: var(--bg); color: var(--fg);
    font: 400 13px/1.45 system-ui, -apple-system, sans-serif;
    box-shadow: var(--shadow);
  }
  .panel header { display: flex; align-items: center; gap: 8px; }
  .panel .headline { font-size: 22px; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; }
  .panel .title { font-size: 14px; font-weight: 700; }
  .panel .caption { color: var(--fg2); }
  .panel header button.close {
    pointer-events: auto;
    flex: 0 0 auto; margin-left: auto;
    width: 28px; height: 28px; padding: 0;
    display: inline-flex; align-items: center; justify-content: center;
    border: 0; border-radius: 999px; cursor: pointer;
    background: transparent; color: var(--fg2);
    font: 400 16px/1 system-ui, sans-serif;
  }
  .panel header button.close:hover { background: var(--hover); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; font-weight: 500; font-size: 13px; }
  .chip .points { font-weight: 700; font-variant-numeric: tabular-nums; }
  .chip[data-direction='positive'] { color: var(--good); background: var(--good-bg); }
  .chip[data-direction='negative'] { color: var(--weak); background: var(--weak-bg); }
  .neutral-toggle {
    min-height: 28px; padding: 6px 10px;
    border: 0; border-radius: 999px; background: var(--hover); color: var(--fg2);
    font: 500 13px/16px system-ui, -apple-system, sans-serif; cursor: pointer;
  }
  .rows { list-style: none; margin: 0; padding: 0; }
  .rows li { display: flex; gap: 6px; padding: 2px 0; }
  .rows li .label { flex: 0 0 44%; }
  .rows li .value { flex: 1; color: var(--fg2); }
  .rows li .points { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
  .rows li .points[data-direction='positive'] { color: var(--good); }
  .rows li .points[data-direction='negative'] { color: var(--weak); }
  .footer { border-top: 1px solid var(--line); padding-top: 10px; display: flex; flex-direction: column; gap: 6px; }
  .footer .notice { color: var(--fg2); margin: 0; }
  .footer .pending { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--fg2); }
  .footer .pending .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); animation: amplifyx-popover-pulse 1.2s ease-in-out infinite; }
  @keyframes amplifyx-popover-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  @media (prefers-reduced-motion: reduce) {
    .footer .pending .dot { animation: none; opacity: 0.6; }
  }
  .band { display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 999px; font-weight: 700; font-size: 13px; }
  .band[data-treatment='good'] { color: var(--good); background: var(--good-bg); }
  .band[data-treatment='ok'] { color: var(--fg2); background: var(--hover); }
  .band[data-treatment='weak'] { color: var(--weak); background: var(--weak-bg); }
  .angle-line { margin: 0; }
  .confidence-line { color: var(--fg2); margin: 0; }
  .error-reason { color: var(--weak); margin: 0; }
  button.link {
    pointer-events: auto;
    align-self: flex-start;
    min-height: 28px;
    padding: 0;
    border: 0; background: none; cursor: pointer;
    color: var(--accent); font: 500 13px/1.45 system-ui, -apple-system, sans-serif;
  }
  button.link:hover { text-decoration: underline; }
`;
