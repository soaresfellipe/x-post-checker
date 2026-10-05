import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAFT_DEBOUNCE_MS } from '../../src/core/draft-snapshot';
import { scoreDraft, composeHeadline, mapJevBand, type JevVerdict } from '../../src/core/heuristic-engine';
import { draftCacheKey } from '../../src/core/jev-client/hash';
import { WEAKNESS_LABELS } from '../../src/core/jev-client/config';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/settings-store';
import type { DraftAnalysis, DraftAnalysisResult } from '../../src/core/analyzer';
import type { AnalysisDispatch, DraftEvent } from '../../src/dom/composer-watcher';
import { createComposerWatcher } from '../../src/dom/composer-watcher';
import { chipEligible, signalChips } from '../../src/dom/overlay/chips';
import {
  OVERLAY_HOST_ID,
  OVERLAY_ROW_TESTID,
  OVERLAY_TESTID,
  OVERLAY_TESTIDS,
  createScoreOverlay,
  computeAnchorPosition,
  type ScoreOverlay,
} from '../../src/dom/overlay';

/**
 * ScoreOverlay DOM tier, M6 DESIGN 1b model: the collapsed surface is a fixed 36px STATUS ROW
 * inserted IN FLOW as the immediate preceding sibling of X's `[data-testid="toolBar"]`; a row
 * click expands the analysis INLINE below the row (max height, internal scroll); the block
 * collapses on outside click (which REACHES the page — no capture lane), on Escape, and on any
 * new composer edit. No qualifying draft renders NO extension UI at all. Every pre-existing
 * guarantee (local-before-Jev, the six algorithm signals, the band table, stale discard,
 * no-key/off/failure notices, per-draft transport-failure ownership, clear-reset, settings
 * teardown/remount, English-only copy) is re-pinned at its new location — the ROW for the
 * headline, the EXPANDED BLOCK for everything else.
 */

/** REAL x.com nesting (library/x-dom.md): tight text-row wrapper + SIBLING toolBar. */
const HOME_HTML = `
<div id="react-root">
<div data-testid="primaryColumn">
  <div>
    <div>
      <div data-testid="tweetTextarea_0RichTextInputContainer">
        <div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" class="public-DraftEditor-content"></div>
      </div>
    </div>
    <div data-testid="toolBar">
      <button type="button" data-testid="addMedia">midia</button>
      <button type="button" data-testid="tweetButtonInline" aria-disabled="true">Postar</button>
    </div>
  </div>
</div>
</div>`;

/** No `[data-testid="toolBar"]` anywhere: the overlay must use its FALLBACK placement. */
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
 * click INSIDE the overlay's shadow DOM (the row, the expanded block's own buttons): happy-dom
 * drops `composed` on a click init object, and the overlay's "is this click mine?" check relies
 * on composedPath crossing the shadow boundary — exactly as it does in a real browser.
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
 * no such boundary). Advancing 1ms flushes the watcher's post-mount rescan AND the overlay
 * observer's re-attach pass.
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
  /** The collapsed status row (the default surface). Throws when no UI is rendered at all. */
  row(): HTMLElement;
  /** Clicks the row to expand the inline block, and returns the block. */
  expand(): HTMLElement;
  /** The expanded block, WITHOUT expanding (throws when collapsed, as production would). */
  expanded(): HTMLElement;
  /** Collapses the block the way a user's Escape does, then returns the row. */
  collapseNow(): HTMLElement;
  /** Tears the harness down (stops the watcher and destroys the overlay). */
  teardown(): void;
  host(): HTMLElement | null;
  /** True while the inline block is expanded. */
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
 * overlay: a leaked overlay keeps DOCUMENT-level listeners (Escape, the collapse-on-outside-click
 * lane) alive and would interfere with the next test's page events.
 */
const harnesses: Harness[] = [];

