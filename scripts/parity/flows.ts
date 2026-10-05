/**
 * The parity flow registry: every flow's seed state, draft texts, and the Node-side expectations
 * each browser leg must satisfy on its own (VAL-DRAFT-025, VAL-CROSS-009, VAL-CROSS-010). The
 * runner executes the same registry for Chromium (Playwright) and Firefox (web-ext + Marionette);
 * afterwards the two outcome sets are compared for equality (stable fields only — see run.ts).
 *
 * Flows run in order and share one browser profile per leg, so they are grouped: no-key flows
 * first (no key has been seeded yet), then keyed flows (synthetic key + fixture-hosted Jev mock),
 * then the outage flows (real endpoint, blocked by the refusal proxy). Every flow's seed fully
 * rewrites settings + key + endpoint override, and every draft text is unique, so verdict caches
 * and revision gates carry no state between flows. The flows exercise the M6 design-1b row model
 * (in-flow 36px status row, inline expansion, outside-click forward, edit/Escape collapse, and
 * the three-theme live switch).
 */
import type { DriverArg, FlowOutcome } from './inpage-driver';

/**
 * The seed applied through the background's 'seed-test-state' handler: full settings (the real
 * single-writer store sanitizes and stamps them), the synthetic-or-empty key, and the Jev
 * endpoint override ('' = cleared, so the outage flows hit the REAL blocked endpoint).
 */
function seedPayload(options: {
  key: string | null;
  endpointOverride: string | null;
  jevForDrafts?: boolean;
  jevForTargets?: boolean;
}): Record<string, unknown> {
  return {
    settings: {
      enabled: true,
      autoAnalyze: true,
      jevForDrafts: options.jevForDrafts ?? true,
      jevForTargets: options.jevForTargets ?? false,
      minDraftLength: 10,
      targetThreshold: 70,
    },
    apiKey: options.key ?? '',
    jevEndpointOverride: options.endpointOverride ?? '',
  };
}

/** The mock endpoint URL for one flow's behavior (per-flow query = per-flow call counters). */
function mockEndpoint(flow: string, behavior: string): string {
  return `http://localhost:3177/__mock/jev?behavior=${behavior}&flow=${flow}`;
}

/** A clearly synthetic key: the mock never authenticates it, and it must never reach evidence. */
const SYNTHETIC_KEY = 'key-parity-smoke-0001';

export interface ParityFlow {
  name: string;
  arg: DriverArg;
  /** Per-browser outcome expectations; a returned string is the failure reason. */
  expect: (outcome: FlowOutcome) => string | null;
}

/**
 * The overlay summary a flow recorded. The surface is the M6 DESIGN-1B ROW MODEL: `rowPresent`
 * is the default state while typing (the 36px in-flow status row before the toolBar), `expanded`
 * only after an explicit row click, and `present` false when NO extension UI is rendered at all
 * (empty / below-minimum draft).
 */
function overlayOf(outcome: FlowOutcome): Record<string, unknown> {
  return (outcome['overlay'] as Record<string, unknown>) ?? {};
}

/**
 * The row-model invariant every scored-draft overlay summary must satisfy (VAL-DRAFT-032/041):
 * before the row click the ONLY surface was the collapsed 36px status row, with no expanded
 * block in the DOM; the click expands the inline analysis. `inFlow` additionally pins the
 * in-flow placement (immediate toolBar sibling) — true for the home composer, whose fixture
 * view carries a `[data-testid="toolBar"]`; the reply-DIALOG fixture view has NO toolBar, so
 * there the fallback placement with the SAME row anatomy is the contract-correct outcome.
 */
function rowFirstViolation(overlay: Record<string, unknown>, inFlow = true): string | null {
  const collapsed = (overlay['collapsed'] as Record<string, unknown> | null) ?? null;
  if (collapsed === null) return 'the collapsed row state was never observed before the expansion';
  if (collapsed['present'] !== true) return 'the collapsed status row is missing while a draft is scored';
  if (collapsed['expandedBlock'] !== false) return 'the expanded block was already rendered while typing';
  if (collapsed['ariaExpanded'] !== 'false') return `the row's aria-expanded: ${String(collapsed['ariaExpanded'])}`;
  if (!/^\d{1,3}$/.test(String(collapsed['text']))) {
    return `the row's headline is not a bare score: "${String(collapsed['text'])}"`;
  }
  if (overlay['state'] !== 'analyzed') return `expanded block state: ${String(overlay['state'])}`;
  if (overlay['expanded'] !== true) return 'the row click did not expand the inline analysis';
  if (inFlow) {
    if (overlay['placement'] !== 'flow') return `overlay placement: ${String(overlay['placement'])}`;
    if (overlay['toolbarSibling'] !== true) return 'the host is not the toolBar\'s preceding sibling';
  } else if (overlay['placement'] !== 'fallback') {
    return `overlay placement (reply dialog, no toolBar): ${String(overlay['placement'])}`;
  }
  return null;
}

