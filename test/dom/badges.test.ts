import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { MARKER_HOST_ID } from '../../src/dom/marker';
import { scoreTarget } from '../../src/core/heuristic-engine';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/settings-store';
import type { TargetAnalysisResult } from '../../src/core/target-analysis';
import { BADGE_HOST_ATTRIBUTE, createTimelineScanner } from '../../src/dom/timeline-scanner';
import {
  BADGE_COPY,
  BADGE_TESTID,
  BADGE_TESTIDS,
  POPOVER_HOST_ID,
  POPOVER_TESTIDS,
  createTargetBadges,
} from '../../src/dom/badges';
import { badgeReason, isBadgeEligible } from '../../src/dom/badges/view-model';
import { extractPostSnapshot } from '../../src/dom/timeline-scanner';
import { FIXTURE_POSTS, renderFixtureHtml, renderPost } from '../fixtures/x-fixture';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const THROTTLE_MS = 25;
const waitThrottle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, THROTTLE_MS * 3));

const POST_ID = (index: number): string => FIXTURE_POSTS[index]!.id;

interface HarnessOptions {
  settings?: Partial<Settings>;
  keyPresent?: boolean;
  deepAnalysis?: (post: { id: string }) => Promise<TargetAnalysisResult>;
}

interface Harness {
  settings: Settings;
  setSettings(update: Partial<Settings>): void;
  onSettingsChanged(): void;
  deepAnalysisCalls: { id: string }[];
  resolveDeepAnalysis: ((result: TargetAnalysisResult) => void)[];
  openOptionsCalls: number;
  badgeHosts: () => HTMLElement[];
  badgeOf: (id: string) => HTMLElement | null;
  badgeCount: () => number;
  popover: () => HTMLElement | null;
  clickBadge: (id: string) => void;
  teardown(): void;
}

/** Badge content lives in each host's SHADOW root — light-DOM queries cannot see it. */
function badgeInShadow(host: Element, id?: string): HTMLElement | null {
  const selector = id === undefined ? `[data-testid="${BADGE_TESTID}"]` : `[data-testid="${BADGE_TESTID}"][data-amplifyx-post-id="${id}"]`;
  return host.shadowRoot?.querySelector<HTMLElement>(selector) ?? null;
}