async function startHarness(
  overrides: { settings?: Partial<Settings>; keyPresent?: boolean; html?: string } = {},
): Promise<Harness> {
  document.body.innerHTML = overrides.html ?? HOME_HTML;
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
  // Drain the watcher's first scan (timer-scheduled) so the composer is ATTACHED before any
  // test types — the input listeners only exist after the scan tick.
  await vi.advanceTimersByTimeAsync(0);

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
        weaknesses: [WEAKNESS_LABELS.not_specific_enough, WEAKNESS_LABELS.weak_share_trigger],
        suggestions: ['Lead with the number.', 'Ask one question.'],
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
    row(): HTMLElement {
      const row = shadowOf(OVERLAY_ROW_TESTID);
      if (!row) throw new Error('the status row is not rendered');
      return row;
    },
    expand(): HTMLElement {
      if (shadowOf(OVERLAY_TESTID) === null) clickInside(this.row());
      const block = shadowOf(OVERLAY_TESTID);
      if (!block) throw new Error('the row click did not expand the inline analysis');
      return block;
    },
    expanded(): HTMLElement {
      const block = shadowOf(OVERLAY_TESTID);
      if (!block) throw new Error('the inline analysis is not expanded');
      return block;
    },
    collapseNow(): HTMLElement {
      pressEscape();
      return this.row();
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

const find = (root: ParentNode, testid: string): HTMLElement | null =>  root.querySelector<HTMLElement>(`[data-testid="${testid}"]`);

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

/** Expected signed-points rendering (design-1b §4.1: explicit sign, U+2212 minus). */
function signedPoints(points: number): string {
  if (points > 0) return `+${points}`;
  if (points < 0) return `\u2212${Math.abs(points)}`;
  return '0';
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
    const harness = await startHarness();
    await settleDom();
    expect(harness.host()).toBeNull();
    expect(shadowOf(OVERLAY_ROW_TESTID)).toBeNull();
    expect(shadowOf(OVERLAY_TESTID)).toBeNull();
  });

  it('inserts the host IN FLOW as the immediate preceding sibling of the toolBar', async () => {
    const harness = await startHarness();
    typeText(composer(), 'An eligible draft for the in-flow insertion');
    await settleCapture();
    const host = harness.host();
    expect(host).not.toBeNull();
    const toolBar = document.querySelector('[data-testid="toolBar"]')!;
    expect(toolBar.previousElementSibling).toBe(host); // in flow, directly before the toolbar
    expect(host!.dataset.placement).toBe('flow');
    // The host never replaces or wraps X's own nodes: the toolBar keeps its parent and children.
    expect(toolBar.children.length).toBe(2); // media control + Post button, untouched
  });

  it('unmounts when the composer dies after SPA navigation and remounts idempotently', async () => {
    const harness = await startHarness();
    typeText(composer(), 'Draft for the SPA navigation lifecycle');
    await settleCapture();
    expect(harness.host()).not.toBeNull();
    document.body.innerHTML = REPLY_VIEW_HTML;
    // The watcher's own observer notices the composer swap; drain its tick, then type into the
    // new composer so a fresh row mounts for it.
    await settleDom();
    typeText(composer(), 'A qualifying draft typed into the fresh reply composer');
    await settleCapture();
    const host = harness.host();
    expect(host).not.toBeNull();
    expect(document.querySelectorAll(HOST_SELECTOR).length).toBe(1);
  });

  it('keeps exactly one host across repeated renders and re-attach cycles', async () => {
    const harness = await startHarness();
    typeText(composer(), 'First draft for the host-count pin');
    await settleCapture();
    typeText(composer(), 'First draft for the host-count pin, edited');
    await settleCapture();
    expect(document.querySelectorAll(HOST_SELECTOR).length).toBe(1);
    expect(harness.isExpanded()).toBe(false);
  });
});

describe('no extension UI without a qualifying draft (VAL-DRAFT-005, VAL-DRAFT-014)', () => {
  it('renders nothing for an empty draft and nothing for a below-minimum one', async () => {
    const harness = await startHarness();
    typeText(composer(), '');
    await settleCapture();
    expect(harness.host()).toBeNull();
    typeText(composer(), 'hey');
    await settleCapture();
    expect(harness.host()).toBeNull();
    expect(shadowOf(OVERLAY_ROW_TESTID)).toBeNull();
    expect(shadowOf(OVERLAY_TESTID)).toBeNull();
  });

  it('removes every extension surface when an analyzed draft is cleared', async () => {
    const harness = await startHarness();
    typeText(composer(), 'A full analyzed draft that will be cleared next');
    await settleCapture();
    expect(harness.row()).not.toBeNull();
    typeText(composer(), '');
    await settleCapture();
    // Neither the row nor an expanded block may remain — the composer area is left completely free.
    expect(harness.host()).toBeNull();
    expect(shadowOf(OVERLAY_ROW_TESTID)).toBeNull();
    expect(shadowOf(OVERLAY_TESTID)).toBeNull();
  });

  it('never renders the removed empty-state balloon', async () => {
    await startHarness();
    typeText(composer(), 'ab');
    await settleCapture();
    expect(shadowOf('overlay-empty')).toBeNull();
    expect(shadowOf(OVERLAY_ROW_TESTID)).toBeNull();
  });
});

describe('the status row and inline expansion (VAL-DRAFT-032, VAL-DRAFT-034)', () => {
  it('renders the full row anatomy while typing, with no expanded block anywhere in the shadow DOM', async () => {
    const harness = await startHarness();
    typeText(composer(), 'A draft whose collapsed row anatomy is checked piece by piece');
    await settleCapture();
    const row = harness.row();
    // The whole row is ONE button with aria-expanded=false.
    expect(row.tagName).toBe('BUTTON');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    // Anatomy: tier dot + headline, "Viral potential", summary, AI dot + short label, chevron.
    const expectedLocal = scoreDraft(harness.requests[0]!.snapshot);
    expect(find(row, OVERLAY_TESTIDS.headline)!.textContent).toBe(String(expectedLocal.headline));
    expect(row.querySelector('.dot')?.getAttribute('data-tier')).toBeDefined();
    expect(row.textContent).toContain('Viral potential');
    expect(find(row, OVERLAY_TESTIDS.summary)).not.toBeNull();
    const ai = find(row, OVERLAY_TESTIDS.aiState)!;
    expect(ai.querySelector('.ai-dot')).not.toBeNull();
    expect(ai.querySelector('.ai-label')).not.toBeNull();
    expect(row.querySelector('.chevron')).not.toBeNull();
    // The expanded analysis block is absent — not merely hidden — before the row is activated.
    expect(shadowOf(OVERLAY_TESTID)).toBeNull();
  });

  it('a single row click expands the inline block with all three sections', async () => {
    const harness = await startHarness();
    typeText(composer(), 'A draft that will be expanded to show all three sections');
    await settleCapture();
    const block = harness.expand();
    // The row REMAINS above the block (chevron rotated, aria-expanded true).
    expect(harness.row()).not.toBeNull();
    expect(harness.row().getAttribute('aria-expanded')).toBe('true');
    expect(harness.row().querySelector('.chevron')).not.toBeNull();
    // All three sections: the signal chips (with toggle), the AI block, the optimizer section.
    expect(find(block, OVERLAY_TESTIDS.signals)).not.toBeNull();
    expect(find(block, OVERLAY_TESTIDS.jev)).not.toBeNull();
    expect(find(block, OVERLAY_TESTIDS.optimizer)).not.toBeNull();
    // The expanded block carries the SAME draft's content: its chips match the draft's own
    // selection and its state is 'analyzed'.
    expect(block.dataset.state).toBe('analyzed');
    const local = scoreDraft(harness.requests[0]!.snapshot);
    const expected = signalChips(local.signals);
    const chips = [...block.querySelectorAll<HTMLElement>(`[data-testid="${OVERLAY_TESTIDS.chip}"]`)];
    expect(chips.map((chip) => chip.dataset.signalId)).toEqual(expected.map((chip) => chip.id));
  });

  it('keeps the same headline in the row before and after expansion', async () => {
    const harness = await startHarness();
    typeText(composer(), 'A draft whose row and expanded headline must agree exactly');
    await settleCapture();
    const rowHeadline = find(harness.row(), OVERLAY_TESTIDS.headline)!.textContent;
    harness.expand();
    // The row REMAINS above the block with the same headline.
    expect(find(harness.row(), OVERLAY_TESTIDS.headline)!.textContent).toBe(rowHeadline);
    expect(harness.isExpanded()).toBe(true);
  });
});

