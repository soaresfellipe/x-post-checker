/**
 * The parity flow registry: every flow's seed state, draft texts, and the Node-side expectations
 * each browser leg must satisfy on its own (VAL-DRAFT-025, VAL-CROSS-010). The runner executes
 * the same registry for Chromium (Playwright) and Firefox (web-ext + Marionette); afterwards the
 * two outcome sets are compared for equality (stable fields only — see run.ts).
 *
 * Flows run in order and share one browser profile per leg, so they are grouped: no-key flows
 * first (no key has been seeded yet), then keyed flows (synthetic key + fixture-hosted Jev mock),
 * then the outage flows (real endpoint, blocked by the refusal proxy). Every flow's seed fully
 * rewrites settings + key + endpoint override, and every draft text is unique, so verdict caches
 * and revision gates carry no state between flows.
 */
import type { DriverArg, FlowOutcome } from './inpage-driver';

/**
 * The seed applied through the background's 'seed-test-state' handler: full settings (the real
 * single-writer store sanitizes and stamps them), the synthetic-or-empty key, and the Jev
 * endpoint override ('' = cleared, so the outage flows hit the REAL blocked endpoint).
 */
function seedPayload(options: { key: string | null; endpointOverride: string | null; jevForTargets?: boolean }): Record<string, unknown> {
  return {
    settings: {
      enabled: true,
      autoAnalyze: true,
      jevForDrafts: true,
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
 * The overlay summary a flow recorded. The surface is COLLAPSED-FIRST (M5): `pillPresent` is the
 * default state while typing, `expanded` only after an explicit pill click, and `present` false
 * when NO extension UI is rendered at all (empty / below-minimum draft).
 */
function overlayOf(outcome: FlowOutcome): Record<string, unknown> {
  return (outcome['overlay'] as Record<string, unknown>) ?? {};
}

/**
 * The collapsed-first invariant every scored-draft overlay summary must satisfy (VAL-DRAFT-032):
 * before the pill click the ONLY surface was a compact pill carrying the headline number alone,
 * with no detail panel in the DOM.
 */
function collapsedFirstViolation(overlay: Record<string, unknown>): string | null {
  const collapsed = (overlay['collapsed'] as Record<string, unknown> | null) ?? null;
  if (collapsed === null) return 'the collapsed pill state was never observed before the expansion';
  if (collapsed['present'] !== true) return 'the collapsed score pill is missing while a draft is scored';
  if (collapsed['panelPresent'] !== false) return 'the detail panel was already rendered while typing';
  if (collapsed['headlineOnly'] !== true) return `the pill shows more than the headline number: "${String(collapsed['text'])}"`;
  if (overlay['state'] !== 'analyzed') return `expanded panel state: ${String(overlay['state'])}`;
  if (overlay['expanded'] !== true) return 'the pill click did not expand the detail panel';
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
      if (overlay['present'] !== false || overlay['pillPresent'] !== false) return `overlay: ${JSON.stringify(overlay)}`;
      return null;
    },
  },
  {
    name: 'short-draft-empty-state',
    arg: { seed: seedPayload({ key: null, endpointOverride: null }), texts: { short: 'Too short' } },
    expect: (outcome): string | null => {
      // Below minDraftLength NOTHING is rendered: no host, no pill, no panel (VAL-DRAFT-005).
      const overlay = overlayOf(outcome);
      if (overlay['present'] !== false) return `overlay UI below the minimum length: ${JSON.stringify(overlay)}`;
      if (overlay['pillPresent'] !== false || overlay['expanded'] !== false) {
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
      const overlay = overlayOf(outcome);
      const collapsed = collapsedFirstViolation(overlay);
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
      const collapsed = collapsedFirstViolation(overlay);
      if (collapsed !== null) return collapsed;
      if (overlay['headlineSource'] !== 'local') return `headline source: ${String(overlay['headlineSource'])}`;
      if (overlay['jevState'] !== 'no-key') return `jev state: ${String(overlay['jevState'])}`;
      if (Number(overlay['signals']) < 1) return `signals: ${String(overlay['signals'])}`;
      const headline = Number(overlay['headline']);
      if (!(headline >= 0 && headline <= 100)) return `headline out of range: ${String(overlay['headline'])}`;
      // The collapsed pill's number and the expanded panel's headline are the same local score.
      const collapsedText = String((overlay['collapsed'] as Record<string, unknown> | null)?.['text'] ?? '');
      if (collapsedText !== String(overlay['headline'])) {
        return `collapsed pill "${collapsedText}" != expanded headline "${String(overlay['headline'])}"`;
      }
      return null;
    },
  },
  {
    name: 'both-surfaces',
    arg: { seed: seedPayload({ key: null, endpointOverride: null }), texts: { both: 'Both surfaces draft: the composer and the timeline badges coexist peacefully here.' } },
    expect: (outcome): string | null => {
      const overlay = overlayOf(outcome);
      const collapsed = collapsedFirstViolation(overlay);
      if (collapsed !== null) return collapsed;
      if (outcome['likeClickReachedPage'] !== true) return 'the native like click never reached the page (surface blocked it)';
      const post1 = badgeFor(outcome, POST_1_ID);
      if (post1 === null) return 'no badge on the question post (post 1)';
      if (typeof post1['reason'] !== 'string' || post1['reason'] === '') return 'post-1 badge has no reason';
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
      if (pending['jevPendingText'] !== 'Analyzing with AI…') return `pending copy: ${String(pending['jevPendingText'])}`;
      const settled = (outcome['settled'] as Record<string, unknown>) ?? {};
      if (settled['jevState'] !== 'verdict') return `settled jev state: ${String(settled['jevState'])}`;
      if (settled['headlineSource'] !== 'hybrid') return `settled headline source: ${String(settled['headlineSource'])}`;
      if (String(settled['jevBand'] ?? '').length === 0) return 'settled band missing';
      if (!String(settled['jevConfidence'] ?? '').includes('65')) return `settled confidence: ${String(settled['jevConfidence'])}`;
      // The re-collapsed pill sampled AFTER the verdict carries the hybrid headline — the
      // field-comparable number this flow contributes to the cross-browser score comparison.
      const settledCollapsed = (settled['collapsed'] as Record<string, unknown> | null) ?? null;
      if (settledCollapsed === null || String(settledCollapsed['text']) !== String(settled['headline'])) {
        return `settled collapsed pill: ${JSON.stringify(settledCollapsed)}`;
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
      if (before['overlayPresent'] !== true || before['pillPresent'] !== true) {
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
      if (!String(overlay['jevNotice'] ?? '').includes('local signals still apply')) return `degraded notice: ${String(overlay['jevNotice'])}`;
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
      if (!String(popover['aiErrorReason'] ?? '').includes('Could not reach the AI service.')) {
        return `popover error reason: ${String(popover['aiErrorReason'])}`;
      }
      if (typeof popover['localScore'] !== 'string' || popover['localScore'] === '') return 'popover local score missing under outage';
      return null;
    },
  },
];

/** Fields logged as evidence but excluded from strict cross-browser equality. */
export function stripVolatile(outcome: FlowOutcome): FlowOutcome {
  const clone = structuredClone(outcome) as FlowOutcome;
  const badges = clone['badges'];
  if (Array.isArray(badges)) {
    for (const badge of badges as Array<Record<string, unknown>>) delete badge['score'];
  }
  delete clone['mockCalls']; // call-log reads race with in-flight slow exchanges by ±1 entry
  // `collapsed.text` (the pill's headline number) IS compared: the driver samples it only after
  // the pill's AI half has settled, so the number is deterministic for the draft (local when no
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
