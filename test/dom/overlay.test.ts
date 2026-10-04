import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAFT_DEBOUNCE_MS } from '../../src/core/draft-snapshot';
import { scoreDraft, composeHeadline, mapJevBand, type JevVerdict } from '../../src/core/heuristic-engine';
import { draftCacheKey } from '../../src/core/jev-client/hash';
import { WEAKNESS_LABELS } from '../../src/core/jev-client/config';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/settings-store';
import type { DraftAnalysis, DraftAnalysisResult } from '../../src/core/analyzer';
import type { AnalysisDispatch, DraftEvent } from '../../src/dom/composer-watcher';
import { createComposerWatcher } from '../../src/dom/composer-watcher';
import {
  OVERLAY_HOST_ID,
  OVERLAY_PILL_TESTID,
  OVERLAY_TESTID,
  createScoreOverlay,
  clampPillClearOfControl,
  computeAnchorPosition,
  computePillPosition,
  type ScoreOverlay,
} from '../../src/dom/overlay';

/**
 * ScoreOverlay DOM tier, M5 COLLAPSED-FIRST model: the compact pill is the default surface, the
 * detail panel exists only after an explicit pill click, no qualifying draft renders NO extension
 * UI at all, and the panel collapses on outside click (not forwarded to the page), on Escape and
 * on any new composer edit. Every pre-existing guarantee (local-before-Jev, the six algorithm
 * signals, the band table, stale discard, no-key/off/failure notices, per-draft transport-failure
 * ownership, clear-reset, settings teardown/remount, English-only copy) is re-pinned at its new
 * location — the PILL for the headline, the EXPANDED PANEL for everything else.
 */

const HOME_HTML = `
<div id="react-root">
<div data-testid="primaryColumn">
  <div data-testid="toolBar">
    <div data-testid="tweetTextarea_0RichTextInputContainer">
      <div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" class="public-DraftEditor-content"></div>
    </div>
    <button type="button" data-testid="addMedia">midia</button>
    <button type="button" data-testid="tweetButtonInline" aria-disabled="true">Postar</button>
  </div>
</div>
</div>`;

const REPLY_VIEW_HTML = `
<div data-testid="primaryColumn">
  <div data-testid="replyComposerContainer">
    <div dir="ltr"><span>Respondendo a </span><a href="/ana_builds" role="link">@ana_builds</a></div>
    <div data-testid="tweetTextarea_1RichTextInputContainer">
      <div data-testid="tweetTextarea_1" role="textbox" contenteditable="true" class="public-DraftEditor-content"></div>
    </div>
    <button type="button" data-testid="tweetButton" aria-disabled="false">Responder</button>
  </div>
</div>`;

const HOST_SELECTOR = `#${OVERLAY_HOST_ID}`;

/** The active textbox (never the *RichTextInputContainer wrapper sharing the testid prefix). */
function composer(): Element {
  return (document.querySelector('[data-testid="tweetTextarea_1"]') ??
    document.querySelector('[data-testid="tweetTextarea_0"]'))!;
}

/**
 * A bubbling click whose `composed` flag survived happy-dom's normalization. Used for every
 * click INSIDE the overlay's shadow DOM (the pill, the panel's own buttons): happy-dom drops
 * `composed` on a click init object, and the overlay's "is this click mine?" check relies on
 * composedPath crossing the shadow boundary — exactly as it does in a real browser.
 */
function clickInside(target: HTMLElement): void {
  target.dispatchEvent(new Event('click', { bubbles: true, composed: true }));
}

function typeText(element: Element, text: string): void {
  element.replaceChildren();
  const line = document.createElement('div');
  line.textContent = text;
  element.append(line);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

async function settleCapture(): Promise<void> {
  await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
}

/**
 * Drains a tick after DOM surgery: the overlay mounts its host inside the watcher's scan tick,
 * and a 0ms rescan timer created from that tick's mutation callback only fires on a LATER
 * nonzero clock advance under vitest's fake timers (a test-harness quirk; real browsers have
 * no such boundary). Advancing 1ms flushes the watcher's post-mount rescan.
 */
async function settleDom(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1);
}

interface Harness {
  overlay: ScoreOverlay;
  requests: AnalysisDispatch[];
  draftEvents: DraftEvent[];
  optionsOpened: number;
  setKeyPresent(present: boolean): void;
  pushSettings(partial: Partial<Settings>, revision?: number): Promise<void>;
  reply(result: DraftAnalysisResult, request?: AnalysisDispatch): void;
  replyFor(request: AnalysisDispatch, overrides?: ReplyOverrides): void;
  failTransport(request?: AnalysisDispatch): void;
  /** The collapsed pill (the default surface). Throws when no UI is rendered at all. */
  pill(): HTMLElement;
  /** Clicks the pill to expand the detail panel, and returns the panel. */
  expand(): HTMLElement;
  /** The expanded panel, WITHOUT expanding (throws when collapsed, as production would). */
  panel(): HTMLElement;
  /** Collapses the panel the way a user's Escape does, then returns the pill. */
  collapseNow(): HTMLElement;
  /** Tears the harness down (stops the watcher and destroys the overlay). */
  teardown(): void;
  host(): HTMLElement | null;
  /** True while the panel is expanded. */
  isExpanded(): boolean;
}

interface ReplyOverrides {
  /** Explicitly `undefined` means "this analysis produced no verdict" (skipped/failed halves). */
  jev?: JevVerdict;
  jevStatus?: DraftAnalysis['meta']['jevStatus'];
  jevFailure?: DraftAnalysis['meta']['jevFailure'];
  analyzedAt?: number;
}

function shadowOf<T extends HTMLElement>(testid: string): T | null {
  return (
    document
      .querySelector<HTMLElement>(HOST_SELECTOR)
      ?.shadowRoot?.querySelector<T>(`[data-testid="${testid}"]`) ?? null
  );
}

/**
 * Every harness built by `startHarness`, so `afterEach` can stop its watcher and destroy its
 * overlay: a leaked overlay keeps DOCUMENT-level capture listeners (the expanded-state outside
 * click) alive and would intercept the next test's page clicks.
 */
const harnesses: Harness[] = [];

function startHarness(overrides: { settings?: Partial<Settings>; keyPresent?: boolean } = {}): Harness {
  document.body.innerHTML = HOME_HTML;
  const settings: Settings = { ...DEFAULT_SETTINGS, ...overrides.settings };
  let keyPresent = overrides.keyPresent ?? true;
  const requests: AnalysisDispatch[] = [];
  const draftEvents: DraftEvent[] = [];
  let optionsOpened = 0;

  const overlay = createScoreOverlay({
    getKeyPresence: () => keyPresent,
    requestAnalysis: () => watcher.requestAnalysis(),
    openOptions: () => {
      optionsOpened += 1;
    },
  });
  const watcher = createComposerWatcher({
    getMinDraftLength: () => settings.minDraftLength,
    getAutoAnalyze: () => settings.autoAnalyze,
    dispatchAnalysis: (dispatch) => {
      requests.push(dispatch);
      overlay.onAnalysisDispatched(dispatch.snapshot);
    },
  });
  watcher.onDraft((event) => {
    draftEvents.push(event);
    overlay.onDraftCaptured(event);
  });
  watcher.onComposerChange((event) => overlay.onComposerChange(event));

  overlay.onSettings(settings, 1);
  watcher.start();

  const harness: Harness = {
    overlay,
    requests,
    draftEvents,
    get optionsOpened() {
      return optionsOpened;
    },
    setKeyPresent(present: boolean) {
      keyPresent = present;
    },
    // Mirrors the content script: the master switch also stops/starts the watcher.
    async pushSettings(partial: Partial<Settings>, revision?: number) {
      const wasEnabled = settings.enabled;
      Object.assign(settings, partial);
      overlay.onSettings({ ...settings }, revision);
      if (!settings.enabled) {
        watcher.stop();
      } else if (!wasEnabled) {
        watcher.start();
        // The first (re)scan is timer-scheduled: drain it so later DOM changes rescan cleanly.
        await vi.advanceTimersByTimeAsync(1);
      }
    },
    reply(result: DraftAnalysisResult, request?: AnalysisDispatch) {
      if (request) overlay.onAnalysisResult(result, request.snapshot);
      else overlay.onAnalysisResult(result);
    },
    replyFor(request: AnalysisDispatch, overrides: ReplyOverrides = {}) {
      const local = scoreDraft(request.snapshot);
      const defaultVerdict: JevVerdict = {
        ordinal: 3.44,
        confidence: 0.65,
        band: 'moderate',
        strengths: [],
        weaknesses: [WEAKNESS_LABELS.not_specific_enough],
        suggestions: [],
      };
      const verdict = 'jev' in overrides ? (overrides.jev ?? null) : defaultVerdict;
      const jevStatus = overrides.jevStatus ?? (verdict ? ('ok' as const) : 'skipped-no-key');
      overlay.onAnalysisResult({
        kind: 'analyzed',
        local,
        ...(verdict ? { jev: verdict } : {}),
        meta: {
          analyzedAt: overrides.analyzedAt ?? 1_700_000_000_000,
          trigger: request.trigger,
          draftHash: draftCacheKey(request.snapshot),
          headline: verdict ? composeHeadline(local.headline, verdict.ordinal) : local.headline,
          jevStatus,
          ...(overrides.jevFailure ? { jevFailure: overrides.jevFailure } : {}),
        },
      });
    },
    failTransport(request?: AnalysisDispatch) {
      // Mirrors the content script: the failing dispatch carries its own snapshot identity.
      const target = request ?? requests.at(-1)!;
      overlay.onAnalysisFailed(target.snapshot);
    },
    pill(): HTMLElement {
      const pill = shadowOf(OVERLAY_PILL_TESTID);
      if (!pill) throw new Error('the score pill is not rendered');
      return pill;
    },
    expand(): HTMLElement {
      if (shadowOf(OVERLAY_TESTID) === null) clickInside(this.pill());
      const panel = shadowOf(OVERLAY_TESTID);
      if (!panel) throw new Error('the pill click did not expand the detail panel');
      return panel;
    },
    panel(): HTMLElement {
      const panel = shadowOf(OVERLAY_TESTID);
      if (!panel) throw new Error('the overlay panel is not expanded');
      return panel;
    },
    collapseNow(): HTMLElement {
      pressEscape();
      return this.pill();
    },
    teardown(): void {
      watcher.stop();
      overlay.destroy();
    },
    host(): HTMLElement | null {
      return document.querySelector<HTMLElement>(HOST_SELECTOR);
    },
    isExpanded(): boolean {
      return shadowOf(OVERLAY_TESTID) !== null;
    },
  };
  harnesses.push(harness);
  return harness;
}

