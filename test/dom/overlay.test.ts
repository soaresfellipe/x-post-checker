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
  OVERLAY_TESTID,
  createScoreOverlay,
  computeAnchorPosition,
  type ScoreOverlay,
} from '../../src/dom/overlay';

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
  panel(): HTMLElement;
  host(): HTMLElement | null;
}

interface ReplyOverrides {
  /** Explicitly `undefined` means "this analysis produced no verdict" (skipped/failed halves). */
  jev?: JevVerdict;
  jevStatus?: DraftAnalysis['meta']['jevStatus'];
  jevFailure?: DraftAnalysis['meta']['jevFailure'];
  analyzedAt?: number;
}

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

  return {
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
    panel(): HTMLElement {
      const panel = document
        .querySelector<HTMLElement>(HOST_SELECTOR)
        ?.shadowRoot?.querySelector<HTMLElement>(`[data-testid="${OVERLAY_TESTID}"]`);
      if (!panel) throw new Error('overlay panel is not mounted');
      return panel;
    },
    host(): HTMLElement | null {
      return document.querySelector<HTMLElement>(HOST_SELECTOR);
    },
  };
}

const find = (root: ParentNode, testid: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-testid="${testid}"]`);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('overlay host lifecycle', () => {
  it('mounts exactly one Shadow-DOM host on document.body, outside the React tree', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);

    const host = harness.host();
    expect(host).not.toBeNull();
    expect(host!.parentElement).toBe(document.body);
    expect(host!.shadowRoot).not.toBeNull();
    // Never inside the React-managed app subtree.
    expect(document.getElementById('react-root')!.contains(host!)).toBe(false);
    expect(document.querySelectorAll(HOST_SELECTOR)).toHaveLength(1);
    expect(harness.panel().dataset.state).toBe('empty');
  });

  it('unmounts when the composer dies after SPA navigation and remounts idempotently', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.host()).not.toBeNull();

    await settleDom(); // flush the watcher's post-mount rescan before surgery
    document.body.innerHTML = '<div data-testid="primaryColumn"><p>timeline only</p></div>';
    await settleDom();
    expect(harness.host()).toBeNull(); // no overlay remains for a dead composer

    document.body.innerHTML = REPLY_VIEW_HTML;
    await settleDom();
    expect(document.querySelectorAll(HOST_SELECTOR)).toHaveLength(1);
    expect(harness.panel().dataset.state).toBe('empty'); // fresh view, no stale score
  });

  it('resets to the empty state and drops stale analysis when the composer changes', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft long enough to be analyzed');
    await settleCapture();
    harness.replyFor(harness.requests[0]!);
    expect(harness.panel().dataset.state).toBe('analyzed');

    await settleDom();
    document.body.innerHTML = REPLY_VIEW_HTML;
    await settleDom();
    const panel = harness.panel();
    expect(panel.dataset.state).toBe('empty');
    expect(find(panel, 'overlay-gauge')).toBeNull();
    expect(find(panel, 'overlay-jev')).toBeNull();
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

describe('empty state (VAL-DRAFT-005, VAL-DRAFT-014)', () => {
  it('shows the empty/awaiting state on load with no score elements', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    const panel = harness.panel();
    expect(panel.dataset.state).toBe('empty');
    expect(find(panel, 'overlay-empty')!.textContent).toContain('Type a post to see its viral-potential score.');
    expect(find(panel, 'overlay-gauge')).toBeNull();
    expect(find(panel, 'overlay-signals')).toBeNull();
    expect(find(panel, 'overlay-jev')).toBeNull();
  });

  it('keeps drafts below minDraftLength in the empty state with no analysis request', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), '123456789'); // 9 raw chars; default min is 10
    await settleCapture();
    const panel = harness.panel();
    expect(panel.dataset.state).toBe('empty');
    expect(find(panel, 'overlay-gauge')).toBeNull();
    expect(harness.requests).toHaveLength(0);
  });

  it('returns to the empty state when an analyzed draft is cleared', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'An analyzed draft that is long enough');
    await settleCapture();
    harness.replyFor(harness.requests[0]!);
    expect(harness.panel().dataset.state).toBe('analyzed');

    typeText(composer(), '');
    await settleCapture();
    const panel = harness.panel();
    expect(panel.dataset.state).toBe('empty');
    expect(find(panel, 'overlay-gauge')).toBeNull(); // neither the score...
    expect(find(panel, 'overlay-signals')).toBeNull();
    expect(find(panel, 'overlay-jev')).toBeNull(); // ...nor the verdict may linger
  });
});

describe('manual Analyze affordance when autoAnalyze is off (VAL-SETUP-010)', () => {
  it('shows the ready state with an Analyze button and no score, and never dispatches', async () => {
    const harness = startHarness({ settings: { autoAnalyze: false } });
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft typed with autoAnalyze off');
    await settleCapture();

    const panel = harness.panel();
    expect(panel.dataset.state).toBe('ready');
    const analyze = find(panel, 'overlay-analyze');
    expect(analyze).not.toBeNull();
    expect(analyze!.textContent).toBe('Analyze');
    expect(find(panel, 'overlay-gauge')).toBeNull(); // no analysis UI before activation
    expect(find(panel, 'overlay-signals')).toBeNull();
    expect(find(panel, 'overlay-jev')).toBeNull();
    expect(harness.requests).toHaveLength(0);
  });

  it('analyzes on the button click: manual dispatch, local score, Jev pending', async () => {
    const harness = startHarness({ settings: { autoAnalyze: false } });
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft typed with autoAnalyze off');
    await settleCapture();

    find(harness.panel(), 'overlay-analyze')!.click();
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]!.trigger).toBe('manual');

    const panel = harness.panel();
    expect(panel.dataset.state).toBe('analyzed');
    expect(find(panel, 'overlay-gauge')).not.toBeNull();
    expect(find(panel, 'overlay-jev')!.dataset.jevState).toBe('pending');
  });
});

describe('optimistic local render before Jev (VAL-DRAFT-006, VAL-DRAFT-010)', () => {
  it('renders the local score and breakdown immediately at capture, with the Jev half pending', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'What is the one tool you stopped using this year, and why?');
    await settleCapture();

    const panel = harness.panel();
    expect(panel.dataset.state).toBe('analyzed');
    // Local half: headline equals the pure engine's local headline, labeled as local-only.
    const gauge = find(panel, 'overlay-gauge')!;
    expect(gauge.dataset.headlineSource).toBe('local');
    const expectedLocal = scoreDraft(harness.draftEvents.at(-1)!.snapshot);
    expect(find(panel, 'overlay-headline')!.textContent).toBe(String(expectedLocal.headline));
    expect(find(panel, 'overlay-signals')).not.toBeNull();
    // Jev half: visibly pending, local score retained.
    const jev = find(panel, 'overlay-jev')!;
    expect(jev.dataset.jevState).toBe('pending');
    expect(find(jev, 'overlay-jev-pending')!.textContent).toContain('Analyzing with AI');
  });

  it('needs no analyze-draft reply at all to show the local breakdown (independence)', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'Five lessons from scaling to 1M users: measure, cache, delete, hire slowly, write it down');
    await settleCapture();
    // No reply has been delivered; the overlay still shows the complete local half.
    expect(find(harness.panel(), 'overlay-signals')!.querySelectorAll('li')).not.toHaveLength(0);
  });
});

describe('algorithm signal breakdown (VAL-DRAFT-007)', () => {
  it('lists question/hook, length band, hashtags, link handling, reply context and media as separate signals', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'What changed my year? A daily checklist #focus https://example.com/post #systems');
    await settleCapture();

    const signals = find(harness.panel(), 'overlay-signals')!;
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
    const signals = find(harness.panel(), 'overlay-signals')!;
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
    return harness.panel();
  }

  it('adds the verdict beside the unchanged algorithm breakdown and switches the headline to hybrid', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'What is the one tool you stopped using this year, and why?');
    await settleCapture();
    const request = harness.requests[0]!;
    const localBefore = scoreDraft(request.snapshot);
    const before = harness.panel();
    const signalsHeadingBefore = find(before, 'overlay-signals')!.querySelector('h3')!.textContent;

    harness.replyFor(request);
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

    // Hybrid headline: round(0.6*local + 0.4*(ordinal/5*100)).
    const gauge = find(panel, 'overlay-gauge')!;
    expect(gauge.dataset.headlineSource).toBe('hybrid');
    expect(find(panel, 'overlay-headline')!.textContent).toBe(
      String(Math.round(0.6 * localBefore.headline + 0.4 * ((3.44 / 5) * 100))),
    );
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
    const jev = find(harness.panel(), 'overlay-jev')!;
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
    let panel = harness.panel();
    expect(find(panel, 'overlay-jev-band')!.textContent).toBe('Exceptional');

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
    panel = harness.panel();
    expect(find(panel, 'overlay-jev-band')!.textContent).toBe('Exceptional');
    expect(find(panel, 'overlay-jev')!.textContent).not.toContain('Weak hook');
  });

  it('drops the settled result when the draft changes, showing the new draft locally', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'First eligible draft with a settled verdict');
    await settleCapture();
    harness.replyFor(harness.requests[0]!);
    expect(find(harness.panel(), 'overlay-jev')!.dataset.jevState).toBe('verdict');

    typeText(composer(), 'Second, longer draft that differs from the first one');
    await settleCapture();
    const panel = harness.panel();
    expect(find(panel, 'overlay-gauge')!.dataset.headlineSource).toBe('local');
    expect(find(panel, 'overlay-jev')!.dataset.jevState).toBe('pending'); // its own analysis is in flight
  });
});

describe('no key configured (VAL-DRAFT-017)', () => {
  it('keeps local scoring usable and shows the Connect Jev prompt, never pending', async () => {
    const harness = startHarness({ keyPresent: false });
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A local-only draft long enough to be scored');
    await settleCapture();

    let panel = harness.panel();
    expect(panel.dataset.state).toBe('analyzed');
    expect(find(panel, 'overlay-gauge')!.dataset.headlineSource).toBe('local');
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
    find(find(harness.panel(), 'overlay-jev')!, 'overlay-connect-jev')!.click();
    expect(harness.optionsOpened).toBe(1);
  });
});

describe('jevForDrafts off (VAL-DRAFT-021)', () => {
  it('stays local-only without implying AI ran, and never shows a pending state', async () => {
    const harness = startHarness({ settings: { jevForDrafts: false } });
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft analyzed while AI for drafts is disabled');
    await settleCapture();

    let panel = harness.panel();
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
    expect(find(harness.panel(), 'overlay-jev')!.dataset.jevState).toBe('verdict');
    expect(find(harness.panel(), 'overlay-gauge')!.dataset.headlineSource).toBe('hybrid');

    await harness.pushSettings({ jevForDrafts: false }, 2);

    const panel = harness.panel();
    expect(find(panel, 'overlay-jev')!.dataset.jevState).toBe('off'); // the off state, not the verdict
    expect(find(panel, 'overlay-jev-notice')!.textContent).toContain('AI analysis is off');
    expect(find(panel, 'overlay-jev-band')).toBeNull(); // the AI verdict left the panel
    expect(find(panel, 'overlay-gauge')!.dataset.headlineSource).toBe('local'); // headline reverted
    const local = scoreDraft(harness.requests[0]!.snapshot);
    expect(find(panel, 'overlay-headline')!.textContent).toBe(String(local.headline));
    expect(find(panel, 'overlay-signals')).not.toBeNull(); // local scoring stays available
  });

  it('a late reply cannot re-introduce the verdict once jevForDrafts is off', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'Draft typed while AI for drafts is enabled');
    await settleCapture();
    const request = harness.requests[0]!;

    await harness.pushSettings({ jevForDrafts: false }, 2); // the user disables AI mid-flight
    harness.replyFor(request); // the verdict lands AFTER the setting flipped

    const panel = harness.panel();
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
  ] as const)('keeps the local score usable and shows an explicit notice for %s', async (status, reason) => {
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

    const panel = harness.panel();
    expect(panel.dataset.state).toBe('analyzed');
    expect(find(panel, 'overlay-gauge')).not.toBeNull();
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
    expect(find(harness.panel(), 'overlay-jev')!.dataset.jevState).toBe('error');

    typeText(composer(), 'A second draft whose AI half will succeed');
    await settleCapture();
    harness.replyFor(harness.requests.at(-1)!);
    expect(find(harness.panel(), 'overlay-jev')!.dataset.jevState).toBe('verdict');
  });

  it('clears the pending state when the analyze-draft transport itself fails', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft whose analysis message never gets a reply');
    await settleCapture();
    expect(find(harness.panel(), 'overlay-jev')!.dataset.jevState).toBe('pending');

    harness.failTransport();
    const panel = harness.panel();
    expect(find(panel, 'overlay-gauge')).not.toBeNull(); // the local score stays usable
    expect(find(panel, 'overlay-jev')!.dataset.jevState).toBe('error');
    expect(find(panel, 'overlay-jev')!.textContent).toContain('AI judgment unavailable');
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
    const panel = harness.panel();
    expect(find(panel, 'overlay-jev')!.dataset.jevState).toBe('error'); // never an infinite spinner
    expect(find(panel, 'overlay-jev')!.textContent).toContain('did not respond');
    expect(find(panel, 'overlay-gauge')).not.toBeNull();
    expect(find(panel, 'overlay-gauge')!.dataset.headlineSource).toBe('local');

    // A's late success is unrelated to B: it neither repaints B nor lifts B's error.
    harness.replyFor(requestA, { jev: undefined, jevStatus: 'skipped-no-key' });
    expect(find(harness.panel(), 'overlay-jev')!.dataset.jevState).toBe('error');
    expect(find(harness.panel(), 'overlay-headline')!.textContent).toBe(
      String(scoreDraft(requestB.snapshot).headline),
    );
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
    expect(find(harness.panel(), 'overlay-jev')!.dataset.jevState).toBe('pending'); // B unaffected
    expect(find(harness.panel(), 'overlay-jev-band')).toBeNull(); // no error is shown for B either

    harness.failTransport(requestB); // B's own transport failure settles B
    expect(find(harness.panel(), 'overlay-jev')!.dataset.jevState).toBe('error');
  });

  it('an honest refusal settles its own dispatch, not the oldest one', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'Draft A: what is your favorite database and why does it matter?');
    await settleCapture();
    typeText(composer(), 'Draft B: the one habit that made my writing stick was reading aloud #writing');
    await settleCapture();
    const requestB = harness.requests.at(-1)!;

    // B is refused (e.g. the min-length gate moved mid-flight) while A is still in flight.
    harness.reply({ kind: 'below-min-length', minDraftLength: 400 }, requestB);

    // B's pending state cleared, so with nothing in flight the overlay leaves the analyzed spin
    // for its now-unowned capture: the ready state with the explicit Analyze affordance.
    expect(harness.panel().dataset.state).toBe('ready');
    expect(find(harness.panel(), 'overlay-analyze')).not.toBeNull();
  });
});

describe('settings and key-presence updates without reload (VAL-CROSS-002, VAL-SETUP-016)', () => {
  it('applies a key-presence flip to the next draft through the reply path', async () => {
    const harness = startHarness({ keyPresent: false });
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'Draft one, typed while no key was configured');
    await settleCapture();
    harness.replyFor(harness.requests[0]!, { jev: undefined, jevStatus: 'skipped-no-key' });
    expect(find(harness.panel(), 'overlay-jev')!.dataset.jevState).toBe('no-key');

    // The key is configured elsewhere (Options); presence reaches the tab live.
    harness.setKeyPresent(true);
    typeText(composer(), 'Draft two, typed after the key was configured');
    await settleCapture();
    expect(find(harness.panel(), 'overlay-jev')!.dataset.jevState).toBe('pending');
    harness.replyFor(harness.requests.at(-1)!);
    expect(find(harness.panel(), 'overlay-jev')!.dataset.jevState).toBe('verdict');
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

    await harness.pushSettings({ enabled: true }, 3);
    expect(document.querySelectorAll(HOST_SELECTOR)).toHaveLength(1); // no duplicate overlays
    expect(harness.panel().dataset.state).toBe('empty'); // fresh state after re-enable

    typeText(composer(), 'A draft typed after re-enabling');
    await settleCapture();
    expect(harness.requests).toHaveLength(2);
    harness.replyFor(harness.requests.at(-1)!);
    expect(harness.panel().dataset.state).toBe('analyzed');
  });

  it('stamps the applied settings revision on its host for observability', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    await harness.pushSettings({ minDraftLength: 40 }, 7);
    expect(harness.host()!.dataset.settingsRevision).toBe('7');

    // The raised threshold applies to the current draft without any reload.
    typeText(composer(), 'Only thirty characters remain');
    await settleCapture();
    expect(harness.panel().dataset.state).toBe('empty'); // 30 < 40
    expect(harness.requests).toHaveLength(0);
  });
});

describe('composer and posting interference (VAL-DRAFT-022)', () => {
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
});

describe('repositioning (VAL-DRAFT-023)', () => {
  it('positions the host absolutely below the composer region with viewport clamping', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    const host = harness.host()!;
    expect(host.style.position).toBe('absolute');
    expect(host.style.top).toMatch(/px$/);
    expect(host.style.left).toMatch(/px$/);
  });

  it('recomputes the position on window resize without duplicating the host', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    const host = harness.host()!;
    const before = { top: host.style.top, left: host.style.left };

    window.innerWidth = 320; // narrower than the panel: clamping must engage
    window.dispatchEvent(new Event('resize'));
    await vi.advanceTimersByTimeAsync(16); // the resize path coalesces through rAF

    expect(host.style.left).toBe('8px');
    expect(host.style.left).not.toBe(before.left === '8px' ? '' : before.left);
    expect(document.querySelectorAll(HOST_SELECTOR)).toHaveLength(1);
  });

  it('caps the panel to the viewport with internal scrolling when the window is too short (VAL-DRAFT-023)', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft that is analyzed before the viewport shrinks');
    await settleCapture();
    harness.replyFor(harness.requests[0]!);
    expect(find(harness.panel(), 'overlay-gauge')).not.toBeNull();
    expect(harness.panel().style.maxHeight).toBe(''); // no cap at full height

    // happy-dom reports no layout: the panel measures at its 240px design fallback, which no
    // longer fits a 120px viewport. The cap must clamp the panel INSIDE the viewport.
    window.innerHeight = 120;
    window.dispatchEvent(new Event('resize'));
    await vi.advanceTimersByTimeAsync(16);

    expect(harness.panel().style.maxHeight).toBe('104px'); // 120 - 2*8 margin - 8 gap
    expect(harness.host()!.style.top).toBe('8px'); // still anchored below the region
    expect(document.querySelectorAll(HOST_SELECTOR)).toHaveLength(1); // never a second host

    window.innerHeight = 700;
    window.dispatchEvent(new Event('resize'));
    await vi.advanceTimersByTimeAsync(16);
    expect(harness.panel().style.maxHeight).toBe(''); // the cap releases when space returns
  });

  it('stops listening after destroy()', async () => {
    const harness = startHarness();
    await vi.advanceTimersByTimeAsync(0);
    harness.overlay.destroy();
    expect(harness.host()).toBeNull();
    window.dispatchEvent(new Event('resize'));
    await vi.advanceTimersByTimeAsync(16);
    expect(harness.host()).toBeNull();
  });
});

describe('computeAnchorPosition (pure placement math)', () => {
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
    // Below space = 492 - 128 = 364; above space is zero. Below-first precedence holds and the
    // capped panel ends exactly at the viewport's bottom margin.
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
    expect(position.top).toBe(4352); // folds above the region: 600 + 4000 - 8 - 240, inside the window
    expect(position.left).toBe(40);
  });
});

describe('English-only copy (VAL-CROSS-016)', () => {
  it('renders only English text across the exercised states', async () => {
    const harness = startHarness({ keyPresent: false });
    await vi.advanceTimersByTimeAsync(0);
    const english = /^[A-Za-z0-9 .,:;!?%'"()\-–—/+·…]*$/;

    const visibleText = (root: ParentNode): string =>
      [...root.querySelectorAll('*')].map((node) => node.textContent ?? '').join(' ');

    let text = visibleText(harness.panel());
    expect(text).toMatch(english);

    typeText(composer(), 'What is the one tool you stopped using this year? #focus https://example.com/x');
    await settleCapture();
    text = visibleText(harness.panel());
    expect(text).toMatch(english);
    expect(text).not.toContain('Postar');
    expect(text).not.toContain('Respondendo');

    harness.replyFor(harness.requests[0]!);
    text = visibleText(harness.panel());
    expect(text).toMatch(english);
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
    expect(document.querySelector(HOST_SELECTOR)).not.toBeNull();

    document.body.innerHTML = '<div data-testid="primaryColumn"><p>nothing editable</p></div>';
    await settleDom();
    expect(document.querySelector(HOST_SELECTOR)).toBeNull();
    overlay.destroy();
  });
});