function badgeFor(outcome: FlowOutcome, postId: string): Record<string, unknown> | null {
  const badges = (outcome['badges'] as Array<Record<string, unknown>>) ?? [];
  return badges.find((badge) => badge['postId'] === postId) ?? null;
}

const POST_1_ID = '1800000000000000001';

export const PARITY_FLOWS: readonly ParityFlow[] = [
  {
    name: 'main-composer-detected',
    arg: { seed: seedPayload({ key: null, endpointOverride: null }), texts: {} },
    expect: (outcome): string | null => {
      if (outcome['watcherState'] !== 'watching') return `watcher state: ${String(outcome['watcherState'])}`;
      if (outcome['watcherComposer'] !== 'tweetTextarea_0') return `watched composer: ${String(outcome['watcherComposer'])}`;
      // An empty composer renders NO extension UI near it at all (M5 dropped the empty balloon).
      const overlay = overlayOf(outcome);
      if (overlay['present'] !== false || overlay['rowPresent'] !== false) return `overlay: ${JSON.stringify(overlay)}`;
      return null;
    },
  },
  {
    name: 'short-draft-empty-state',
    arg: { seed: seedPayload({ key: null, endpointOverride: null }), texts: { short: 'Too short' } },
    expect: (outcome): string | null => {
      // Below minDraftLength NOTHING is rendered: no host, no row, no block (VAL-DRAFT-005).
      const overlay = overlayOf(outcome);
      if (overlay['present'] !== false) return `overlay UI below the minimum length: ${JSON.stringify(overlay)}`;
      if (overlay['rowPresent'] !== false || overlay['expanded'] !== false) {
        return `overlay surfaces below the minimum length: ${JSON.stringify(overlay)}`;
      }
      return null;
    },
  },
  {
    name: 'reply-composer-detected',
    arg: { seed: seedPayload({ key: null, endpointOverride: null }), texts: { reply: 'Reply draft: adding the missing benchmark numbers to this thread right now.' } },
    expect: (outcome): string | null => {
      if (outcome['watcherComposer'] !== 'tweetTextarea_1') return `watched composer: ${String(outcome['watcherComposer'])}`;
      // The reply-DIALOG fixture view has no toolBar: fallback placement with the SAME row
      // anatomy is the contract-correct outcome there (VAL-DRAFT-041's fallback clause).
      const overlay = overlayOf(outcome);
      const collapsed = rowFirstViolation(overlay, false);
      if (collapsed !== null) return collapsed;
      if (overlay['headlineSource'] !== 'local') return `headline source: ${String(overlay['headlineSource'])}`;
      if (overlay['jevState'] !== 'no-key') return `jev state: ${String(overlay['jevState'])}`;
      if (overlay['connectJev'] !== true) return 'Connect Jev affordance missing on the reply analysis';
      return null;
    },
  },
  {
    name: 'local-score-no-key',
    arg: { seed: seedPayload({ key: null, endpointOverride: null }), texts: { local: 'Local only draft: steady hands ship better software every single week.' } },
    expect: (outcome): string | null => {
      const overlay = overlayOf(outcome);
      const collapsed = rowFirstViolation(overlay);
      if (collapsed !== null) return collapsed;
      if (overlay['headlineSource'] !== 'local') return `headline source: ${String(overlay['headlineSource'])}`;
      if (overlay['jevState'] !== 'no-key') return `jev state: ${String(overlay['jevState'])}`;
      if (Number(overlay['signals']) < 1) return `signals: ${String(overlay['signals'])}`;
      const headline = Number(overlay['headline']);
      if (!(headline >= 0 && headline <= 100)) return `headline out of range: ${String(overlay['headline'])}`;
      // The collapsed row's number and the expanded state's headline are the same local score.
      const collapsedText = String((overlay['collapsed'] as Record<string, unknown> | null)?.['text'] ?? '');
      if (collapsedText !== String(overlay['headline'])) {
        return `collapsed row "${collapsedText}" != headline "${String(overlay['headline'])}"`;
      }
      return null;
    },
  },
  {
    // VAL-DRAFT-025 (M6-SCRUTINY-009): the "N neutral ›" toggle is a required parity leg —
    // the full rows list must open and close through the toggle in BOTH browsers, on the draft
    // overlay AND on the badge popover (the same 1b chip model on both surfaces).
    name: 'neutral-rows-toggle',
    arg: {
      seed: seedPayload({ key: null, endpointOverride: null }),
      texts: { neutral: 'Neutral toggle draft: list the steady routines that quietly compound into a stronger week.' },
    },
    expect: (outcome): string | null => {
      const overlay = overlayOf(outcome);
      const collapsed = rowFirstViolation(overlay);
      if (collapsed !== null) return collapsed;
      if (overlay['neutralToggle'] !== true) return 'the "N neutral ›" toggle is missing from the expanded block';
      // hidden → shown → hidden: the toggle's full open/close cycle, observed on the page.
      const before = (outcome['toggleHidden'] as Record<string, unknown>) ?? {};
      const open = (outcome['toggleOpen'] as Record<string, unknown>) ?? {};
      const closed = (outcome['toggleClosed'] as Record<string, unknown>) ?? {};
      if (before['ariaExpanded'] !== 'false' || before['rowsPresent'] !== false) {
        return `rows before the toggle: ${JSON.stringify(before)}`;
      }
      if (open['ariaExpanded'] !== 'true' || open['rowsPresent'] !== true) {
        return `rows after opening: ${JSON.stringify(open)}`;
      }
      if (Number(open['rowCount']) < 1) return `rows list empty when opened: ${JSON.stringify(open)}`;
      if (!/^\d+ neutral ›$/.test(String(open['toggleText'] ?? ''))) return `toggle label: ${String(open['toggleText'])}`;
      if (closed['ariaExpanded'] !== 'false' || closed['rowsPresent'] !== false) {
        return `rows after closing: ${JSON.stringify(closed)}`;
      }
      // The badge popover's own toggle: its rows list starts hidden and opens/closes the same way.
      const popover = (outcome['popoverToggle'] as Record<string, unknown>) ?? {};
      if (popover['before'] !== 'hidden' || popover['open'] !== 'shown' || popover['closed'] !== 'hidden') {
        return `popover rows toggle: ${JSON.stringify(popover)}`;
      }
      return null;
    },
  },
  {
    name: 'both-surfaces',
    arg: { seed: seedPayload({ key: null, endpointOverride: null }), texts: { both: 'Both surfaces draft: the composer and the timeline badges coexist peacefully here.' } },
    expect: (outcome): string | null => {
      const overlay = overlayOf(outcome);
      const collapsed = rowFirstViolation(overlay);
      if (collapsed !== null) return collapsed;
      // M6 (VAL-DRAFT-037): the first outside click on the EXPANDED block both collapses it
      // and reaches the page — the like counter incremented on that same first click.
      if (outcome['outsideClickCollapsed'] !== true) return 'the first outside click did not collapse the expanded block';
      if (outcome['likeClickReachedPage'] !== true) return 'the native like click never reached the page (surface blocked it)';
      const post1 = badgeFor(outcome, POST_1_ID);
      if (post1 === null) return 'no badge on the question post (post 1)';
      if (typeof post1['reason'] !== 'string' || post1['reason'] === '') return 'post-1 badge has no reason';
      if (post1['inUserName'] !== true) return 'post-1 badge is not inside [data-testid="User-Name"] (1b placement)';
      const popover = outcome['popover'] as Record<string, unknown>;
      if (popover['present'] !== true) return 'popover did not open from the badge click';
      if (typeof popover['localScore'] !== 'string' || popover['localScore'] === '') return 'popover local score missing';
      if (outcome['popoverClosed'] !== true) return 'popover did not close';
      if (outcome['locationStillHome'] !== true) return 'the badge click navigated the page (badge isolation broken)';
      return null;
    },
  },
  {
    name: 'jev-pending-success',
    arg: {
      seed: seedPayload({ key: SYNTHETIC_KEY, endpointOverride: mockEndpoint('jev-pending-success', 'ok-slow-1200') }),
      texts: { pending: 'Pending success draft: every experiment starts with one honest measurement.' },
    },
    expect: (outcome): string | null => {
      const pending = (outcome['pending'] as Record<string, unknown>) ?? {};
      if (pending['state'] !== 'analyzed') return `pending overlay state: ${String(pending['state'])}`;
      if (pending['jevState'] !== 'pending') return `pending jev state: ${String(pending['jevState'])}`;
      if (!String(pending['jevNotice'] ?? '').includes('AI judgment on its way')) {
        return `pending copy: ${String(pending['jevNotice'])}`;
      }
      if (pending['aiShort'] !== 'Analyzing…') return `pending row AI label: ${String(pending['aiShort'])}`;
      const settled = (outcome['settled'] as Record<string, unknown>) ?? {};
      if (settled['jevState'] !== 'verdict') return `settled jev state: ${String(settled['jevState'])}`;
      if (settled['headlineSource'] !== 'hybrid') return `settled headline source: ${String(settled['headlineSource'])}`;
      if (String(settled['jevBand'] ?? '').length === 0) return 'settled band missing';
      if (!String(settled['jevTryLine'] ?? '').includes('65% confidence')) return `settled try line: ${String(settled['jevTryLine'])}`;
      // The re-collapsed row sampled AFTER the verdict carries the hybrid headline — the
      // field-comparable number this flow contributes to the cross-browser score comparison.
      const settledCollapsed = (settled['collapsed'] as Record<string, unknown> | null) ?? null;
      if (settledCollapsed === null || String(settledCollapsed['text']) !== String(settled['headline'])) {
        return `settled collapsed row: ${JSON.stringify(settledCollapsed)}`;
      }
      return null;
    },
  },
  {
    name: 'jev-failure',
    arg: {
      seed: seedPayload({ key: SYNTHETIC_KEY, endpointOverride: mockEndpoint('jev-failure', 'http-500') }),
      texts: { failure: 'Failure draft: this one goes out to every builder shipping through the noise.' },
    },
    expect: (outcome): string | null => {
      const overlay = overlayOf(outcome);
      if (overlay['state'] !== 'analyzed') return `overlay state: ${String(overlay['state'])}`;
      if (overlay['jevState'] !== 'error') return `jev state: ${String(overlay['jevState'])}`;
      if (!String(overlay['jevErrorReason'] ?? '').includes('HTTP 500')) return `error reason: ${String(overlay['jevErrorReason'])}`;
      if (overlay['headlineSource'] !== 'local') return `headline source after failure: ${String(overlay['headlineSource'])}`;
      if (Number(overlay['signals']) < 1) return 'local signals missing after failure';
      return null;
    },
  },
  {
    // VAL-DRAFT-025 (M6-SCRUTINY-009): the draft's AI 'off' state is a required parity leg —
    // seeded with jevForDrafts:false (key + endpoint still configured, so 'off' wins over key
    // presence) and asserting the 1b off copy plus the pure local score in row and block.
    name: 'draft-ai-off',
    arg: {
      seed: seedPayload({ key: SYNTHETIC_KEY, endpointOverride: mockEndpoint('draft-ai-off', 'ok'), jevForDrafts: false }),
      texts: { off: 'Off draft: the local score carries this panel while the AI lane sits out.' },
    },
    expect: (outcome): string | null => {
      const overlay = overlayOf(outcome);
      const collapsed = rowFirstViolation(overlay);
      if (collapsed !== null) return collapsed;
      // The 1b off copy, verbatim: short label on the row, long notice in the block (config.ts).
      if (overlay['jevState'] !== 'off') return `jev state: ${String(overlay['jevState'])}`;
      if (overlay['aiShort'] !== 'Local only') return `row AI label: ${String(overlay['aiShort'])}`;
      if (overlay['headlineSource'] !== 'local') return `headline source: ${String(overlay['headlineSource'])}`;
      if (String(overlay['jevNotice'] ?? '') !== 'Local signals only. AI analysis is off in Settings.') {
        return `off copy: ${String(overlay['jevNotice'])}`;
      }
      // The pure LOCAL score in row and block: the row headline is the same number the collapsed
      // row showed, and the expanded block still renders the local signal chips.
      const collapsedText = String((overlay['collapsed'] as Record<string, unknown> | null)?.['text'] ?? '');
      if (collapsedText !== String(overlay['headline'])) {
        return `row headline: "${collapsedText}" != "${String(overlay['headline'])}"`;
      }
      if (Number(overlay['signals']) < 1) return 'local signal chips missing while off';
      if (overlay['connectJev'] !== false) return 'unexpected Connect Jev link in the off state';
      // No AI request may leave while jevForDrafts is off — even with a key and endpoint set.
      if (outcome['mockCalls'] !== 0) return `Jev calls with the AI lane off: ${String(outcome['mockCalls'])}`;
      return null;
    },
  },
  {
    name: 'collapse-triggers',
    arg: { seed: seedPayload({ key: null, endpointOverride: null }), texts: { collapse: 'Collapse draft: outside clicks, edits and Escape all close the inline analysis.' } },
    expect: (outcome): string | null => {
      // VAL-DRAFT-036: a new composer edit collapses the block while the edit is applied.
      if (outcome['editCollapsed'] !== true) return 'a new composer edit did not collapse the expanded block';
      // VAL-DRAFT-035: Escape collapses the block; the status row remains with the headline.
      if (outcome['escapeCollapsed'] !== true) return 'Escape did not collapse the expanded block';
      return null;
    },
  },
  {
    name: 'theme-switch',
    arg: { seed: seedPayload({ key: null, endpointOverride: null }), texts: { theme: 'Theme draft: the row and badges follow the body background across all three X themes.' } },
    expect: (outcome): string | null => {
      // The ThemeDetector re-maps both shadow hosts live; 'unknown' falls back to light
      // (VAL-THEME-001/002, exercised cross-browser here).
      const themes = (outcome['themes'] as Record<string, Record<string, unknown>>) ?? {};
      for (const [theme, expected] of [['light', 'light'], ['dim', 'dim'], ['lights-out', 'lights-out'], ['unknown', 'light']] as const) {
        const observed = themes[theme] ?? {};
        if (observed['overlay'] !== expected) return `overlay data-theme after ${theme}: ${String(observed['overlay'])}`;
        if (observed['badge'] !== expected) return `badge data-theme after ${theme}: ${String(observed['badge'])}`;
      }
      return null;
    },
  },
  {
    name: 'clearing',
    arg: { seed: seedPayload({ key: SYNTHETIC_KEY, endpointOverride: mockEndpoint('clearing', 'ok') }), texts: { clear: 'Clearing draft: this text will be deleted from the composer below.' } },
    expect: (outcome): string | null => {
      // Clearing removes every extension surface near the composer (VAL-DRAFT-014).
      const overlay = overlayOf(outcome);
      if (overlay['present'] !== false || overlay['expanded'] !== false) {
        return `overlay after clearing: ${JSON.stringify(overlay)}`;
      }
      return null;
    },
  },
  {
    name: 'stale-response',
    arg: {
      seed: seedPayload({ key: SYNTHETIC_KEY, endpointOverride: mockEndpoint('stale-response', 'slow-first-3000') }),
      texts: {
        staleA: 'Stale draft A: the slow first response belongs to this older text about momentum.',
        staleB: 'Stale draft B: the newer text wins the panel and keeps its own verdict forever.',
      },
    },
    expect: (outcome): string | null => {
      if (outcome['headlineUnchanged'] !== true) return 'the late stale reply repainted the panel (headline changed)';
      if (outcome['bandUnchanged'] !== true) return 'the late stale reply repainted the panel (band changed)';
      if (outcome['mockCalls'] !== 2) return `mock Jev calls: ${String(outcome['mockCalls'])}`;
      const afterB = (outcome['afterB'] as Record<string, unknown>) ?? {};
      const afterLate = (outcome['afterLateReply'] as Record<string, unknown>) ?? {};
      if (afterB['jevState'] !== 'verdict' || afterLate['jevState'] !== 'verdict') return 'settled verdict missing around the stale window';
      return null;
    },
  },
  {
    name: 'spa-teardown-remount',
    arg: { seed: seedPayload({ key: SYNTHETIC_KEY, endpointOverride: mockEndpoint('spa-teardown-remount', 'ok') }), texts: { spa: 'SPA draft: the overlay follows the composer across route changes and teardowns.' } },
    expect: (outcome): string | null => {
      const before = (outcome['before'] as Record<string, unknown>) ?? {};
      const tornDown = (outcome['tornDown'] as Record<string, unknown>) ?? {};
      const remounted = (outcome['remounted'] as Record<string, unknown>) ?? {};
      if (before['overlayPresent'] !== true || before['rowPresent'] !== true) {
        return `overlay absent before navigation: ${JSON.stringify(before)}`;
      }
      if (tornDown['overlayGone'] !== true) return 'overlay survived the SPA teardown';
      if (tornDown['watcherState'] !== 'idle') return `watcher state after teardown: ${String(tornDown['watcherState'])}`;
      if (remounted['watcherState'] !== 'watching') return `watcher state after remount: ${String(remounted['watcherState'])}`;
      const overlay = (remounted['overlay'] as Record<string, unknown>) ?? {};
      if (overlay['present'] !== false) return `remounted overlay: ${JSON.stringify(overlay)}`;
      if (before['epoch'] !== remounted['epoch']) return 'the SPA navigation reloaded the page (epoch changed)';
      return null;
    },
  },
  {
    name: 'outage-draft',
    arg: {
      seed: seedPayload({ key: SYNTHETIC_KEY, endpointOverride: '' }),
      texts: { outage: 'Outage draft: the local score stays usable while the AI service is down.' },
    },
    expect: (outcome): string | null => {
      const overlay = overlayOf(outcome);
      if (overlay['state'] !== 'analyzed') return `overlay state: ${String(overlay['state'])}`;
      if (overlay['jevState'] !== 'error') return `jev state: ${String(overlay['jevState'])}`;
      // The degraded notice embeds the network failure reason (the 1b error copy table).
      if (!String(overlay['jevNotice'] ?? '').includes('AI unavailable')) return `degraded notice: ${String(overlay['jevNotice'])}`;
      if (!String(overlay['jevErrorReason'] ?? '').includes('Could not reach the AI service.')) {
        return `degraded error reason: ${String(overlay['jevErrorReason'])}`;
      }
      if (overlay['headlineSource'] !== 'local') return `headline source: ${String(overlay['headlineSource'])}`;
      if (Number(overlay['signals']) < 1) return 'local signals missing under outage';
      return null;
    },
  },
  {
    name: 'outage-targets',
    arg: {
      seed: seedPayload({ key: SYNTHETIC_KEY, endpointOverride: '', jevForTargets: true }),
      texts: {},
    },
    expect: (outcome): string | null => {
      const badges = (outcome['badges'] as Array<Record<string, unknown>>) ?? [];
      if (badges.length === 0) return 'no badges under outage (local target scoring must survive)';
      const popover = (outcome['popover'] as Record<string, unknown>) ?? {};
      if (popover['aiState'] !== 'error') return `popover AI state: ${String(popover['aiState'])}`;
      // The popover error state embeds the reason in its notice line, with a Retry link.
      if (!String(popover['aiNotice'] ?? '').includes('Could not reach the AI service.')) {
        return `popover error notice: ${String(popover['aiNotice'])}`;
      }
      if (popover['aiRetry'] !== true) return 'popover error state has no Retry link';
      if (typeof popover['localScore'] !== 'string' || popover['localScore'] === '') return 'popover local score missing under outage';
      return null;
    },
  },
];