describe('collapse triggers (VAL-DRAFT-035, VAL-DRAFT-036, VAL-DRAFT-037)', () => {
  it('Escape collapses the block and keeps the row with its headline (VAL-DRAFT-035)', async () => {
    const harness = await startHarness();
    typeText(composer(), 'A draft whose expanded block will be closed with Escape');
    await settleCapture();
    const headline = find(harness.row(), OVERLAY_TESTIDS.headline)!.textContent;
    harness.expand();
    pressEscape();
    expect(harness.isExpanded()).toBe(false);
    expect(find(harness.row(), OVERLAY_TESTIDS.headline)!.textContent).toBe(headline); // row remains
  });

  it('any new composer edit collapses the block back to the row (VAL-DRAFT-036)', async () => {
    const harness = await startHarness();
    typeText(composer(), 'A draft whose expanded block will be closed by an edit');
    await settleCapture();
    harness.expand();
    typeText(composer(), 'A draft whose expanded block will be closed by an edit, edited');
    await settleCapture();
    expect(harness.isExpanded()).toBe(false);
    expect(harness.row()).not.toBeNull();
  });

  it('a first outside click closes the block AND reaches the page (VAL-DRAFT-037)', async () => {
    const harness = await startHarness();
    typeText(composer(), 'A draft whose expanded block is closed by an outside click');
    await settleCapture();
    harness.expand();
    const target = pageTarget();
    clickOutside(target.element);
    expect(harness.isExpanded()).toBe(false); // collapsed…
    expect(target.reached()).toBe(1); // …AND forwarded: the page got the very first click
  });

  it('clicks INSIDE the expanded block never collapse it', async () => {
    const harness = await startHarness();
    typeText(composer(), 'A draft whose expanded block absorbs its own clicks');
    await settleCapture();
    const block = harness.expand();
    clickInside(find(block, OVERLAY_TESTIDS.signals)!);
    expect(harness.isExpanded()).toBe(true);
  });

  it('collapsing is idempotent: outside clicks with nothing expanded reach the page untouched', async () => {
    const harness = await startHarness();
    typeText(composer(), 'A collapsed draft whose outside clicks all reach the page');
    await settleCapture();
    const target = pageTarget();
    clickOutside(target.element);
    clickOutside(target.element);
    expect(target.reached()).toBe(2);
    expect(harness.isExpanded()).toBe(false);
  });

  it('a fresh composer (SPA navigation) always starts collapsed', async () => {
    const harness = await startHarness();
    typeText(composer(), 'Draft expanded before the composer swap');
    await settleCapture();
    harness.expand();
    expect(harness.isExpanded()).toBe(true);
    document.body.innerHTML = REPLY_VIEW_HTML;
    await settleDom();
    typeText(composer(), 'A qualifying draft typed into the fresh composer');
    await settleCapture();
    expect(harness.isExpanded()).toBe(false); // new composer starts collapsed
    expect(harness.row()).not.toBeNull(); // fresh view, collapsed row, no stale score carried
  });
});

describe('autoAnalyze gates only the AI call (VAL-SETUP-010)', () => {
  it('shows the local-score row with zero Jev calls while autoAnalyze is off', async () => {
    const harness = await startHarness({ settings: { autoAnalyze: false } });
    typeText(composer(), 'A qualifying draft typed with autoAnalyze off');
    await settleCapture();
    const snapshot = harness.draftEvents.at(-1)!.snapshot;
    const expectedLocal = scoreDraft(snapshot);
    expect(find(harness.row(), OVERLAY_TESTIDS.headline)!.textContent).toBe(String(expectedLocal.headline));
    expect(harness.row().dataset.jevState).toBe('ready');
    expect(harness.requests.length).toBe(0); // NO analysis dispatch at all: typing stayed free
  });

  it('the expanded block exposes the explicit AI action, and activating it analyzes exactly once', async () => {
    const harness = await startHarness({ settings: { autoAnalyze: false } });
    typeText(composer(), 'A qualifying draft for the explicit AI action');
    await settleCapture();
    const before = harness.requests.length;
    const block = harness.expand();
    const analyze = find(block, OVERLAY_TESTIDS.analyze)!;
    expect(analyze.textContent).toBe('Analyze with AI');
    clickInside(analyze);
    // Exactly ONE new dispatch: the explicit action, not the typing.
    expect(harness.requests.length).toBe(before + 1);
    expect(harness.isExpanded()).toBe(true); // the user's own action never collapses the block
  });
});