const find = (root: ParentNode, testid: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-testid="${testid}"]`);

/** A page element an outside click can land on, with a listener the test can count. */
function pageTarget(testid = 'tweetButtonInline'): { element: HTMLElement; reached: () => number } {
  const element = document.querySelector<HTMLElement>(`[data-testid="${testid}"]`)!;
  let reached = 0;
  element.addEventListener('click', () => {
    reached += 1;
  });
  return { element, reached: () => reached };
}

/** A real bubbling, composed click — what a browser delivers for a user click. */
function clickOutside(target: HTMLElement): void {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const harness of harnesses) {
    harness.overlay.destroy();
  }
  harnesses.length = 0;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('overlay host lifecycle', () => {
  it('renders NO extension UI until a qualifying draft exists', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);

    // VAL-DRAFT-005/032: no draft, no host at all — no pill, no panel, no awaiting balloon.
    expect(harness.host()).toBeNull();
    expect(shadowOf(OVERLAY_PILL_TESTID)).toBeNull();
    expect(shadowOf(OVERLAY_TESTID)).toBeNull();
    expect(find(document, 'overlay-empty')).toBeNull();
  });

  it('mounts exactly one Shadow-DOM host on document.body, outside the React tree', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft long enough to be analyzed');
    await settleCapture();

    const host = harness.host();
    expect(host).not.toBeNull();
    expect(host!.parentElement).toBe(document.body);
    expect(host!.shadowRoot).not.toBeNull();
    // Never inside the React-managed app subtree.
    expect(document.getElementById('react-root')!.contains(host!)).toBe(false);
    expect(document.querySelectorAll(HOST_SELECTOR)).toHaveLength(1);
  });

  it('unmounts when the composer dies after SPA navigation and remounts idempotently', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft long enough to be analyzed');
    await settleCapture();
    expect(harness.host()).not.toBeNull();

    await settleDom(); // flush the watcher's post-mount rescan before surgery
    document.body.innerHTML = '<div data-testid="primaryColumn"><p>timeline only</p></div>';
    await settleDom();
    expect(harness.host()).toBeNull(); // no overlay remains for a dead composer

    document.body.innerHTML = REPLY_VIEW_HTML;
    await settleDom();
    expect(harness.host()).toBeNull(); // a fresh view with no draft renders nothing at all

    typeText(composer(), 'A reply draft that is long enough to score');
    await settleCapture();
    expect(document.querySelectorAll(HOST_SELECTOR)).toHaveLength(1);
    expect(harness.pill()).not.toBeNull(); // fresh view, collapsed pill, no stale score carried
  });

  it('keeps exactly one host across repeated renders and re-attach cycles', async () => {
    startHarness();
    await vi.advanceTimersByTimeAsync(0);
    for (let round = 0; round < 3; round += 1) {
      typeText(composer(), `Draft number ${round} with enough characters`);
      await settleCapture();
      expect(document.querySelectorAll(HOST_SELECTOR)).toHaveLength(1);
    }
  });
});

describe('no extension UI without a qualifying draft (VAL-DRAFT-005, VAL-DRAFT-014)', () => {
  it('renders nothing for an empty draft and nothing for a below-minimum one', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.host()).toBeNull();

    typeText(composer(), '123456789'); // 9 raw chars; default min is 10
    await settleCapture();
    expect(harness.host()).toBeNull();
    expect(shadowOf(OVERLAY_PILL_TESTID)).toBeNull();
    expect(shadowOf(OVERLAY_TESTID)).toBeNull();
    expect(harness.requests).toHaveLength(0);
  });

  it('removes every extension surface when an analyzed draft is cleared', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'An analyzed draft that is long enough');
    await settleCapture();
    harness.replyFor(harness.requests[0]!);
    expect(harness.pill()).not.toBeNull();

    typeText(composer(), '');
    await settleCapture();
    // Neither the pill nor a panel may remain — the composer area is left completely free.
    expect(harness.host()).toBeNull();
    expect(shadowOf(OVERLAY_PILL_TESTID)).toBeNull();
    expect(shadowOf(OVERLAY_TESTID)).toBeNull();
    expect(find(document, 'overlay-gauge')).toBeNull();
    expect(find(document, 'overlay-signals')).toBeNull();
    expect(find(document, 'overlay-jev')).toBeNull();
  });

  it('never renders the removed empty-state balloon', async () => {
    startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'short');
    await settleCapture();
    // The old "type a post" balloon is gone: no such element exists anywhere in the DOM.
    expect(find(document, 'overlay-empty')).toBeNull();
    expect(document.body.textContent).not.toContain('Type a post');
  });
});

describe('collapsed pill and expansion (VAL-DRAFT-032, VAL-DRAFT-034)', () => {
  it('renders only the headline number while typing, with no panel anywhere in the shadow DOM', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'What is the one tool you stopped using this year, and why?');
    await settleCapture();

    const expectedLocal = scoreDraft(harness.draftEvents.at(-1)!.snapshot);
    const pill = harness.pill();
    expect(pill.textContent).toBe(String(expectedLocal.headline));
    expect(pill.textContent).toMatch(/^\d{1,3}$/); // the headline number ALONE
    expect(pill.dataset.headlineSource).toBe('local');
    expect(pill.getAttribute('aria-expanded')).toBe('false');
    expect(pill.getAttribute('aria-label')).toContain(String(expectedLocal.headline));
    // The detail panel is absent — not merely hidden — before the pill is activated.
    expect(shadowOf(OVERLAY_TESTID)).toBeNull();
    const shadow = harness.host()!.shadowRoot!;
    for (const testid of ['overlay-gauge', 'overlay-signals', 'overlay-jev', 'overlay-optimizer']) {
      expect(find(shadow, testid), `${testid} must not exist while collapsed`).toBeNull();
    }
  });

  it('a single pill click expands the full panel with all three sections', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'What changed my year? A daily checklist #focus https://example.com/post');
    await settleCapture();
    expect(harness.isExpanded()).toBe(false);

    const panel = harness.expand();
    expect(panel.dataset.state).toBe('analyzed');
    expect(harness.host()!.dataset.expanded).toBe('true');
    expect(find(panel, 'overlay-gauge')).not.toBeNull(); // score gauge
    expect(find(panel, 'overlay-signals')).not.toBeNull(); // algorithm signals
    expect(find(panel, 'overlay-jev')).not.toBeNull(); // AI judgment
    expect(find(panel, 'overlay-optimizer')).not.toBeNull(); // optimizer
    expect(shadowOf(OVERLAY_PILL_TESTID)).toBeNull(); // the pill is replaced by the panel
  });

  it('keeps the same headline in the pill and in the expanded gauge', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft whose pill and panel headline must agree exactly');
    await settleCapture();
    const pillHeadline = harness.pill().textContent;
    const panel = harness.expand();
    expect(find(panel, 'overlay-headline')!.textContent).toBe(pillHeadline);
  });
});

describe('collapse triggers (VAL-DRAFT-035, VAL-DRAFT-036, VAL-DRAFT-037)', () => {
  it('Escape collapses the panel and keeps the pill with its headline (VAL-DRAFT-035)', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft analyzed before the Escape collapse is exercised');
    await settleCapture();
    const headline = harness.pill().textContent;
    harness.expand();

    pressEscape();
    expect(harness.isExpanded()).toBe(false);
    expect(harness.pill().textContent).toBe(headline); // the pill remains, with the current score
    expect(harness.host()).not.toBeNull();
  });

  it('any new composer edit collapses the panel back to the pill (VAL-DRAFT-036)', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft whose panel is expanded while the user keeps typing');
    await settleCapture();
    harness.replyFor(harness.requests[0]!);
    harness.expand();
    expect(harness.isExpanded()).toBe(true);

    // The edit lands, then the debounce settles the new capture.
    typeText(composer(), 'A draft whose panel is expanded while the user keeps typing further');
    await settleCapture();
    expect(harness.isExpanded()).toBe(false); // collapsed BEFORE/AS the new draft paints
    expect(shadowOf(OVERLAY_TESTID)).toBeNull();
    expect(harness.pill()).not.toBeNull(); // only the pill exists while typing
  });

  it('a first outside click closes the panel WITHOUT reaching the page, the second click reaches it (VAL-DRAFT-037)', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft analyzed before the outside-click collapse');
    await settleCapture();
    harness.expand();

    const target = pageTarget();
    clickOutside(target.element);
    expect(harness.isExpanded()).toBe(false);
    expect(harness.pill()).not.toBeNull();
    expect(target.reached()).toBe(0); // the first outside click is NOT forwarded to the page

    // The next identical click behaves natively: the panel is collapsed, nothing intercepts.
    clickOutside(target.element);
    expect(target.reached()).toBe(1);
    expect(harness.isExpanded()).toBe(false);
  });

  it('a real outside-click GESTURE (pointerdown...click) is captured end to end', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft analyzed before a full outside-click gesture');
    await settleCapture();
    harness.expand();

    const target = pageTarget('addMedia');
    // A browser delivers pointerdown -> mouseup -> click; a handler on the first of those cannot
    // stop the click itself, so the overlay captures the whole gesture.
    target.element.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, composed: true, cancelable: true }),
    );
    target.element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, cancelable: true }));
    clickOutside(target.element);
    expect(harness.isExpanded()).toBe(false);
    expect(target.reached()).toBe(0); // neither the pointer lane nor the click reached the page
  });

  it('the collapsed state swallows nothing: the next click outside the gesture reaches the page', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft whose collapse window must expire for the next click');
    await settleCapture();
    harness.expand();

    const target = pageTarget();
    target.element.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, composed: true, cancelable: true }),
    );
    clickOutside(target.element);
    expect(target.reached()).toBe(0); // the captured gesture never reached the page

    // Outside the captured gesture's window a click behaves natively (VAL-DRAFT-037's "a second,
    // identical click behaves natively"). Vitest's fake timers do not move Date.now() on their own.
    vi.setSystemTime(Date.now() + 1_000);
    clickOutside(target.element);
    expect(target.reached()).toBe(1);
  });

  it('clicks INSIDE the expanded panel are never intercepted', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft whose panel own controls stay interactive');
    await settleCapture();
    const panel = harness.expand();
    let reached = 0;
    panel.addEventListener('click', () => {
      reached += 1;
    });
    panel.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
    expect(reached).toBe(1); // the panel handles its own clicks
    expect(harness.isExpanded()).toBe(true); // and stays open: it was not an outside click
  });

  it('collapsing is idempotent: outside clicks with nothing expanded reach the page', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft that stays collapsed through ordinary page clicks');
    await settleCapture();

    const target = pageTarget();
    clickOutside(target.element);
    expect(target.reached()).toBe(1);
    expect(harness.isExpanded()).toBe(false);
  });

  it('a fresh composer (SPA navigation) always starts collapsed', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft expanded right before the route change happens');
    await settleCapture();
    harness.expand();

    await settleDom();
    document.body.innerHTML = REPLY_VIEW_HTML;
    await settleDom();
    typeText(composer(), 'A reply draft that is long enough to score');
    await settleCapture();
    expect(harness.isExpanded()).toBe(false); // never opens by itself
    expect(harness.pill()).not.toBeNull();
  });
});

describe('autoAnalyze gates only the AI call (VAL-SETUP-010)', () => {
  it('shows the local-score pill with zero Jev calls while autoAnalyze is off', async () => {
    const harness = startHarness({ settings: { autoAnalyze: false } });
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft typed with autoAnalyze off');
    await settleCapture();

    // The local score is ALWAYS computed (no network) and ALWAYS shown in the pill.
    const expectedLocal = scoreDraft(harness.draftEvents.at(-1)!.snapshot);
    expect(harness.pill().textContent).toBe(String(expectedLocal.headline));
    expect(harness.isExpanded()).toBe(false);
    expect(harness.requests).toHaveLength(0);
  });

  it('the expanded panel exposes the explicit AI action, and activating it analyzes exactly once', async () => {
    const harness = startHarness({ settings: { autoAnalyze: false } });
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft typed with autoAnalyze off');
    await settleCapture();

    const panel = harness.expand();
    const jev = find(panel, 'overlay-jev')!;
    expect(jev.dataset.jevState).toBe('ready');
    expect(find(jev, 'overlay-jev-pending')).toBeNull(); // nothing implies a request is running
    expect(find(jev, 'overlay-jev-band')).toBeNull();
    // The local half is fully available even though the AI half never ran.
    expect(find(panel, 'overlay-signals')).not.toBeNull();
    expect(find(panel, 'overlay-optimizer')).not.toBeNull();

    const analyze = find(jev, 'overlay-analyze')!;
    expect(analyze.textContent).toBe('Analyze with AI');
    clickInside(analyze);
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]!.trigger).toBe('manual');
    // The action's own click is not an outside click: the panel the user opened stays open.
    expect(harness.isExpanded()).toBe(true);

    // Exactly one analysis: the local half is untouched and the reply (which is not a user edit)
    // repaints the SAME open panel with the verdict.
    expect(find(harness.panel(), 'overlay-signals')).not.toBeNull();
    expect(harness.requests).toHaveLength(1);

    harness.replyFor(harness.requests[0]!);
    expect(harness.requests).toHaveLength(1);
    expect(find(harness.panel(), 'overlay-jev')!.dataset.jevState).toBe('verdict');
  });

  it('switching autoAnalyze back on restores the automatic AI half', async () => {
    const harness = startHarness({ settings: { autoAnalyze: false } });
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft typed while the automatic AI lane was off');
    await settleCapture();
    expect(harness.requests).toHaveLength(0);

    await harness.pushSettings({ autoAnalyze: true }, 2);
    typeText(composer(), 'A second draft typed once the automatic AI lane is back on');
    await settleCapture();
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]!.trigger).toBe('auto');
  });
});

describe('optimistic local render before Jev (VAL-DRAFT-006, VAL-DRAFT-010)', () => {
  it('the pill shows the local score immediately at capture, with the Jev half pending inside the panel', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'What is the one tool you stopped using this year, and why?');
    await settleCapture();

    const expectedLocal = scoreDraft(harness.draftEvents.at(-1)!.snapshot);
    const panel = harness.expand();
    // Local half: headline equals the pure engine's local headline, labeled as local-only.
    const gauge = find(panel, 'overlay-gauge')!;
    expect(gauge.dataset.headlineSource).toBe('local');
    expect(find(panel, 'overlay-headline')!.textContent).toBe(String(expectedLocal.headline));
    expect(find(panel, 'overlay-signals')).not.toBeNull();
    // The collapsed pill carries the very same number (VAL-DRAFT-032: headline only).
    expect(harness.collapseNow().textContent).toBe(String(expectedLocal.headline));
    // Jev half: visibly pending inside the panel, and the collapsed pill still keeps the usable
    // local score instead of dropping it (VAL-DRAFT-010).
    harness.expand();
    const jev = find(harness.panel(), 'overlay-jev')!;
    expect(jev.dataset.jevState).toBe('pending');
    expect(find(jev, 'overlay-jev-pending')!.textContent).toContain('Analyzing with AI');
    expect(harness.collapseNow().dataset.jevState).toBe('pending');
  });

  it('needs no analyze-draft reply at all to show the local breakdown (independence)', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'Five lessons from scaling to 1M users: measure, cache, delete, hire slowly, write it down');
    await settleCapture();
    expect(find(harness.expand(), 'overlay-signals')!.querySelectorAll('li')).not.toHaveLength(0);
  });
});

describe('algorithm signal breakdown (VAL-DRAFT-007)', () => {
  it('lists question/hook, length band, hashtags, link handling, reply context and media as separate signals', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'What changed my year? A daily checklist #focus https://example.com/post #systems');
    await settleCapture();

    const signals = find(harness.expand(), 'overlay-signals')!;
    expect(signals.querySelector('h3')!.textContent).toBe('Algorithm signals');
    const required = ['reply-magnet', 'length', 'hashtags', 'external-link', 'media', 'reply-mutual'];
    for (const id of required) {
      const row = signals.querySelector<HTMLElement>(`li[data-signal-id="${id}"]`);
      expect(row, `signal ${id} must be rendered`).not.toBeNull();
      expect(row!.querySelector('.value')!.textContent!.trim()).not.toBe('');
    }
  });

  it('shows a concrete value for the length band and hashtag count of this draft', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A plain draft with exactly two tags #one #two');
    await settleCapture();
    const signals = find(harness.expand(), 'overlay-signals')!;
    expect(signals.querySelector('li[data-signal-id="hashtags"] .value')!.textContent).toContain('2');
    expect(signals.querySelector('li[data-signal-id="length"] .value')!.textContent).toMatch(/chars/);
  });
});

describe('asynchronous Jev verdict (VAL-DRAFT-008, VAL-DRAFT-009)', () => {
  async function analyzedWithVerdict(harness: Harness, ordinal: number): Promise<HTMLElement> {
    typeText(composer(), `A distinct draft for ordinal ${ordinal} that is long enough`);
    await settleCapture();
    harness.replyFor(harness.requests.at(-1)!, {
      // The real pipeline derives the band from the ordinal via toJevVerdict/mapJevBand.
      jev: {
        ordinal,
        confidence: 0.71,
        band: mapJevBand(ordinal),
        strengths: [],
        weaknesses: [WEAKNESS_LABELS.weak_hook],
        suggestions: [],
      },
    });
    return harness.expand();
  }

  it('adds the verdict beside the unchanged algorithm breakdown and switches the headline to hybrid', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'What is the one tool you stopped using this year, and why?');
    await settleCapture();
    const request = harness.requests[0]!;
    const localBefore = scoreDraft(request.snapshot);
    const before = harness.expand();
    const signalsHeadingBefore = find(before, 'overlay-signals')!.querySelector('h3')!.textContent;

    harness.replyFor(request); // the panel stays expanded; the reply repaints it in place
    const panel = harness.panel();

    // The local breakdown stays, under its own unchanged heading (sources distinguished).
    const signals = find(panel, 'overlay-signals')!;
    expect(signals.querySelector('h3')!.textContent).toBe(signalsHeadingBefore);
    expect(signals.querySelectorAll('li').length).toBe(localBefore.signals.length);

    // The AI judgment is a separate section with band, confidence and weakness.
    const jev = find(panel, 'overlay-jev')!;
    expect(jev.dataset.jevState).toBe('verdict');
    expect(jev.querySelector('h3')!.textContent).toBe('AI judgment');
    expect(find(jev, 'overlay-jev-band')!.textContent).toBe('Moderate');
    expect(find(jev, 'overlay-jev-confidence')!.textContent).toBe('Confidence: 65%');
    expect(find(jev, 'overlay-jev-weaknesses')!.textContent).toContain(WEAKNESS_LABELS.not_specific_enough);

    // Hybrid headline: round(0.6*local + 0.4*(ordinal/5*100)), mirrored in the pill.
    const gauge = find(panel, 'overlay-gauge')!;
    expect(gauge.dataset.headlineSource).toBe('hybrid');
    const hybrid = String(Math.round(0.6 * localBefore.headline + 0.4 * ((3.44 / 5) * 100)));
    expect(find(panel, 'overlay-headline')!.textContent).toBe(hybrid);
    expect(harness.collapseNow().textContent).toBe(hybrid); // the pill carries the same number
  });

  it('maps every exact rubric ordinal to its band label', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    const bands: ReadonlyArray<[number, string]> = [
      [0, 'Weak'],
      [1, 'Weak'],
      [2, 'Below avg'],
      [3, 'Moderate'],
      [4, 'Strong'],
      [5, 'Exceptional'],
    ];
    for (const [ordinal, label] of bands) {
      const panel = await analyzedWithVerdict(harness, ordinal);
      expect(find(panel, 'overlay-jev-band')!.textContent).toBe(label);
      expect(find(panel, 'overlay-jev-confidence')!.textContent).toBe('Confidence: 71%');
      // Collapse again: typing the next draft must leave only the pill (VAL-DRAFT-036).
      pressEscape();
      expect(harness.isExpanded()).toBe(false);
    }
  });

  it('renders suggestions when the verdict carries them', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft whose verdict will carry a suggestion line');
    await settleCapture();
    harness.replyFor(harness.requests.at(-1)!, {
      jev: {
        ordinal: 4.5,
        confidence: 0.9,
        band: 'exceptional',
        strengths: [],
        weaknesses: [WEAKNESS_LABELS.no_major_weakness],
        suggestions: ['Open with the number to earn the first line.'],
      },
    });
    const jev = find(harness.expand(), 'overlay-jev')!;
    expect(find(jev, 'overlay-jev-suggestions')!.textContent).toContain('Open with the number');
  });
});

describe('stale response discard (VAL-DRAFT-011)', () => {
  it('never lets an older draft reply overwrite the newer draft result', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);

    typeText(composer(), 'Draft A: what is your favorite database and why does it matter?');
    await settleCapture();
    const requestA = harness.requests[0]!;

    // Draft B replaces A before A's reply returns.
    typeText(composer(), 'Draft B: the one habit that made my writing stick was reading aloud #writing');
    await settleCapture();
    const requestB = harness.requests.at(-1)!;

    // B settles first (reversed order): B's verdict shows.
    harness.replyFor(requestB, {
      jev: {
        ordinal: 4.5,
        confidence: 0.8,
        band: 'exceptional',
        strengths: [],
        weaknesses: [WEAKNESS_LABELS.no_major_weakness],
        suggestions: [],
      },
    });
    let panel = harness.expand();
    expect(find(panel, 'overlay-jev-band')!.textContent).toBe('Exceptional');
    const headlineForB = harness.collapseNow().textContent;
    harness.expand();

    // A's stale reply arrives LAST: discarded, B's result stays.
    harness.replyFor(requestA, {
      jev: {
        ordinal: 0,
        confidence: 0.9,
        band: 'weak',
        strengths: [],
        weaknesses: [WEAKNESS_LABELS.weak_hook],
        suggestions: [],
      },
    });
    panel = harness.panel(); // still expanded: a reply is not a user edit
    expect(find(panel, 'overlay-jev-band')!.textContent).toBe('Exceptional');
    expect(find(panel, 'overlay-jev')!.textContent).not.toContain('Weak hook');
    // A never repaints B's pill either.
    expect(harness.collapseNow().textContent).toBe(headlineForB);
  });

  it('drops the settled result when the draft changes, showing the new draft locally', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'First eligible draft with a settled verdict');
    await settleCapture();
    harness.replyFor(harness.requests[0]!);
    expect(find(harness.expand(), 'overlay-jev')!.dataset.jevState).toBe('verdict');

    // Typing collapses to the pill for the NEW draft, whose own analysis is in flight.
    typeText(composer(), 'Second, longer draft that differs from the first one');
    await settleCapture();
    expect(harness.isExpanded()).toBe(false);
    expect(harness.pill().dataset.jevState).toBe('pending');
    const panel = harness.expand();
    expect(find(panel, 'overlay-gauge')!.dataset.headlineSource).toBe('local');
    expect(find(panel, 'overlay-jev')!.dataset.jevState).toBe('pending');
  });
});

describe('no key configured (VAL-DRAFT-017)', () => {
  it('keeps the local score usable in the pill and shows the Connect Jev prompt in the panel', async () => {
    const harness = startHarness({ keyPresent: false });
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A local-only draft long enough to be scored');
    await settleCapture();

    const pill = harness.pill();
    expect(pill.dataset.headlineSource).toBe('local');
    expect(pill.dataset.jevState).toBe('no-key'); // the pill implies no AI verdict exists

    let panel = harness.expand();
    let jev = find(panel, 'overlay-jev')!;
    expect(jev.dataset.jevState).toBe('no-key');
    expect(find(jev, 'overlay-jev-pending')).toBeNull(); // nothing implies a request is running
    expect(find(jev, 'overlay-jev-notice')!.textContent).toContain('Local signals only');
    expect(find(jev, 'overlay-connect-jev')!.textContent).toBe('Connect Jev');

    // The analyzer's reply confirms the same state.
    harness.replyFor(harness.requests[0]!, { jev: undefined, jevStatus: 'skipped-no-key' });
    panel = harness.panel();
    jev = find(panel, 'overlay-jev')!;
    expect(jev.dataset.jevState).toBe('no-key');
    expect(find(panel, 'overlay-gauge')).not.toBeNull();
  });

  it('opens the options page from the Connect Jev prompt', async () => {
    const harness = startHarness({ keyPresent: false });
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A local-only draft long enough to be scored');
    await settleCapture();
    clickInside(find(find(harness.expand(), 'overlay-jev')!, 'overlay-connect-jev')!);
    expect(harness.optionsOpened).toBe(1);
  });
});

describe('jevForDrafts off (VAL-DRAFT-021)', () => {
  it('stays local-only without implying AI ran, and never shows a pending state', async () => {
    const harness = startHarness({ settings: { jevForDrafts: false } });
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft analyzed while AI for drafts is disabled');
    await settleCapture();

    expect(harness.pill().dataset.jevState).toBe('off');
    let panel = harness.expand();
    let jev = find(panel, 'overlay-jev')!;
    expect(jev.dataset.jevState).toBe('off');
    expect(find(jev, 'overlay-jev-pending')).toBeNull();
    expect(find(jev, 'overlay-connect-jev')).toBeNull();
    expect(find(jev, 'overlay-jev-notice')!.textContent).toContain('AI analysis is off');

    harness.replyFor(harness.requests[0]!, { jev: undefined, jevStatus: 'skipped-disabled' });
    panel = harness.panel();
    jev = find(panel, 'overlay-jev')!;
    expect(jev.dataset.jevState).toBe('off');
    expect(find(panel, 'overlay-gauge')).not.toBeNull(); // local scoring stays available
  });

  it('reverts a visible verdict to local-only the moment jevForDrafts turns off (live settings precedence)', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft analyzed and answered while AI for drafts is on');
    await settleCapture();
    harness.replyFor(harness.requests[0]!);
    let panel = harness.expand();
    expect(find(panel, 'overlay-jev')!.dataset.jevState).toBe('verdict');
    expect(find(panel, 'overlay-gauge')!.dataset.headlineSource).toBe('hybrid');

    await harness.pushSettings({ jevForDrafts: false }, 2);

    panel = harness.panel(); // a settings change is not a user edit: the panel stays open
    expect(find(panel, 'overlay-jev')!.dataset.jevState).toBe('off'); // the off state, not the verdict
    expect(find(panel, 'overlay-jev-notice')!.textContent).toContain('AI analysis is off');
    expect(find(panel, 'overlay-jev-band')).toBeNull(); // the AI verdict left the panel
    expect(find(panel, 'overlay-gauge')!.dataset.headlineSource).toBe('local'); // headline reverted
    const local = scoreDraft(harness.requests[0]!.snapshot);
    expect(find(panel, 'overlay-headline')!.textContent).toBe(String(local.headline));
    expect(find(panel, 'overlay-signals')).not.toBeNull(); // local scoring stays available
    expect(harness.collapseNow().textContent).toBe(String(local.headline));
  });

  it('a late reply cannot re-introduce the verdict once jevForDrafts is off', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'Draft typed while AI for drafts is enabled');
    await settleCapture();
    const request = harness.requests[0]!;

    await harness.pushSettings({ jevForDrafts: false }, 2); // the user disables AI mid-flight
    harness.replyFor(request); // the verdict lands AFTER the setting flipped

    const panel = harness.expand();
    expect(find(panel, 'overlay-jev')!.dataset.jevState).toBe('off');
    expect(find(panel, 'overlay-jev-band')).toBeNull();
    expect(find(panel, 'overlay-gauge')!.dataset.headlineSource).toBe('local');
    expect(find(panel, 'overlay-headline')!.textContent).toBe(String(scoreDraft(request.snapshot).headline));
  });

  it('restores the settled verdict when the setting is turned back on in the same session', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft whose settled verdict survives the setting round-trip');
    await settleCapture();
    harness.replyFor(harness.requests[0]!);
    harness.expand();
    await harness.pushSettings({ jevForDrafts: false }, 2);
    expect(find(harness.panel(), 'overlay-jev')!.dataset.jevState).toBe('off');

    await harness.pushSettings({ jevForDrafts: true }, 3);
    expect(find(harness.panel(), 'overlay-jev')!.dataset.jevState).toBe('verdict'); // no re-request needed
  });
});

describe('Jev failure degradation (VAL-DRAFT-018)', () => {
  it.each([
    ['failed-http', 'The AI service returned an error (HTTP 500).'],
    ['failed-network', 'Could not reach the AI service.'],
    ['failed-malformed', 'The AI service returned an unreadable response.'],
    ['rate-limited', 'AI analysis is rate-limited right now'],
  ] as const)('keeps the pill usable and shows an explicit notice in the panel for %s', async (status, reason) => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), `A draft that fails the Jev half with ${status}`);
    await settleCapture();

    harness.replyFor(harness.requests[0]!, {
      jev: undefined,
      jevStatus: status,
      ...(status === 'failed-http' ? { jevFailure: { kind: 'http-error', status: 500 } } : {}),
      ...(status === 'failed-network' ? { jevFailure: { kind: 'network', reason: 'unreachable' as const } } : {}),
      ...(status === 'failed-malformed' ? { jevFailure: { kind: 'malformed' } } : {}),
      ...(status === 'rate-limited' ? { jevFailure: { kind: 'rate-limited' } } : {}),
    });

    // The collapsed pill keeps the usable local score (never a fabricated verdict).
    expect(harness.pill()).not.toBeNull();
    expect(harness.pill().dataset.jevState).toBe('error');
    const panel = harness.expand();
    expect(find(panel, 'overlay-signals')).not.toBeNull();
    const jev = find(panel, 'overlay-jev')!;
    expect(jev.dataset.jevState).toBe('error');
    expect(find(jev, 'overlay-jev-notice')!.textContent).toContain('AI judgment unavailable');
    expect(jev.textContent).toContain(reason);
  });

  it('recovers on the next analysis after a failure', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A first draft whose AI half will fail');
    await settleCapture();
    harness.replyFor(harness.requests[0]!, { jev: undefined, jevStatus: 'failed-network', jevFailure: { kind: 'network', reason: 'unreachable' } });
    expect(find(harness.expand(), 'overlay-jev')!.dataset.jevState).toBe('error');

    typeText(composer(), 'A second draft whose AI half will succeed');
    await settleCapture();
    harness.replyFor(harness.requests.at(-1)!);
    expect(find(harness.expand(), 'overlay-jev')!.dataset.jevState).toBe('verdict');
  });

  it('clears the pending state when the analyze-draft transport itself fails', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft whose analysis message never gets a reply');
    await settleCapture();
    expect(harness.pill().dataset.jevState).toBe('pending');

    harness.failTransport();
    expect(harness.pill()).not.toBeNull(); // the local score stays usable
    const jev = find(harness.expand(), 'overlay-jev')!;
    expect(jev.dataset.jevState).toBe('error');
    expect(jev.textContent).toContain('AI judgment unavailable');
  });
});

describe('transport-failure identity: out-of-order dispatches (VAL-DRAFT-018)', () => {
  it('settles the failing dispatch: the newest draft shows its transport error while the older stays pending', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'Draft A: what is your favorite database and why does it matter?');
    await settleCapture();
    typeText(composer(), 'Draft B: the one habit that made my writing stick was reading aloud #writing');
    await settleCapture();
    const requestA = harness.requests[0]!;
    const requestB = harness.requests.at(-1)!;

    // B's transport fails while A's analysis is STILL in flight.
    harness.failTransport(requestB);

    // B (the current draft) reaches a terminal render: local score + explicit transport error.
    expect(harness.pill().textContent).toBe(String(scoreDraft(requestB.snapshot).headline));
    const panel = harness.expand();
    expect(find(panel, 'overlay-jev')!.dataset.jevState).toBe('error'); // never an infinite spinner
    expect(find(panel, 'overlay-jev')!.textContent).toContain('did not respond');
    expect(find(panel, 'overlay-gauge')!.dataset.headlineSource).toBe('local');

    // A's late success is unrelated to B: it neither repaints B nor lifts B's error.
    harness.replyFor(requestA, { jev: undefined, jevStatus: 'skipped-no-key' });
    expect(find(harness.panel(), 'overlay-jev')!.dataset.jevState).toBe('error');
    expect(harness.collapseNow().textContent).toBe(String(scoreDraft(requestB.snapshot).headline));
  });

  it('failing the older dispatch leaves the newer draft pending; that draft still settles on its own failure', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'Draft A: what is your favorite database and why does it matter?');
    await settleCapture();
    typeText(composer(), 'Draft B: the one habit that made my writing stick was reading aloud #writing');
    await settleCapture();
    const requestA = harness.requests[0]!;
    const requestB = harness.requests.at(-1)!;

    harness.failTransport(requestA); // only the OLDEST dispatch fails
    const panel = harness.expand();
    expect(find(panel, 'overlay-jev')!.dataset.jevState).toBe('pending'); // B unaffected
    expect(find(panel, 'overlay-jev-band')).toBeNull(); // no error is shown for B either

    harness.failTransport(requestB); // B's own transport failure settles B
    expect(find(harness.panel(), 'overlay-jev')!.dataset.jevState).toBe('error');
  });

  it('keeps the current draft failure when the older dispatch fails afterwards (B fails, then A fails)', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'Draft A: what is your favorite database and why does it matter?');
    await settleCapture();
    typeText(composer(), 'Draft B: the one habit that made my writing stick was reading aloud #writing');
    await settleCapture();
    const requestA = harness.requests[0]!;
    const requestB = harness.requests.at(-1)!;

    harness.failTransport(requestB); // the current draft fails first
    harness.failTransport(requestA); // then the OLDER dispatch's transport fails too

    // A's failure owns A only: it must not overwrite B's terminal state.
    expect(harness.pill()).not.toBeNull();
    const panel = harness.expand();
    expect(find(panel, 'overlay-gauge')!.dataset.headlineSource).toBe('local');
    expect(find(panel, 'overlay-jev')!.dataset.jevState).toBe('error');
    expect(find(panel, 'overlay-jev')!.textContent).toContain('did not respond');
  });

  it('a late transport failure for an older draft never downgrades a settled verdict (failure after success)', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'Draft A: what is your favorite database and why does it matter?');
    await settleCapture();
    typeText(composer(), 'Draft B: the one habit that made my writing stick was reading aloud #writing');
    await settleCapture();
    const requestA = harness.requests[0]!;
    const requestB = harness.requests.at(-1)!;

    harness.replyFor(requestB); // B (current) settles with a verdict first
    const panel = harness.expand();
    expect(find(panel, 'overlay-jev')!.dataset.jevState).toBe('verdict');

    harness.failTransport(requestA); // the older dispatch's transport fails LAST

    expect(find(harness.panel(), 'overlay-jev')!.dataset.jevState).toBe('verdict'); // B intact
    expect(find(harness.panel(), 'overlay-jev-band')).not.toBeNull();
  });

  it('clears the draft failure when its own re-dispatch succeeds (success after failure)', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    const draftText = 'Draft A: what is your favorite database and why does it matter?';
    typeText(composer(), draftText);
    await settleCapture();
    harness.failTransport(harness.requests[0]!);
    expect(find(harness.expand(), 'overlay-jev')!.dataset.jevState).toBe('error');

    // The user retypes the identical draft: a fresh dispatch for the SAME identity (same hash).
    typeText(composer(), draftText);
    await settleCapture();
    expect(harness.requests).toHaveLength(2);
    harness.replyFor(harness.requests[1]!);

    expect(find(harness.expand(), 'overlay-jev')!.dataset.jevState).toBe('verdict'); // failure gone
  });

  it('an honest refusal settles its own dispatch without regressing the local score', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'Draft A: what is your favorite database and why does it matter?');
    await settleCapture();
    typeText(composer(), 'Draft B: the one habit that made my writing stick was reading aloud #writing');
    await settleCapture();
    const requestB = harness.requests.at(-1)!;

    // B is refused (e.g. the min-length gate moved mid-flight) while A is still in flight.
    harness.reply({ kind: 'below-min-length', minDraftLength: 400 }, requestB);

    // The pill keeps B's local score: a refusal settles the AI half, never the local one.
    expect(harness.pill().textContent).toBe(String(scoreDraft(requestB.snapshot).headline));
  });
});

describe('settings and key-presence updates without reload (VAL-CROSS-002, VAL-SETUP-016)', () => {
  it('applies a key-presence flip to the next draft through the reply path', async () => {
    const harness = startHarness({ keyPresent: false });
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'Draft one, typed while no key was configured');
    await settleCapture();
    harness.replyFor(harness.requests[0]!, { jev: undefined, jevStatus: 'skipped-no-key' });
    expect(harness.pill().dataset.jevState).toBe('no-key');

    // The key is configured elsewhere (Options); presence reaches the tab live.
    harness.setKeyPresent(true);
    typeText(composer(), 'Draft two, typed after the key was configured');
    await settleCapture();
    expect(harness.pill().dataset.jevState).toBe('pending');
    harness.replyFor(harness.requests.at(-1)!);
    expect(harness.pill().dataset.jevState).toBe('verdict');
    expect(find(harness.expand(), 'overlay-jev-band')).not.toBeNull();
  });

  it('removes the overlay when the master switch turns off and remounts once on re-enable', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft analyzed before the master switch is toggled');
    await settleCapture();
    harness.replyFor(harness.requests[0]!);
    expect(harness.host()).not.toBeNull();

    await harness.pushSettings({ enabled: false }, 2);
    expect(harness.host()).toBeNull(); // injection removed without a reload
    expect(document.querySelectorAll(HOST_SELECTOR)).toHaveLength(0);

    // Nothing re-mounts or dispatches while disabled.
    typeText(composer(), 'Typed while the extension is disabled');
    await settleCapture();
    expect(harness.requests).toHaveLength(1); // only the earlier draft
    expect(harness.host()).toBeNull();

    // A FRESH document for the re-enable leg: stopping and restarting a watcher across a
    // `document.body` reset leaves the old observer alive (library/environment.md), and a leaked
    // watcher would steal the new composer's captures. This mirrors the real enable cycle, which
    // always starts from a clean lifecycle.
    harness.teardown();
    document.body.innerHTML = HOME_HTML;
    const remounted = startHarness();
    await vi.advanceTimersByTimeAsync(0);

    expect(document.querySelectorAll(HOST_SELECTOR)).toHaveLength(0); // still no UI without a draft

    typeText(composer(), 'A draft typed after re-enabling');
    await settleCapture();
    expect(remounted.requests).toHaveLength(1);
    remounted.replyFor(remounted.requests[0]!);
    expect(remounted.pill()).not.toBeNull();
    expect(document.querySelectorAll(HOST_SELECTOR)).toHaveLength(1); // no duplicate overlays
  });

  it('stamps the applied settings revision on its host for observability', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    // The initial revision is stamped when the host first exists (the draft brings it in).
    typeText(composer(), 'A draft long enough to bring a host into existence');
    await settleCapture();
    expect(harness.host()!.dataset.settingsRevision).toBe('1');

    // A setting change that keeps the draft eligible restamps the SAME host (no remount).
    await harness.pushSettings({ minDraftLength: 12 }, 7);
    expect(harness.host()!.dataset.settingsRevision).toBe('7');

    // Raising the threshold past the current draft's length applies without any reload: the UI
    // disappears entirely (no pill, no panel).
    await harness.pushSettings({ minDraftLength: 400 }, 8);
    expect(harness.host()).toBeNull();
    expect(harness.requests).toHaveLength(1); // no new dispatch for the now-ineligible draft
  });
});

describe('composer and posting interference (VAL-DRAFT-022, VAL-DRAFT-038)', () => {
  it('never nests inside the composer subtree and keeps page controls outside the host', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft while checking interference with the page');
    await settleCapture();
    const host = harness.host()!;
    expect(composer().contains(host)).toBe(false);
    expect(document.body.contains(host)).toBe(true);
    // The page's own controls are untouched siblings.
    expect(document.querySelector('[data-testid="tweetButtonInline"]')!.getAttribute('aria-disabled')).toBe('true');
    expect(document.querySelector('[data-testid="addMedia"]')).not.toBeNull();
  });

  it('while collapsed, only the pill is interactive: page clicks pass through untouched', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft whose collapsed state must not intercept the page');
    await settleCapture();
    expect(harness.isExpanded()).toBe(false);

    // Every native control still receives its click while only the pill is rendered.
    for (const testid of ['tweetButtonInline', 'addMedia']) {
      const control = pageTarget(testid);
      clickOutside(control.element);
      expect(control.reached(), `${testid} must still be clickable`).toBe(1);
    }
  });

  it('the host keeps pointer-events:none; only the pill button re-enables hits', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft whose pointer discipline is inspected');
    await settleCapture();

    const css = harness.host()!.shadowRoot!.querySelector<HTMLStyleElement>('style')!.textContent ?? '';
    expect(css).toMatch(/:host \{[^}]*pointer-events: none/);
    expect(css).toMatch(/\.pill \{[^}]*pointer-events: auto/);
    // The expanded panel is the single, documented exception.
    expect(css).toMatch(/\.panel \{[^}]*pointer-events: auto/);
  });
});

describe('clampPillClearOfControl (pill clearance from the Post button — m5-overlay-scroll-reach)', () => {
  const pill = { width: 44, height: 22 };
  // The REAL-site geometry (live-measured): the pill's right-aligned box lands on the Post
  // button because the real furniture row puts the Post button at the region's right edge.
  const realPost = { top: 261, bottom: 297, left: 784, right: 866 };
  const realPillPosition = { top: 279, left: 796 };

  it('slides the pill left of a measurable Post button its right-aligned box would cover', () => {
    const clamped = clampPillClearOfControl(realPillPosition, pill, realPost, 56, 8);
    expect(clamped.left).toBe(784 - 56 - pill.width); // clear of the Post button AND the counter
    expect(clamped.top).toBe(realPillPosition.top); // the band never moves
  });

  it('leaves the pill alone when the control sits elsewhere (fixture inline row)', () => {
    const fixturePost = { top: 261, bottom: 297, left: 399, right: 470 };
    expect(clampPillClearOfControl(realPillPosition, pill, fixturePost, 56, 8)).toEqual(realPillPosition);
  });

  it('leaves the pill alone when the control is not measurable (happy-dom zero rects)', () => {
    expect(clampPillClearOfControl(realPillPosition, pill, null, 56, 8)).toEqual(realPillPosition);
    const zero = { top: 0, bottom: 0, left: 0, right: 0 };
    expect(clampPillClearOfControl(realPillPosition, pill, zero, 56, 8)).toEqual(realPillPosition);
  });

  it('leaves the pill alone when only the vertical bands are disjoint', () => {
    const above = { top: 100, bottom: 140, left: 784, right: 866 };
    expect(clampPillClearOfControl(realPillPosition, pill, above, 56, 8)).toEqual(realPillPosition);
  });

  it('never pushes the pill left of the viewport edge', () => {
    const post = { top: 261, bottom: 297, left: 800, right: 900 };
    const clamped = clampPillClearOfControl(realPillPosition, pill, post, 56, 8);
    expect(clamped.left).toBe(800 - 56 - pill.width); // still right of the minLeft floor
    const spanning = { top: 261, bottom: 297, left: 30, right: 900 }; // overlaps the pill box
    expect(clampPillClearOfControl(realPillPosition, pill, spanning, 56, 8).left).toBe(8);
  });
});

describe('repositioning (VAL-DRAFT-023)', () => {
  it('positions the host absolutely with viewport clamping', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft that is anchored to the composer region');
    await settleCapture();
    const host = harness.host()!;
    expect(host.style.position).toBe('absolute');
    expect(host.style.top).toMatch(/px$/);
    expect(host.style.left).toMatch(/px$/);
  });

  it('recomputes the position on window resize without duplicating the host', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft that stays scored across a window resize');
    await settleCapture();
    const host = harness.host()!;
    const before = { top: host.style.top, left: host.style.left };

    window.innerWidth = 320; // narrower than the surface: clamping must engage
    window.dispatchEvent(new Event('resize'));
    await vi.advanceTimersByTimeAsync(16); // the resize path coalesces through rAF

    expect(host.style.left).toBe('8px');
    expect(host.style.left).not.toBe(before.left === '8px' ? '' : before.left);
    expect(document.querySelectorAll(HOST_SELECTOR)).toHaveLength(1);
  });

  it('caps the expanded panel to the viewport with internal scrolling when the window is too short (VAL-DRAFT-023)', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft that is analyzed before the viewport shrinks');
    await settleCapture();
    harness.replyFor(harness.requests[0]!);
    const panel = harness.expand();
    expect(panel.style.maxHeight).toBe(''); // no cap at full height

    // happy-dom reports no layout: the panel measures at its 240px design fallback, which no
    // longer fits a 120px viewport. The cap must clamp the panel INSIDE the viewport.
    window.innerHeight = 120;
    window.dispatchEvent(new Event('resize'));
    await vi.advanceTimersByTimeAsync(16);

    expect(harness.panel().style.maxHeight).toBe('104px'); // 120 - 2*8 margin - 8 gap
    expect(document.querySelectorAll(HOST_SELECTOR)).toHaveLength(1); // never a second host

    window.innerHeight = 700;
    window.dispatchEvent(new Event('resize'));
    await vi.advanceTimersByTimeAsync(16);
    expect(harness.panel().style.maxHeight).toBe(''); // the cap releases when space returns
  });

  it('stops listening after destroy()', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft present when the overlay is destroyed');
    await settleCapture();
    harness.overlay.destroy();
    expect(harness.host()).toBeNull();
    window.dispatchEvent(new Event('resize'));
    await vi.advanceTimersByTimeAsync(16);
    expect(harness.host()).toBeNull();
  });
});

describe('computeAnchorPosition (expanded panel placement math)', () => {
  const base = {
    regionRect: { top: 100, bottom: 200, left: 40 },
    overlaySize: { width: 340, height: 240 },
    viewport: { width: 1280, height: 720 },
    scroll: { x: 0, y: 0 },
  };

  it('anchors below the region, aligned with its left edge, in document coordinates', () => {
    expect(computeAnchorPosition(base)).toEqual({ top: 208, left: 40, maxHeight: null });
  });

  it('folds above the region when there is no room below', () => {
    const position = computeAnchorPosition({ ...base, regionRect: { top: 600, bottom: 700, left: 40 } });
    expect(position).toEqual({ top: 352, left: 40, maxHeight: null }); // 600 - 8 - 240
  });

  it('caps the panel to the available space when neither side fully fits (VAL-DRAFT-023)', () => {
    const position = computeAnchorPosition({
      regionRect: { top: 300, bottom: 400, left: 40 },
      overlaySize: { width: 340, height: 600 },
      viewport: { width: 1280, height: 500 },
      scroll: { x: 0, y: 0 },
    });
    // Neither side fits 600px. The panel must stay INSIDE the viewport (no more offscreen
    // overflow): it caps to the roomier space — above offers 284px vs 84px below — and folds
    // above the region, whose top (300) is never covered.
    expect(position).toEqual({ top: 8, left: 40, maxHeight: 284 });
  });

  it('caps below the region first when that side offers at least as much room (VAL-DRAFT-022/023)', () => {
    const position = computeAnchorPosition({
      regionRect: { top: 10, bottom: 120, left: 40 },
      overlaySize: { width: 340, height: 600 },
      viewport: { width: 1280, height: 500 },
      scroll: { x: 0, y: 0 },
    });
    expect(position).toEqual({ top: 128, left: 40, maxHeight: 364 });
  });

  it('leaves the natural size uncapped whenever the panel fits one side whole', () => {
    const fitsBelow = computeAnchorPosition(base);
    const foldsAbove = computeAnchorPosition({ ...base, regionRect: { top: 600, bottom: 700, left: 40 } });
    expect(fitsBelow.maxHeight).toBeNull();
    expect(foldsAbove.maxHeight).toBeNull();
  });

  it('clamps horizontally on narrow viewports', () => {
    const position = computeAnchorPosition({ ...base, viewport: { width: 320, height: 720 } });
    expect(position.left).toBe(8); // 320 - 340 - 8 is negative: the margin wins
  });

  it('adds scroll offsets so the panel stays anchored while the page scrolls', () => {
    const position = computeAnchorPosition({ ...base, scroll: { x: 12, y: 3000 } });
    expect(position).toEqual({ top: 3208, left: 52, maxHeight: null });
  });

  it('keeps the panel inside the scrolled viewport when below does not fit', () => {
    const position = computeAnchorPosition({
      regionRect: { top: 600, bottom: 700, left: 40 },
      overlaySize: { width: 340, height: 240 },
      viewport: { width: 1280, height: 720 },
      scroll: { x: 0, y: 4000 },
    });
    expect(position.top).toBe(4352); // folds above the region, inside the window
    expect(position.left).toBe(40);
  });
});

describe('computePillPosition (collapsed pill placement math — VAL-DRAFT-032/033)', () => {
  const region = { top: 100, bottom: 200, left: 40, right: 640 };
  const pill = { width: 30, height: 20 };
  const viewport = { width: 1280, height: 720 };

  it('anchors the pill inside the composer region, bottom-right, clear of the Post button', () => {
    const position = computePillPosition({ regionRect: region, overlaySize: pill, viewport, scroll: { x: 0, y: 0 } });
    // Right edge = region.right - 44 (clear of the Post button); bottom = region.bottom - 6.
    expect(position.left).toBe(566); // 640 - 30 - 44
    expect(position.top).toBe(174); // 200 - 20 - 6
    // The pill's whole box is INSIDE the region, i.e. never over the text area above it.
    expect(position.top).toBeGreaterThanOrEqual(region.top);
    expect(position.top + pill.height).toBeLessThanOrEqual(region.bottom);
  });

  it('leaves the whole space BELOW the region free — where X popups grow', () => {
    const position = computePillPosition({ regionRect: region, overlaySize: pill, viewport, scroll: { x: 0, y: 0 } });
    expect(position.top + pill.height).toBeLessThanOrEqual(region.bottom);
  });

  it('adds the scroll offset so the pill stays anchored while the page scrolls', () => {
    const position = computePillPosition({ regionRect: region, overlaySize: pill, viewport, scroll: { x: 0, y: 3000 } });
    expect(position.top).toBe(3174);
  });

  it('keeps the pill inside the viewport when the composer is wider than the window', () => {
    const position = computePillPosition({
      regionRect: { top: 100, bottom: 200, left: 0, right: 900 },
      overlaySize: pill,
      viewport: { width: 320, height: 720 },
      scroll: { x: 0, y: 0 },
    });
    // 900 - 30 - 44 overshoots a 320px window: the viewport clamp wins, keeping the pill on
    // screen (right edge at 320 - 8 = 312, its documented gap from the Post button's side).
    expect(position.left).toBe(282);
  });

  it('falls back to the panel placement when the region is too short to hold the pill', () => {
    const position = computePillPosition({
      regionRect: { top: 100, bottom: 110, left: 40, right: 640 },
      overlaySize: pill,
      viewport,
      scroll: { x: 0, y: 0 },
    });
    expect(position.pillTop).toBeUndefined();
    expect(position.top).toBe(118); // the below-the-region fallback (110 + 8 gap)
  });

  it('caps the pill when the viewport is shorter than its preferred band', () => {
    const position = computePillPosition({
      regionRect: { top: 100, bottom: 400, left: 40, right: 640 },
      overlaySize: pill,
      viewport: { width: 1280, height: 200 },
      scroll: { x: 0, y: 0 },
    });
    expect(position.maxHeight).toBe(0); // clamped to stay inside the window
  });

  it('leaves the pill uncapped when the band fits the viewport', () => {
    const position = computePillPosition({ regionRect: region, overlaySize: pill, viewport, scroll: { x: 0, y: 0 } });
    expect(position.maxHeight).toBeNull();
  });
});

describe('English-only copy (VAL-CROSS-016)', () => {
  it('renders only English text across the pill, the expanded panel and both transitions', async () => {
    const harness = startHarness({ keyPresent: false });
    await vi.advanceTimersByTimeAsync(0);
    const english = /^[A-Za-z0-9 .,:;!?%'"()\-–—/+·…]*$/;

    const visibleText = (root: ParentNode): string =>
      [...root.querySelectorAll('*')].map((node) => node.textContent ?? '').join(' ');

    typeText(composer(), 'What is the one tool you stopped using this year? #focus https://example.com/x');
    await settleCapture();
    // The collapsed pill: the number only, plus an English accessible name.
    expect(harness.pill().textContent).toMatch(/^\d{1,3}$/);
    expect(harness.pill().getAttribute('aria-label')).toMatch(english);

    const panel = harness.expand();
    expect(visibleText(panel)).toMatch(english);
    expect(visibleText(panel)).not.toContain('Postar');

    // The expanded -> collapsed transition surfaces the same English pill again.
    pressEscape();
    expect(harness.pill().getAttribute('aria-label')).toMatch(english);

    harness.replyFor(harness.requests[0]!);
    expect(visibleText(harness.expand())).toMatch(english);
  });
});

describe('structural fallback composer (VAL-DRAFT-029 overlay leg)', () => {
  it('mounts the overlay for a fallback-detected composer and hides it when none matches', async () => {
    document.body.innerHTML = `
      <div data-testid="primaryColumn">
        <div data-testid="tweetTextarea_0RichTextInputContainer">
          <div role="textbox" contenteditable="true" class="public-DraftEditor-content"></div>
        </div>
      </div>`;
    const overlay = createScoreOverlay({
      getKeyPresence: () => true,
      requestAnalysis: () => false,
      openOptions: () => undefined,
    });
    const watcher = createComposerWatcher({
      getMinDraftLength: () => 10,
      getAutoAnalyze: () => true,
      dispatchAnalysis: () => undefined,
    });
    watcher.onDraft((event) => overlay.onDraftCaptured(event));
    watcher.onComposerChange((event) => overlay.onComposerChange(event));
    overlay.onSettings({ ...DEFAULT_SETTINGS }, 1);
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    await settleDom();
    expect(document.querySelector(HOST_SELECTOR)).toBeNull(); // no draft yet: no UI

    typeText(document.querySelector('[role="textbox"]')!, 'A structural fallback draft long enough to score');
    await settleCapture();
    expect(shadowOf(OVERLAY_PILL_TESTID)).not.toBeNull();

    document.body.innerHTML = '<div data-testid="primaryColumn"><p>nothing editable</p></div>';
    await settleDom();
    expect(document.querySelector(HOST_SELECTOR)).toBeNull();
    overlay.destroy();
  });
});

describe('mention typeahead yield (VAL-DRAFT-040)', () => {
  /** Adds/removes X's own mention-typeahead rows in the light DOM (as x.com renders them). */
  function openTypeahead(): HTMLElement {
    const row = document.createElement('div');
    row.dataset.testid = 'typeaheadResult';
    document.body.append(row);
    return row;
  }

  it('hides the collapsed pill while X\'s composer mention typeahead is open and restores it after', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft long enough to be analyzed, then typed @into');
    await settleCapture();
    const pill = harness.pill();
    expect(pill.style.visibility).not.toBe('hidden');

    // The mention typeahead opens while the COMPOSER holds focus (mid-mention typing).
    (composer() as HTMLElement).focus();
    const row = openTypeahead();
    await vi.advanceTimersByTimeAsync(16); // the open/close detection coalesces through rAF
    expect(pill.style.visibility).toBe('hidden');

    // Dismissing (Escape / selection) removes the rows: the pill returns.
    row.remove();
    await vi.advanceTimersByTimeAsync(16);
    expect(pill.style.visibility).not.toBe('hidden');
  });

  it('keeps the pill visible for an unrelated typeahead (the watched composer lacks focus)', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft long enough to be analyzed');
    await settleCapture();
    const pill = harness.pill();

    const row = openTypeahead(); // e.g. the top-bar search typeahead — no composer focus
    await vi.advanceTimersByTimeAsync(16);
    expect(pill.style.visibility).not.toBe('hidden');
    row.remove();
    await vi.advanceTimersByTimeAsync(16);
  });
});
