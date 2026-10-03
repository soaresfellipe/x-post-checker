/**
 * The one place every TargetBadges/popover UI constant and English string lives: host identity,
 * test ids, placement metrics and ALL user-facing copy (the mission's English-only requirement
 * makes a single copy table the audit surface — VAL-CROSS-016).
 */

/** Light-DOM host id of the ONE popover (appended to document.body, like the score overlay). */
export const POPOVER_HOST_ID = 'amplifyx-target-popover-host';

/** The badge button rendered inside each article's scanner-provided host. */
export const BADGE_TESTID = 'amplifyx-target-badge';

export const BADGE_TESTIDS = {
  badge: BADGE_TESTID,
  score: 'amplifyx-badge-score',
  reason: 'amplifyx-badge-reason',
} as const;

export const POPOVER_TESTIDS = {
  panel: 'amplifyx-target-popover',
  close: 'amplifyx-popover-close',
  localScore: 'amplifyx-popover-local-score',
  signals: 'amplifyx-popover-signals',
  aiSection: 'amplifyx-popover-ai',
  aiNotice: 'amplifyx-popover-ai-notice',
  aiErrorReason: 'amplifyx-popover-ai-error-reason',
  deepAnalysis: 'amplifyx-popover-deep-analysis',
  retry: 'amplifyx-popover-retry',
  connectJev: 'amplifyx-popover-connect-jev',
  verdictBand: 'amplifyx-popover-verdict-band',
  verdictConfidence: 'amplifyx-popover-verdict-confidence',
  verdictAngle: 'amplifyx-popover-verdict-angle',
} as const;

/** Popover placement metrics (document-absolute positioning, like the score overlay). */
export const POPOVER_PLACEMENT = {
  width: 340,
  gap: 6,
  viewportMargin: 8,
} as const;

/**
 * Concise English badge phrases, one per scorer signal id (VAL-TARGET-006: the reason must
 * correspond to at least one contributing signal). Depth and bait read differently by direction.
 */
export const BADGE_COPY = Object.freeze({
  badgeLabel: (score: number, reason: string): string => `Reply target score ${score}: ${reason}`,
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
  popoverTitle: 'Reply target',
  localScoreLabel: 'Local score',
  signalsHeading: 'Algorithm signals',
  aiHeading: 'AI judgment',
  aiIdle: 'Run a one-off AI judgment of this reply target. It is sent once and cached for this post.',
  deepAnalysis: 'Deep analysis',
  pending: 'Analyzing with AI…',
  confidenceLabel: 'Confidence',
  angleLabel: 'Suggested angle',
  verdictNote: 'AI judgment of reply potential - a heuristic, not a prediction.',
  noKey: 'Local signals only. Connect Jev to add AI judgment.',
  connectJev: 'Connect Jev',
  off: 'Deep analysis is unavailable: AI analysis for reply targets is off in Settings.',
  error: 'Deep analysis failed.',
  retry: 'Try again',
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

/** Badge pill look; pointer-events stay OFF except on the badge button itself (AGENTS.md rule). */
export const BADGE_STYLE = `
  :host { all: initial; }
  .badge {
    pointer-events: auto;
    display: inline-flex; align-items: baseline; gap: 6px;
    margin: 2px 0 4px; padding: 2px 10px;
    border: 1px solid #cfd9de; border-radius: 999px;
    background: #eff7f6; color: #0f1419;
    font: 600 12px/1.5 system-ui, -apple-system, sans-serif;
    cursor: pointer;
  }
  .badge .score { color: #00a680; font-variant-numeric: tabular-nums; }
  .badge .reason { font-weight: 500; }
`;

/** Popover panel look; the host and panel never capture pointer input, only the buttons do. */
export const POPOVER_STYLE = `
  :host { all: initial; position: absolute; z-index: 2147483000; pointer-events: none; }
  .panel { pointer-events: none; }
  .panel {
    box-sizing: border-box;
    width: min(340px, calc(100vw - 16px));
    overflow-y: auto;
    padding: 12px;
    border: 1px solid #cfd9de; border-radius: 12px;
    background: #ffffff; color: #0f1419;
    font: 400 13px/1.45 system-ui, -apple-system, sans-serif;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.16);
  }
  .panel header { display: flex; align-items: baseline; gap: 6px; margin-bottom: 6px; }
  .panel .title { font-weight: 700; font-size: 14px; }
  .panel .subtitle { color: #536471; font-size: 12px; flex: 1; }
  .panel header button { pointer-events: auto; border: 0; background: none; cursor: pointer; color: #536471; font: 600 12px/1 system-ui, sans-serif; padding: 4px 6px; border-radius: 6px; }
  .panel header button:hover { background: #eff3f4; }
  .score-row { display: flex; align-items: baseline; gap: 8px; margin: 2px 0 6px; }
  .score-row .number { font-size: 28px; font-weight: 700; line-height: 1; color: #00a680; }
  .score-row .label { color: #536471; font-size: 12px; }
  section h3 {
    margin: 8px 0 4px; font-size: 11px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.06em; color: #536471;
  }
  section[data-testid="amplifyx-popover-signals"] h3 { color: #0f1419; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; gap: 6px; padding: 2px 0; }
  li .label { flex: 0 0 44%; }
  li .value { flex: 1; color: #536471; }
  li .points { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
  li .points[data-direction="positive"] { color: #00a680; }
  li .points[data-direction="negative"] { color: #d64545; }
  .notice { color: #536471; margin: 4px 0; }
  .error-reason { color: #d64545; margin: 2px 0; }
  .pending { color: #536471; font-style: italic; }
  .band { font-weight: 700; }
  .verdict-note { color: #536471; font-size: 11px; margin: 6px 0 0; }
  button.action {
    pointer-events: auto;
    margin-top: 6px; margin-right: 6px; padding: 4px 12px;
    border: 0; border-radius: 999px; cursor: pointer;
    background: #1d9bf0; color: #ffffff; font: 600 12px/1.4 system-ui, sans-serif;
  }
`;