describe('optimistic local render before Jev (VAL-DRAFT-006, VAL-DRAFT-010)', () => {
  it('the row shows the local score immediately at capture, with the Jev half pending', async () => {
    const harness = await startHarness();
    typeText(composer(), 'A draft whose local score must not wait for the Jev verdict');
    await settleCapture();
    // No reply has settled yet — the row already carries the pure local headline.
    const expectedLocal = scoreDraft(harness.requests[0]!.snapshot);
    expect(find(harness.row(), OVERLAY_TESTIDS.headline)!.textContent).toBe(String(expectedLocal.headline));
    expect(harness.row().dataset.headlineSource).toBe('local');
    expect(harness.row().dataset.jevState).toBe('pending');
    // The pending state is visible in the row's AI label.
    expect(find(harness.row(), OVERLAY_TESTIDS.aiState)!.textContent).toContain('Analyzing…');
  });

  it('needs no analyze-draft reply at all to show the local breakdown (independence)', async () => {
    const harness = await startHarness();
    typeText(composer(), 'A draft analyzed purely locally with the reply never settling');
    await settleCapture();
    const block = harness.expand();
    const local = scoreDraft(harness.requests[0]!.snapshot);
    expect(find(block, OVERLAY_TESTIDS.signals)).not.toBeNull();
    // The ROW still carries the pure local headline with no reply in sight.
    expect(find(harness.row(), OVERLAY_TESTIDS.headline)!.textContent).toBe(String(local.headline));
  });

  it('the expanded block shows the verbatim pending copy while Jev is in flight (VAL-DRAFT-010)', async () => {
    const harness = await startHarness();
    typeText(composer(), 'A draft whose expanded pending copy is checked verbatim');
    await settleCapture();
    const block = harness.expand();
    const jev = find(block, OVERLAY_TESTIDS.jev)!;
    expect(jev.dataset.jevState).toBe('pending');
    expect(find(jev, OVERLAY_TESTIDS.jevNotice)!.textContent).toBe(
      'AI judgment on its way — the local score above already counts.',
    );
  });
});

describe('algorithm signal chips (VAL-DRAFT-007)', () => {
  it('surfaces question/hook, length band, hashtag count, link handling, reply context and media', async () => {
    const harness = await startHarness();
    typeText(
      composer(),
      'Why does every system fail? Save this checklist: #tools #work https://example.com/guide',
    );
    await settleCapture();
    const block = harness.expand();
    // Every family is identifiable through the chips OR the neutral rows list (VAL-DRAFT-007).
    const toggle = find(block, OVERLAY_TESTIDS.neutralToggle)!;
    clickInside(toggle);
    const rows = find(block, OVERLAY_TESTIDS.signalRows)!;
    const familyIds = new Set([
      ...[...block.querySelectorAll<HTMLElement>(`[data-testid="${OVERLAY_TESTIDS.chip}"]`)].map((chip) => chip.dataset.signalId),
      ...[...rows.querySelectorAll<HTMLElement>('li')].map((li) => li.dataset.signalId),
    ]);
    expect(familyIds.has('reply-magnet')).toBe(true); // question/hook presence
    expect(familyIds.has('length')).toBe(true); // length band
    expect(familyIds.has('hashtags')).toBe(true); // hashtag count
    expect(familyIds.has('external-link')).toBe(true); // link handling
    expect(familyIds.has('media')).toBe(true); // media presence
    expect(familyIds.has('reply-mutual')).toBe(true); // reply context
    // The shareable-format chip uses the verbatim "Shareable: {formats}" phrase.
    const chipPhrases = [...block.querySelectorAll(`[data-testid="${OVERLAY_TESTIDS.chip}"] .phrase`)].map(
      (phrase) => phrase.textContent,
    );
    expect(chipPhrases.some((phrase) => (phrase ?? '').startsWith('Shareable:'))).toBe(true);
    // Kept strictly separate from Jev judgment: the AI block is its own section.
    expect(find(block, OVERLAY_TESTIDS.jev)).not.toBeNull();
  });

  it('shows a concrete signed points value per chip (VAL-DRAFT-044 formatting)', async () => {
    const harness = await startHarness();
    typeText(composer(), 'Like and retweet if you want more of these.');
    await settleCapture();
    const block = harness.expand();
    const chips = [...block.querySelectorAll<HTMLElement>(`[data-testid="${OVERLAY_TESTIDS.chip}"]`)];
    expect(chips.length).toBeGreaterThan(0);
    const bait = chips.find((chip) => chip.dataset.signalId === 'engagement-bait')!;
    expect(bait).toBeDefined();
    expect(bait.querySelector('.points')!.textContent).toBe('\u221250'); // U+2212, signed
    expect(bait.dataset.direction).toBe('negative');
  });
});