function startHarness(options: HarnessOptions = {}): Harness {
  document.body.innerHTML = renderFixtureHtml(NOW);
  const marker = document.createElement('div');
  marker.id = MARKER_HOST_ID;
  document.body.append(marker);

  // Guaranteed teardown even when a test throws mid-way: a leaked live scanner would keep
  // repainting badge hosts into every later test's DOM (its MutationObserver survives the
  // body.innerHTML reset — the body ELEMENT itself is never replaced).
  onTestFinished(() => {
    scanner.stop();
    badges.destroy();
  });

  const harness: Harness = {
    settings: { ...DEFAULT_SETTINGS, ...options.settings },
    setSettings(update) {
      harness.settings = { ...harness.settings, ...update };
    },
    onSettingsChanged() {
      badges.onSettingsChanged();
    },
    deepAnalysisCalls: [],
    resolveDeepAnalysis: [],
    openOptionsCalls: 0,
    badgeHosts: () => [...document.querySelectorAll<HTMLElement>(`[${BADGE_HOST_ATTRIBUTE}="badge"]`)],
    badgeOf(id) {
      for (const host of document.querySelectorAll(`[${BADGE_HOST_ATTRIBUTE}="badge"]`)) {
        const badge = badgeInShadow(host, id);
        if (badge) return badge;
      }
      return null;
    },
    badgeCount() {
      let count = 0;
      for (const host of document.querySelectorAll(`[${BADGE_HOST_ATTRIBUTE}="badge"]`)) count += badgeInShadow(host) ? 1 : 0;
      return count;
    },
    popover: () => document.getElementById(POPOVER_HOST_ID)?.shadowRoot?.querySelector<HTMLElement>(`[data-testid="${POPOVER_TESTIDS.panel}"]`) ?? null,
    clickBadge(id) {
      harness.badgeOf(id)?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    },
    teardown() {
      scanner.stop();
      badges.destroy();
    },
  };

  const scanner = createTimelineScanner({
    doc: document,
    throttleMs: THROTTLE_MS,
    now: () => NOW,
    // The harness stacks the fixture vertically; viewport visibility is E2E territory (like the
    // scanner's own DOM harness, all articles count as visible here).
    isArticleVisible: () => true,
  });
  const badges = createTargetBadges({
    getSettings: () => harness.settings,
    getKeyPresence: () => options.keyPresent ?? false,
    requestDeepAnalysis: (post) => {
      harness.deepAnalysisCalls.push({ id: post.id });
      if (options.deepAnalysis) return options.deepAnalysis(post);
      return new Promise<TargetAnalysisResult>((resolve) => harness.resolveDeepAnalysis.push(resolve));
    },
    openOptions: () => {
      harness.openOptionsCalls += 1;
    },
  });
  scanner.onScan((event) => badges.onScan(event));
  scanner.start();
  badges.start();
  return harness;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('badge eligibility and content (VAL-TARGET-005/006, DOM tier)', () => {
  it('gates the pure scorer + threshold: eligible at the boundary, ineligible and below-threshold excluded', () => {
    document.body.innerHTML = renderPost(FIXTURE_POSTS[0]!, NOW);
    const article = document.querySelector('article')!;
    const score = scoreTarget(extractPostSnapshot(article, { now: NOW })!);
    expect(score.eligible).toBe(true);
    expect(isBadgeEligible(score, score.headline)).toBe(true); // >= threshold (at the boundary)
    expect(isBadgeEligible(score, score.headline + 1)).toBe(false); // strictly above -> no badge
    expect(isBadgeEligible({ ...score, eligible: false, headline: 0 }, 0)).toBe(false);
  });

  it('renders badges only for posts at or above the threshold, each with score + English reason', async () => {
    const harness = startHarness();
    await waitThrottle();

    // Post 1 (question, verified, followed, high velocity) is comfortably above 70.
    const badge = harness.badgeOf(POST_ID(0));
    expect(badge).not.toBeNull();
    const scoreText = badge!.querySelector(`[data-testid="${BADGE_TESTIDS.score}"]`)!.textContent ?? '';
    const score = Number(scoreText);
    expect(score).toBeGreaterThanOrEqual(70);
    const reason = badge!.querySelector(`[data-testid="${BADGE_TESTIDS.reason}"]`)!.textContent ?? '';
    expect(reason.trim()).not.toBe('');
    expect(reason).toMatch(/^[A-Za-z]/); // English

    // Stale (48h+), out-of-network reply, no-engagement, and bait posts stay badgeless.
    for (const index of [3, 4, 6, 8]) {
      expect(harness.badgeOf(POST_ID(index))).toBeNull();
    }
    harness.teardown();
  });

  it('derives the reason from the top contributing signal (deterministic tie-break)', () => {
    document.body.innerHTML = renderFixtureHtml(NOW);
    const article = document.querySelector('article')!; // post 1: velocity (+14) is the top signal
    const score = scoreTarget(extractPostSnapshot(article, { now: NOW })!);
    expect(badgeReason(score)).toBe(BADGE_COPY.reasons.velocity);
  });

  it('never duplicates hosts or badges across repeated scan passes', async () => {
    const harness = startHarness();
    await waitThrottle();
    await waitThrottle(); // a second full pass over the same visible posts
    const hostCounts = harness.badgeHosts().map((host) => (badgeInShadow(host) ? 1 : 0));
    expect(hostCounts.length).toBeGreaterThan(0);
    expect(hostCounts.every((count) => count <= 1)).toBe(true);
    expect(harness.badgeCount()).toBe(harness.badgeHosts().filter((host) => badgeInShadow(host) !== null).length);
    harness.teardown();
  });

  it('clears badges on the next scan after the threshold rises above every post', async () => {
    const harness = startHarness();
    await waitThrottle();
    expect(harness.badgeHosts().length).toBeGreaterThan(0);
    harness.setSettings({ targetThreshold: 100 });
    harness.onSettingsChanged();
    scannerRescan();
    await waitThrottle();
    expect(harness.badgeCount()).toBe(0);

    function scannerRescan(): void {
      // The content script triggers the scanner's rescan on a threshold change; in this harness a
      // DOM mutation is enough to schedule a pass.
      document.body.append(document.createElement('div'));
    }
  });
});

describe('popover interactions (VAL-TARGET-014/015/016, DOM tier)', () => {
  it('opens with the matching post id, score and breakdown; badge click does not bubble to the article', async () => {
    const harness = startHarness();
    await waitThrottle();

    const bubbled: string[] = [];
    document.addEventListener('click', (event) => {
      bubbled.push((event.target as Element).localName);
    });

    harness.clickBadge(POST_ID(0));
    const panel = harness.popover();
    expect(panel).not.toBeNull();
    expect(bubbled).toEqual([]); // click isolation: the badge swallowed the event
    expect(panel!.dataset.amplifyxPostId).toBe(POST_ID(0));
    expect(panel!.getAttribute('data-amplifyx-post-id')).toBe(POST_ID(0));
    const scoreInPopover = Number(panel!.querySelector(`[data-testid="${POPOVER_TESTIDS.localScore}"]`)!.textContent);
    const scoreOnBadge = Number(harness.badgeOf(POST_ID(0))!.querySelector(`[data-testid="${BADGE_TESTIDS.score}"]`)!.textContent);
    expect(scoreInPopover).toBe(scoreOnBadge);
    expect(panel!.querySelectorAll(`[data-testid="${POPOVER_TESTIDS.signals}"] li`).length).toBeGreaterThan(3);
    harness.teardown();
  });

  it('closes via the close control and via Escape, leaving no popover behind', async () => {
    const harness = startHarness();
    await waitThrottle();

    harness.clickBadge(POST_ID(0));
    expect(harness.popover()).not.toBeNull();
    document
      .getElementById(POPOVER_HOST_ID)!
      .shadowRoot!.querySelector(`[data-testid="${POPOVER_TESTIDS.close}"]`)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(harness.popover()).toBeNull();

    harness.clickBadge(POST_ID(0));
    expect(harness.popover()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(harness.popover()).toBeNull();
    harness.teardown();
  });

  it('keeps exactly one popover host and switches content when another badge opens', async () => {
    const harness = startHarness();
    await waitThrottle();
    harness.clickBadge(POST_ID(0));
    harness.clickBadge(POST_ID(7)); // pedro_pm (81, also above threshold)
    expect(document.querySelectorAll(`#${POPOVER_HOST_ID}`).length).toBe(1);
    expect(harness.popover()!.getAttribute('data-amplifyx-post-id')).toBe(POST_ID(7));
    harness.teardown();
  });

  it('keeps the host pointer-inert outside its own buttons (AGENTS.md overlay rule)', async () => {
    const harness = startHarness();
    await waitThrottle();
    harness.clickBadge(POST_ID(0));
    const host = document.getElementById(POPOVER_HOST_ID)!;
    expect(host.style.pointerEvents).toBe('none');
    // The panel is pointer-inert by stylesheet; its own buttons re-enable hits (AGENTS.md rule).
    const styleText = host.shadowRoot!.querySelector('style')!.textContent ?? '';
    expect(styleText).toContain('.panel { pointer-events: none; }');
    expect(styleText).toContain('pointer-events: auto');
    harness.teardown();
  });
});

describe('Deep analysis states (VAL-TARGET-017/018/020, VAL-SETUP-012, DOM tier)', () => {
  it('with jevForTargets off: local badges render and Deep analysis is unavailable (no dispatch)', async () => {
    const harness = startHarness({ settings: { jevForTargets: false } });
    await waitThrottle();
    harness.clickBadge(POST_ID(0));
    const panel = harness.popover()!;
    expect(panel.querySelector(`[data-testid="${POPOVER_TESTIDS.aiSection}"]`)!.getAttribute('data-ai-state')).toBe('off');
    expect(panel.querySelector(`[data-testid="${POPOVER_TESTIDS.deepAnalysis}"]`)).toBeNull();
    expect(harness.deepAnalysisCalls).toEqual([]);
    harness.teardown();
  });

  it('idle -> pending -> verdict: exactly one dispatch per post, verdict rendered (band + confidence)', async () => {
    const harness = startHarness({ settings: { jevForTargets: true }, keyPresent: true });
    await waitThrottle();
    harness.clickBadge(POST_ID(0));
    let panel = harness.popover()!;
    expect(panel.querySelector(`[data-testid="${POPOVER_TESTIDS.deepAnalysis}"]`)).not.toBeNull();

    panel.querySelector(`[data-testid="${POPOVER_TESTIDS.deepAnalysis}"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    panel = harness.popover()!;
    expect(panel.querySelector(`[data-testid="${POPOVER_TESTIDS.aiSection}"]`)!.getAttribute('data-ai-state')).toBe('pending');

    harness.resolveDeepAnalysis.shift()!({
      kind: 'analyzed',
      verdict: { ordinal: 4.2, confidence: 0.7, band: 'strong', strengths: [], weaknesses: [], suggestions: [] },
      angle: { choice: 'share_experience', label: 'Share a short first-hand experience.', confidence: 0.8 },
      source: 'fresh',
    });
    await Promise.resolve();
    await Promise.resolve();
    panel = harness.popover()!;
    const ai = panel.querySelector(`[data-testid="${POPOVER_TESTIDS.aiSection}"]`)!;
    expect(ai.getAttribute('data-ai-state')).toBe('verdict');
    expect(panel.querySelector(`[data-testid="${POPOVER_TESTIDS.verdictBand}"]`)!.textContent).toBe('Strong');
    expect(panel.querySelector(`[data-testid="${POPOVER_TESTIDS.verdictConfidence}"]`)!.textContent).toContain('70%');
    expect(panel.querySelector(`[data-testid="${POPOVER_TESTIDS.verdictAngle}"]`)!.textContent).toContain('first-hand');
    expect(harness.deepAnalysisCalls).toEqual([{ id: POST_ID(0) }]);
    harness.teardown();
  });

  it('caches per post: close/reopen + second activation makes no further dispatch; another post does', async () => {
    const harness = startHarness({ settings: { jevForTargets: true }, keyPresent: true });
    await waitThrottle();

    const analyzeFirst = async (): Promise<void> => {
      harness.clickBadge(POST_ID(0));
      harness
        .popover()!
        .querySelector(`[data-testid="${POPOVER_TESTIDS.deepAnalysis}"]`)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      harness.resolveDeepAnalysis.shift()!({
        kind: 'analyzed',
        verdict: { ordinal: 4, confidence: 0.7, band: 'strong', strengths: [], weaknesses: [], suggestions: [] },
        source: 'cache',
      });
      await Promise.resolve();
      await Promise.resolve();
    };
    await analyzeFirst();
    expect(harness.deepAnalysisCalls).toEqual([{ id: POST_ID(0) }]);

    // Close, reopen: the in-memory verdict answers WITHOUT any Deep analysis button or dispatch.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    harness.clickBadge(POST_ID(0));
    const reopened = harness.popover()!;
    expect(reopened.querySelector(`[data-testid="${POPOVER_TESTIDS.aiSection}"]`)!.getAttribute('data-ai-state')).toBe('verdict');
    expect(reopened.querySelector(`[data-testid="${POPOVER_TESTIDS.deepAnalysis}"]`)).toBeNull();
    expect(harness.deepAnalysisCalls).toEqual([{ id: POST_ID(0) }]);

    // A different post gets its own first dispatch.
    harness.clickBadge(POST_ID(7));
    harness
      .popover()!
      .querySelector(`[data-testid="${POPOVER_TESTIDS.deepAnalysis}"]`)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    expect(harness.deepAnalysisCalls).toEqual([{ id: POST_ID(0) }, { id: POST_ID(7) }]);
    harness.teardown();
  });

  it('shows a recoverable error state on failure: notice + Try again re-dispatches; popover stays closable', async () => {
    const harness = startHarness({ settings: { jevForTargets: true }, keyPresent: true });
    await waitThrottle();
    harness.clickBadge(POST_ID(0));
    harness
      .popover()!
      .querySelector(`[data-testid="${POPOVER_TESTIDS.deepAnalysis}"]`)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    harness.resolveDeepAnalysis.shift()!({ kind: 'error', failure: { kind: 'http-error', status: 500 } });
    await Promise.resolve();
    await Promise.resolve();

    const panel = harness.popover()!;
    const ai = panel.querySelector(`[data-testid="${POPOVER_TESTIDS.aiSection}"]`)!;
    expect(ai.getAttribute('data-ai-state')).toBe('error');
    expect(panel.querySelector(`[data-testid="${POPOVER_TESTIDS.aiNotice}"]`)!.textContent).toContain('Deep analysis failed.');
    expect(panel.querySelector(`[data-testid="${POPOVER_TESTIDS.aiErrorReason}"]`)!.textContent).toMatch(/HTTP 500/);
    const retry = panel.querySelector(`[data-testid="${POPOVER_TESTIDS.retry}"]`)!;
    retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    expect(harness.deepAnalysisCalls).toEqual([{ id: POST_ID(0) }, { id: POST_ID(0) }]);
    expect(harness.popover()!.querySelector(`[data-testid="${POPOVER_TESTIDS.aiSection}"]`)!.getAttribute('data-ai-state')).toBe('pending');

    // The popover remains closable throughout (no uncaught errors, no stuck overlay).
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(harness.popover()).toBeNull();
    harness.teardown();
  });

  it('shows the Connect Jev state when no key is configured, routing to Options', async () => {
    const harness = startHarness({ settings: { jevForTargets: true }, keyPresent: false });
    await waitThrottle();
    harness.clickBadge(POST_ID(0));
    const panel = harness.popover()!;
    expect(panel.querySelector(`[data-testid="${POPOVER_TESTIDS.aiSection}"]`)!.getAttribute('data-ai-state')).toBe('no-key');
    panel.querySelector(`[data-testid="${POPOVER_TESTIDS.connectJev}"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(harness.openOptionsCalls).toBe(1);
    harness.teardown();
  });

  it('live settings precedence: flipping jevForTargets off hides a settled verdict immediately', async () => {
    const harness = startHarness({ settings: { jevForTargets: true }, keyPresent: true });
    await waitThrottle();
    harness.clickBadge(POST_ID(0));
    harness
      .popover()!
      .querySelector(`[data-testid="${POPOVER_TESTIDS.deepAnalysis}"]`)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    harness.resolveDeepAnalysis.shift()!({
      kind: 'analyzed',
      verdict: { ordinal: 4, confidence: 0.7, band: 'strong', strengths: [], weaknesses: [], suggestions: [] },
      source: 'fresh',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.popover()!.querySelector(`[data-testid="${POPOVER_TESTIDS.aiSection}"]`)!.getAttribute('data-ai-state')).toBe('verdict');

    harness.setSettings({ jevForTargets: false });
    harness.onSettingsChanged();
    const ai = harness.popover()!.querySelector(`[data-testid="${POPOVER_TESTIDS.aiSection}"]`)!;
    expect(ai.getAttribute('data-ai-state')).toBe('off');
    harness.teardown();
  });
});

describe('scan-event repaint (VAL-TARGET-008, DOM tier)', () => {
  it('re-renders the badge on the CURRENT article when its subtree is replaced', async () => {
    const harness = startHarness();
    await waitThrottle();
    const before = harness.badgeOf(POST_ID(0))!;
    expect(before).not.toBeNull();

    // x.com re-renders the article subtree (same status URL): the host goes with it and the
    // scanner re-creates both.
    const article = document.querySelector('article')!;
    const cell = renderPost(FIXTURE_POSTS[0]!, NOW);
    article.innerHTML = cell.slice(cell.indexOf('>', cell.indexOf('<article')) + 1, cell.lastIndexOf('</article>'));
    await waitThrottle();
    const after = harness.badgeOf(POST_ID(0));
    expect(after).not.toBeNull();
    const matching = harness
      .badgeHosts()
      .filter((host) => badgeInShadow(host, POST_ID(0)) !== null).length;
    expect(matching).toBe(1);
    harness.teardown();
  });
});

describe('master lifecycle', () => {
  it('stop() removes every badge and closes the popover; start() allows rendering again', async () => {
    const harness = startHarness();
    await waitThrottle();
    harness.clickBadge(POST_ID(0));
    expect(harness.popover()).not.toBeNull();
    harness.teardown(); // scanner.stop + badges.destroy
    expect(document.querySelectorAll(`[${BADGE_HOST_ATTRIBUTE}="badge"]`).length).toBe(0);
    expect(harness.badgeCount()).toBe(0);
    expect(harness.popover()).toBeNull();
  });
});

describe('view-model helpers', () => {
  it('badgeReason falls back to the eligibility line when no signal applied points', async () => {
    document.body.innerHTML = renderFixtureHtml(NOW);
    const article = document.querySelector('article')!;
    const snapshot = extractPostSnapshot(article, { now: NOW })!;
    const quiet = scoreTarget({ ...snapshot, likeCount: 0, replyCount: 0, repostCount: 0, verified: false, inNetwork: false, text: 'plain statement' });
    expect(badgeReason(quiet)).toBe(BADGE_COPY.reasons.eligibility);
  });

  it('scan events carry the host the badge layer paints into', async () => {
    const harness = startHarness();
    await waitThrottle();
    expect(harness.badgeHosts().length).toBeGreaterThan(0);
    // Every host the badge layer PAINTED has a shadow root (cleared hosts may stay inert).
    expect(harness.badgeOf(POST_ID(0))!.getRootNode()).toBe(harness.badgeHosts()[0]!.shadowRoot ?? expect.anything());
    const painted = harness.badgeHosts().find((host) => badgeInShadow(host) !== null);
    expect(painted?.shadowRoot).not.toBeNull();
    harness.teardown();
  });
});