/** Fields logged as evidence but excluded from strict cross-browser equality. */
export function stripVolatile(outcome: FlowOutcome): FlowOutcome {
  const clone = structuredClone(outcome) as FlowOutcome;
  // The FULL badge set is viewport-dependent (the fixture feed is virtualized and recycles
  // articles on scroll, so which eligible posts intersect the fold at snapshot time differs by
  // engine layout). The compared unit is `targetBadge` — the sorted-first eligible post's chip,
  // present in every leg — recorded per flow. Badge scores stay stripped (defensive: scoring
  // floats are engine-identical but the strip predates this harness).
  delete clone['badges'];
  const targetBadge = clone['targetBadge'];
  if (targetBadge !== null && typeof targetBadge === 'object') {
    delete (targetBadge as Record<string, unknown>)['score'];
  }
  delete clone['mockCalls']; // call-log reads race with in-flight slow exchanges by ±1 entry
  // `collapsed.text` (the row's headline number) IS compared: the driver samples it only after
  // the row's AI half has settled, so the number is deterministic for the draft (local when no
  // verdict can land, the hybrid one once it has) and equal across browsers for the same draft +
  // mock verdict. Cross-browser score equivalence is part of the parity evidence
  // (VAL-DRAFT-025 / VAL-CROSS-010) — do not strip it.
  // `epoch` is a random per-document session id (used for teardown/remount detection): never
  // comparable across browsers. It can appear at the top level or nested in sub-probes.
  const stripEpoch = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) stripEpoch(child);
    } else if (node !== null && typeof node === 'object') {
      delete (node as Record<string, unknown>)['epoch'];
      for (const child of Object.values(node as Record<string, unknown>)) stripEpoch(child);
    }
  };
  stripEpoch(clone);
  return clone;
}