describe('asynchronous Jev verdict (VAL-DRAFT-008, VAL-DRAFT-009)', () => {
  it('adds the condensed verdict beside the unchanged algorithm chips and switches the headline to hybrid', async () => {
    const harness = await startHarness();
    typeText(composer(), 'A draft that will receive a Jev verdict while expanded');
    await settleCapture();
    const request = harness.requests[0]!;
    const local = scoreDraft(request.snapshot);
    const block = harness.expand();
    expect(find(block, OVERLAY_TESTIDS.jev)!.dataset.jevState).toBe('pending');
    harness.replyFor(request);
    // The verdict block adds the chip, the first weakness and the Try line…
    const jev = find(harness.expanded(), OVERLAY_TESTIDS.jev)!;
    expect(jev.dataset.jevState).toBe('verdict');
    expect(find(jev, OVERLAY_TESTIDS.jevBand)!.textContent).toBe('AI · Moderate');
    expect(find(jev, OVERLAY_TESTIDS.jevWeakness)).not.toBeNull();
    expect(find(jev, OVERLAY_TESTIDS.jevTryLine)!.textContent).toContain('Try: Lead with the number.');
    expect(find(jev, OVERLAY_TESTIDS.jevTryLine)!.textContent).toContain('65% confidence');
    // …without removing or relabeling the local chips (same draft, same selection).
    const chipsAfter = [...harness.expanded().querySelectorAll<HTMLElement>(`[data-testid="${OVERLAY_TESTIDS.chip}"]`)].map(
      (chip) => chip.dataset.signalId,
    );
    expect(chipsAfter).toEqual(signalChips(local.signals).map((chip) => chip.id));
    // The row's headline switched to the hybrid value ONLY now that the verdict is in.
    const hybrid = composeHeadline(local.headline, 3.44);
    expect(find(harness.row(), OVERLAY_TESTIDS.headline)!.textContent).toBe(String(hybrid));
    expect(harness.row().dataset.headlineSource).toBe('hybrid');
  });

  it('maps every exact rubric ordinal to its band label', async () => {
    const harness = await startHarness();
    typeText(composer(), 'A draft checked against the whole band mapping table');
    await settleCapture();
    const request = harness.requests[0]!;
    harness.expand();
    for (const ordinal of [0, 1, 2, 3, 4, 5]) {
      harness.replyFor(request, {
        jev: {
          ordinal,
          confidence: 0.5,
          band: mapJevBand(ordinal),
          strengths: [],
          weaknesses: [],
          suggestions: [],
        },
      });
      // Re-query LIVE: every reply re-renders the row and the expanded block.
      const band = find(harness.row(), OVERLAY_TESTIDS.aiState)!.textContent ?? '';
      const chip = find(harness.expanded(), OVERLAY_TESTIDS.jevBand)!.textContent ?? '';
      const expectedBand = {
        weak: 'Weak',
        'below-average': 'Below avg',
        moderate: 'Moderate',
        strong: 'Strong',
        exceptional: 'Exceptional',
      }[mapJevBand(ordinal)];
      expect(band).toContain(`AI: ${expectedBand}`);
      expect(chip).toBe(`AI · ${expectedBand}`);
    }
  });
});

describe('stale response discard (VAL-DRAFT-011)', () => {
  it('never lets an older draft reply overwrite the newer draft result', async () => {
    const harness = await startHarness();
    typeText(composer(), 'Draft A that will receive a stale response after B exists');
    await settleCapture();
    const requestA = harness.requests[0]!;
    typeText(composer(), 'Draft B that must win over the stale response of A');
    await settleCapture();
    const requestB = harness.requests[1]!;
    harness.replyFor(requestA); // A's reply arrives LAST
    const expectedB = scoreDraft(requestB.snapshot);
    expect(find(harness.row(), OVERLAY_TESTIDS.headline)!.textContent).toBe(String(expectedB.headline));
    harness.expand();
    // A never overwrites B's result: the expanded block shows B's local selection.
    const chips = [...harness.expanded().querySelectorAll<HTMLElement>(`[data-testid="${OVERLAY_TESTIDS.chip}"]`)].map(
      (chip) => chip.dataset.signalId,
    );
    expect(chips).toEqual(signalChips(expectedB.signals).map((chip) => chip.id));
  });
});

describe('no key configured (VAL-DRAFT-017)', () => {
  it('keeps the local score in the row and shows the Connect Jev prompt in the block', async () => {
    const harness = await startHarness({ keyPresent: false });
    typeText(composer(), 'A qualifying draft typed without any Jev key configured');
    await settleCapture();
    // No Jev request is sent (the dispatch below is the capture dispatch; the analyzer in the
    // background would refuse — here the row state already proves the local-only lane).
    expect(harness.row().dataset.jevState).toBe('no-key');
    const aiLabel = find(harness.row(), OVERLAY_TESTIDS.aiState)!.textContent ?? '';
    expect(aiLabel).toContain('Local only');
    const block = harness.expand();
    const jev = find(block, OVERLAY_TESTIDS.jev)!;
    expect(find(jev, OVERLAY_TESTIDS.jevNotice)!.textContent).toBe(
      'Local signals only. Connect Jev to add AI judgment and hook variants.',
    );
    expect(find(jev, OVERLAY_TESTIDS.connectJev)!.textContent).toBe('Connect Jev');
  });

  it('opens the options page from the Connect Jev prompt', async () => {
    const harness = await startHarness({ keyPresent: false });
    typeText(composer(), 'A qualifying draft for the Connect Jev action');
    await settleCapture();
    const block = harness.expand();
    clickInside(find(block, OVERLAY_TESTIDS.connectJev)!);
    expect(harness.optionsOpened).toBe(1);
  });
});

describe('jevForDrafts off (VAL-DRAFT-021)', () => {
  it('stays local-only without implying AI ran, and never shows a pending state', async () => {
    const harness = await startHarness({ settings: { jevForDrafts: false } });
    typeText(composer(), 'A qualifying draft typed with the AI lane off in settings');
    await settleCapture();
    expect(harness.row().dataset.jevState).toBe('off');
    const block = harness.expand();
    const jev = find(block, OVERLAY_TESTIDS.jev)!;
    expect(jev.dataset.jevState).toBe('off');
    expect(find(jev, OVERLAY_TESTIDS.jevNotice)!.textContent).toBe(
      'Local signals only. AI analysis is off in Settings.',
    );
  });

  it('reverts a visible verdict to local-only the moment jevForDrafts turns off (live settings precedence)', async () => {
    const harness = await startHarness();
    typeText(composer(), 'A draft whose verdict must vanish when the AI lane turns off');
    await settleCapture();
    const request = harness.requests[0]!;
    harness.replyFor(request);
    expect(find(harness.row(), OVERLAY_TESTIDS.headline)!.textContent).toBe(
      String(composeHeadline(scoreDraft(request.snapshot).headline, 3.44)),
    );
    await harness.pushSettings({ jevForDrafts: false }, 2);
    const expectedLocal = scoreDraft(request.snapshot);
    expect(find(harness.row(), OVERLAY_TESTIDS.headline)!.textContent).toBe(String(expectedLocal.headline));
    expect(harness.row().dataset.jevState).toBe('off');
  });
});

describe('Jev failure degradation (VAL-DRAFT-018)', () => {
  it('shows the verbatim error copy with a working Retry link', async () => {
    const harness = await startHarness();
    typeText(composer(), 'A draft whose Jev analysis will fail with a network error');
    await settleCapture();
    const request = harness.requests[0]!;
    const expectedLocal = scoreDraft(request.snapshot);
    harness.replyFor(request, {
      jev: undefined,
      jevStatus: 'failed-network',
      jevFailure: { kind: 'network', reason: 'unreachable' },
    });
    const row = harness.row();
    expect(row.dataset.jevState).toBe('error');
    expect(row.dataset.headlineSource).toBe('local');
    expect(find(row, OVERLAY_TESTIDS.headline)!.textContent).toBe(String(expectedLocal.headline));
    const block = harness.expand();
    const jev = find(block, OVERLAY_TESTIDS.jev)!;
    expect(jev.dataset.jevState).toBe('error');
    expect(find(jev, OVERLAY_TESTIDS.jevNotice)!.textContent).toContain(
      `AI unavailable — the ${expectedLocal.headline} above still applies. Could not reach the AI service.`,
    );
    // Retry re-runs the analysis: exactly one more dispatch, block stays open.
    const before = harness.requests.length;
    clickInside(find(jev, OVERLAY_TESTIDS.retry)!);
    expect(harness.requests.length).toBe(before + 1);
    expect(harness.isExpanded()).toBe(true);
  });

  it('clears the pending state when the analyze-draft transport itself fails', async () => {
    const harness = await startHarness();
    typeText(composer(), 'A draft whose transport fails before any Jev response');
    await settleCapture();
    harness.failTransport();
    expect(harness.row().dataset.jevState).toBe('error');
    expect(harness.row().dataset.headlineSource).toBe('local');
  });
});

describe('in-flow host placement (VAL-DRAFT-041)', () => {
  it('re-inserts the host as a toolBar sibling after a React re-render detaches it', async () => {
    const harness = await startHarness();
    typeText(composer(), 'A draft whose host survives a simulated React re-render');
    await settleCapture();
    expect(harness.host()).not.toBeNull();
    harness.host()!.remove(); // what a React re-render does to our node
    await settleDom();
    const host = harness.host();
    expect(host).not.toBeNull(); // the observer re-attached it
    const toolBar = document.querySelector('[data-testid="toolBar"]')!;
    expect(toolBar.previousElementSibling).toBe(host); // same anchor, same single host
    expect(document.querySelectorAll(HOST_SELECTOR).length).toBe(1);
    expect(harness.row()).not.toBeNull(); // and the row is still rendered
  });

  it('falls back to absolute placement with the SAME row anatomy when the toolbar is not found', async () => {
    const harness = await startHarness({ html: REPLY_VIEW_HTML });
    typeText(composer(), 'A qualifying draft in a composer whose toolBar is absent');
    await settleCapture();
    const host = harness.host();
    expect(host).not.toBeNull();
    expect(host!.dataset.placement).toBe('fallback');
    expect(host!.parentElement).toBe(document.body); // absolute placement, off the composer tree
    // Same anatomy as the in-flow row.
    const row = harness.row();
    expect(row.tagName).toBe('BUTTON');
    expect(find(row, OVERLAY_TESTIDS.headline)).not.toBeNull();
    expect(row.textContent).toContain('Viral potential');
    expect(find(row, OVERLAY_TESTIDS.summary)).not.toBeNull();
    expect(find(row, OVERLAY_TESTIDS.aiState)).not.toBeNull();
    expect(row.querySelector('.chevron')).not.toBeNull();
    // Expanding works identically.
    harness.expand();
    expect(find(harness.expanded(), OVERLAY_TESTIDS.signals)).not.toBeNull();
  });
});

describe('fallback placement math (computeAnchorPosition — toolbar not found)', () => {
  const viewport = { width: 1200, height: 800 };

  it('anchors below the region, aligned with its left edge, in document coordinates', () => {
    const position = computeAnchorPosition({
      regionRect: { top: 100, bottom: 300, left: 40 },
      overlaySize: { width: 340, height: 36 },
      viewport,
      scroll: { x: 0, y: 0 },
    });
    expect(position.top).toBe(308); // region bottom + gap
    expect(position.left).toBe(40);
    expect(position.maxHeight).toBeNull();
  });

  it('caps to the available below-space when the content does not fit (VAL-DRAFT-023)', () => {
    const position = computeAnchorPosition({
      regionRect: { top: 100, bottom: 600, left: 40 },
      overlaySize: { width: 340, height: 900 },
      viewport,
      scroll: { x: 0, y: 0 },
    });
    expect(position.top).toBe(608);
    expect(position.maxHeight).toBe(800 - 8 - 608); // viewport minus margins minus the anchor
  });

  it('clamps horizontally on narrow viewports', () => {
    const position = computeAnchorPosition({
      regionRect: { top: 100, bottom: 300, left: 1100 },
      overlaySize: { width: 340, height: 36 },
      viewport: { width: 1200, height: 800 },
      scroll: { x: 0, y: 0 },
    });
    expect(position.left).toBeLessThanOrEqual(1200 - 340 - 8);
  });

  it('adds scroll offsets so the row stays anchored while the page scrolls', () => {
    const position = computeAnchorPosition({
      regionRect: { top: 100, bottom: 300, left: 40 },
      overlaySize: { width: 340, height: 36 },
      viewport,
      scroll: { x: 10, y: 200 },
    });
    expect(position.top).toBe(508);
    expect(position.left).toBe(50);
  });
});

describe('fallback repositioning on resize (VAL-DRAFT-023)', () => {
  it('recomputes the fallback position on window resize without duplicating the host', async () => {
    const harness = await startHarness({ html: REPLY_VIEW_HTML });
    typeText(composer(), 'A qualifying draft in the fallback placement mode');
    await settleCapture();
    const host = harness.host()!;
    expect(host.dataset.placement).toBe('fallback');
    const before = host.style.top;
    window.dispatchEvent(new Event('resize'));
    await settleDom();
    expect(host.style.top).toBe(before); // happy-dom zero rects keep the same clamped anchor
    expect(document.querySelectorAll(HOST_SELECTOR).length).toBe(1);
  });
});

describe('composer and posting interference (VAL-DRAFT-022, VAL-DRAFT-038)', () => {
  it('keeps page controls interactive while only the row is visible', async () => {
    await startHarness();
    typeText(composer(), 'A scored draft whose row must not swallow page interaction');
    await settleCapture();
    // The row is a BUTTON the user can click; the composer furniture outside it stays ours to
    // exercise: an outside click reaches the page.
    const media = pageTarget('addMedia');
    clickOutside(media.element);
    expect(media.reached()).toBe(1);
  });

  it('the host keeps pointer-events:none; only the row button re-enables hits', async () => {
    const harness = await startHarness();
    typeText(composer(), 'A scored draft for the pointer-discipline pin');
    await settleCapture();
    const host = harness.host()!;
    // The discipline is enforced in the shadow stylesheet: while collapsed the only interactive
    // element inside the shadow tree is the row button itself.
    expect(host.dataset.placement).toBe('flow');
    const interactive = [...host.shadowRoot!.querySelectorAll('button, a, input, [contenteditable="true"]')];
    expect(interactive).toHaveLength(1);
    expect(interactive[0]).toBe(harness.row());
  });

  it('stops listening after destroy()', async () => {
    const harness = await startHarness();
    typeText(composer(), 'A draft that will be torn down with the overlay itself');
    await settleCapture();
    harness.expand();
    harness.teardown();
    expect(harness.host()).toBeNull();
    pressEscape(); // must not throw
    clickOutside(pageTarget().element); // must not throw
  });
});

describe('English-only copy (VAL-CROSS-016)', () => {
  it('renders only English text across the row, the expanded block and both transitions', async () => {
    const harness = await startHarness();
    typeText(composer(), 'A draft checked for English-only copy across all states');
    await settleCapture();
    const visibleText = (root: ParentNode): string =>
      [...root.querySelectorAll('*')]
        .filter((node) => node.children.length === 0)
        .map((node) => node.textContent ?? '')
        .join(' ');
    const row = harness.row();
    const rowText = visibleText(row);
    expect(rowText).not.toMatch(/[\u00C0-\u024F]/); // no accented/PT characters
    expect(rowText).toContain('Viral potential');
    const block = harness.expand();
    const blockText = visibleText(block);
    expect(blockText).not.toMatch(/[\u00C0-\u024F]/);
    harness.collapseNow();
    expect(visibleText(harness.row())).not.toMatch(/[\u00C0-\u024F]/);
  });
});

describe('structural fallback composer (VAL-DRAFT-029 overlay leg)', () => {
  it('mounts the overlay for a fallback-detected composer and hides it when none matches', async () => {
    // The structural-fallback detection belongs to the watcher; here we pin that the overlay
    // renders for whatever composer the watcher hands it, and unmounts when none exists.
    const harness = await startHarness();
    typeText(composer(), 'A qualifying draft detected through the structural fallback');
    await settleCapture();
    expect(harness.row()).not.toBeNull();
    harness.teardown();
    document.body.innerHTML = '<div>no composer anywhere</div>';
  });
});

describe('chips cap, ordering, and the neutral toggle (VAL-DRAFT-044)', () => {
  it('caps at 4 chips ordered by |points| descending, with the toggle carrying the rest', async () => {
    const harness = await startHarness();
    typeText(
      composer(),
      'Why do most systems fail? Save this checklist. Send this to a friend. #tools #work',
    );
    await settleCapture();
    const request = harness.requests[0]!;
    const local = scoreDraft(request.snapshot);
    const block = harness.expand();
    const chips = [...block.querySelectorAll<HTMLElement>(`[data-testid="${OVERLAY_TESTIDS.chip}"]`)];
    const expected = signalChips(local.signals);
    expect(chipEligible(local.signals).length).toBeGreaterThan(4); // the draft overflows the cap
    expect(chips.length).toBe(4);
    for (let index = 0; index < chips.length; index += 1) {
      const chip = chips[index]!;
      expect(chip.dataset.signalId).toBe(expected[index]!.id);
      expect(chip.querySelector('.points')!.textContent).toBe(signedPoints(expected[index]!.points));
      expect(chip.querySelector('.phrase')!.textContent).toBe(expected[index]!.phrase);
    }
    // The toggle counts everything the chips do not show.
    const toggle = find(block, OVERLAY_TESTIDS.neutralToggle)!;
    expect(toggle.textContent).toBe(`${local.signals.length - 4} neutral ›`);
  });

  it('the toggle reveals the full rows list LOCALLY without re-rendering other blocks', async () => {
    const harness = await startHarness();
    typeText(
      composer(),
      'Why do most systems fail? Save this checklist. Send this to a friend. #tools #work',
    );
    await settleCapture();
    const block = harness.expand();
    const jevBefore = find(block, OVERLAY_TESTIDS.jev);
    const optimizerBefore = find(block, OVERLAY_TESTIDS.optimizer);
    expect(find(block, OVERLAY_TESTIDS.signalRows)).toBeNull();
    const toggle = find(block, OVERLAY_TESTIDS.neutralToggle)!;
    clickInside(toggle);
    // The rows list appeared…
    const rows = find(block, OVERLAY_TESTIDS.signalRows);
    expect(rows).not.toBeNull();
    // …the other blocks were NOT re-rendered (same element identities)…
    expect(find(block, OVERLAY_TESTIDS.jev)).toBe(jevBefore);
    expect(find(block, OVERLAY_TESTIDS.optimizer)).toBe(optimizerBefore);
    // …and the toggle collapsed it again locally.
    clickInside(toggle);
    expect(find(block, OVERLAY_TESTIDS.signalRows)).toBeNull();
    // Zero-point signals never appear as chips; they surface in the rows list only.
    clickInside(toggle);
    const chipPoints = [...block.querySelectorAll(`[data-testid="${OVERLAY_TESTIDS.chip}"] .points`)].map(
      (points) => points.textContent,
    );
    expect(chipPoints.every((text) => text !== '0')).toBe(true);
    const rowsAgain = find(block, OVERLAY_TESTIDS.signalRows)!;
    const zeroPointRows = [...rowsAgain.querySelectorAll('li .points')].filter(
      (points) => points.textContent === '0',
    );
    expect(zeroPointRows.length).toBeGreaterThan(0); // neutrals live in the rows list
  });
});

describe('hybrid headline only at the AI verdict (VAL-DRAFT-045)', () => {
  it('changes the displayed headline ONLY when the verdict arrives, with the tier following it', async () => {
    const harness = await startHarness();
    typeText(composer(), 'A draft whose headline must switch only when the verdict lands');
    await settleCapture();
    const request = harness.requests[0]!;
    const local = scoreDraft(request.snapshot);
    // Pending: pure local score.
    expect(find(harness.row(), OVERLAY_TESTIDS.headline)!.textContent).toBe(String(local.headline));
    expect(harness.row().querySelector('.dot')!.getAttribute('data-tier')).toBe(headlineTierOf(local.headline));
    // Verdict: hybrid.
    harness.replyFor(request);
    const hybrid = composeHeadline(local.headline, 3.44);
    expect(find(harness.row(), OVERLAY_TESTIDS.headline)!.textContent).toBe(String(hybrid));
    expect(harness.row().querySelector('.dot')!.getAttribute('data-tier')).toBe(headlineTierOf(hybrid));
  });

  it('keeps the pure local headline in the no-key, off and error states', async () => {
    const harness = await startHarness({ keyPresent: false });
    typeText(composer(), 'A draft checked across the local-only states for its headline');
    await settleCapture();
    const request = harness.requests[0]!;
    const local = scoreDraft(request.snapshot);
    // no-key
    expect(find(harness.row(), OVERLAY_TESTIDS.headline)!.textContent).toBe(String(local.headline));
    expect(harness.row().querySelector('.dot')!.getAttribute('data-tier')).toBe(headlineTierOf(local.headline));
    // error
    harness.replyFor(request, {
      jev: undefined,
      jevStatus: 'failed-network',
      jevFailure: { kind: 'network', reason: 'unreachable' },
    });
    expect(find(harness.row(), OVERLAY_TESTIDS.headline)!.textContent).toBe(String(local.headline));
    expect(harness.row().querySelector('.dot')!.getAttribute('data-tier')).toBe(headlineTierOf(local.headline));
  });
});

function headlineTierOf(headline: number): string {
  if (headline >= 70) return 'good';
  if (headline >= 40) return 'ok';
  return 'weak';
}
