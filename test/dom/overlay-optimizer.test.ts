import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAFT_DEBOUNCE_MS, type DraftSnapshot } from '../../src/core/draft-snapshot';
import { draftCacheKey } from '../../src/core/jev-client/hash';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/settings-store';
import type { HookVariant, Optimization, OptimizationResult } from '../../src/core/optimizer';
import { OVERLAY_HOST_ID, OVERLAY_PILL_TESTID, createScoreOverlay, type ScoreOverlay } from '../../src/dom/overlay';
import { createComposerWatcher } from '../../src/dom/composer-watcher';

/**
 * The optimizer section of the score overlay (m4-optimizer), DOM-tier: availability gates with
 * clear reasons (VAL-OPT-001), loading -> success/error lifecycle (VAL-OPT-002/010), exact-text
 * clipboard copy (VAL-OPT-004) that never touches the composer (VAL-OPT-005), the over-limit
 * flag (VAL-OPT-007), per-draft identity (stale replies never paint), and the reset on draft
 * change that makes repeat Optimize a cache-served no-op at the API layer (VAL-OPT-009).
 *
 * Migrated to the M5 collapsed-first model: the section lives INSIDE the expanded panel, so every
 * flow now begins with a pill click, and typing a new draft collapses the panel (which each test
 * re-expands). Coverage is unchanged — only its location in the interaction.
 */

const HOME_HTML = `
<div id="react-root">
<div data-testid="primaryColumn">
  <div data-testid="toolBar">
    <div data-testid="tweetTextarea_0RichTextInputContainer">
      <div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" class="public-DraftEditor-content"></div>
    </div>
    <button type="button" data-testid="tweetButtonInline" aria-disabled="true">Postar</button>
  </div>
</div>
</div>`;

const HOST_SELECTOR = `#${OVERLAY_HOST_ID}`;
const DRAFT_TEXT =
  'I spent 30 days replacing my complicated productivity system with one daily checklist. I finish more work now.';

function composer(): Element {
  return document.querySelector('[data-testid="tweetTextarea_0"]')!;
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

function variant(
  kind: HookVariant['kind'],
  text: string,
  probability: number,
  weightedChars = 120,
  overLimit = false,
): HookVariant {
  return { id: kind, kind, text, probability, weightedChars, overLimit };
}

const VARIANT_QUESTION =
  'What happened when I spent 30 days replacing my complicated productivity system with one daily checklist? I finish more work now.';
const VARIANT_STORY = `Here's what happened: ${DRAFT_TEXT}`;

const DEFAULT_VARIANTS: readonly HookVariant[] = [
  variant('question', VARIANT_QUESTION, 0.9),
  variant('story', VARIANT_STORY, 0.7),
];

function optimized(draft: DraftSnapshot, variants: readonly HookVariant[] = DEFAULT_VARIANTS, dropAdvice?: string): OptimizationResult {
  const optimization: Optimization = {
    draftHash: draftCacheKey(draft),
    variants: [...variants],
    hashtags: {
      suggestions: [
        { tag: 'System', rationale: 'Comes straight from your draft ("system").', probability: 0.82 },
        { tag: 'Checklist', rationale: 'Comes straight from your draft ("checklist").', probability: 0.71 },
      ],
      ...(dropAdvice === undefined ? {} : { dropAdvice }),
    },
    source: 'fresh',
    latencyMs: 240,
  };
  return { kind: 'optimized', optimization };
}

interface Harness {
  overlay: ScoreOverlay;
  watcher: ReturnType<typeof createComposerWatcher>;
  optimizeRequests: DraftSnapshot[];
  copied: string[];
  setKeyPresent(present: boolean): void;
  pushSettings(partial: Partial<Settings>): void;
  optimizeReply(result: OptimizationResult, draft?: DraftSnapshot): void;
  optimizeFail(draft?: DraftSnapshot): void;
  /** The expanded panel, clicking the pill first when collapsed (the only way to get it). */
  panel(): HTMLElement;
}

/** Live harnesses, stopped + destroyed after EVERY test: a leaked MutationObserver survives the
 * body reset, re-attaches to the next test's composer, and pollutes its dispatches (the m3
 * scanner-suite lesson from library/environment.md). */
const harnesses: Harness[] = [];

function startHarness(overrides: { settings?: Partial<Settings>; keyPresent?: boolean } = {}): Harness {
  document.body.innerHTML = HOME_HTML;
  const settings: Settings = { ...DEFAULT_SETTINGS, ...overrides.settings };
  let keyPresent = overrides.keyPresent ?? true;
  const optimizeRequests: DraftSnapshot[] = [];
  const copied: string[] = [];

  const overlay = createScoreOverlay({
    getKeyPresence: () => keyPresent,
    requestAnalysis: () => watcher.requestAnalysis(),
    openOptions: () => {},
    requestOptimize: (draft) => {
      optimizeRequests.push(draft);
    },
    copyVariant: (text) => {
      copied.push(text);
      return Promise.resolve();
    },
  });
  const watcher = createComposerWatcher({
    getMinDraftLength: () => settings.minDraftLength,
    getAutoAnalyze: () => settings.autoAnalyze,
    dispatchAnalysis: (dispatch) => overlay.onAnalysisDispatched(dispatch.snapshot),
  });
  watcher.onDraft((event) => overlay.onDraftCaptured(event));
  watcher.onComposerChange((event) => overlay.onComposerChange(event));

  overlay.onSettings(settings, 1);
  watcher.start();

  const harness: Harness = {
    overlay,
    watcher,
    optimizeRequests,
    copied,
    setKeyPresent(present: boolean) {
      keyPresent = present;
    },
    pushSettings(partial: Partial<Settings>) {
      Object.assign(settings, partial);
      overlay.onSettings({ ...settings }, 2);
      if (!settings.enabled) watcher.stop();
    },
    optimizeReply(result, draft) {
      overlay.onOptimizeResult(result, draft ?? optimizeRequests.at(-1)!);
    },
    optimizeFail(draft) {
      overlay.onOptimizeFailed(draft ?? optimizeRequests.at(-1)!);
    },
    panel(): HTMLElement {
      const shadow = document.querySelector<HTMLElement>(HOST_SELECTOR)?.shadowRoot;
      if (shadow === null || shadow === undefined) throw new Error('the overlay host is not mounted');
      if (shadow.querySelector(`[data-testid="amplifyx-overlay"]`) === null) {
        // M5: the panel only exists after an explicit pill click.
        const pill = shadow.querySelector<HTMLElement>(`[data-testid="${OVERLAY_PILL_TESTID}"]`);
        if (pill === null) throw new Error('the score pill is not rendered');
        pill.dispatchEvent(new Event('click', { bubbles: true, composed: true }));
      }
      const panel = shadow.querySelector<HTMLElement>('[data-testid="amplifyx-overlay"]');
      if (panel === null) throw new Error('the pill click did not expand the detail panel');
      return panel;
    },
  };
  harnesses.push(harness);
  return harness;
}

const find = (root: ParentNode, testid: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-testid="${testid}"]`);

/**
 * A bubbling, composed click. happy-dom normalizes a `MouseEvent` click init to `composed:false`
 * (a click never crosses a shadow boundary that way), which would hide the click's real path from
 * the overlay's "is this click mine?" check — so the composed flag is set through the base `Event`
 * constructor, which keeps it.
 */
const click = (element: HTMLElement): void => {
  element.dispatchEvent(new Event('click', { bubbles: true, composed: true }));
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const harness of harnesses) {
    harness.watcher.stop();
    harness.overlay.destroy();
  }
  harnesses.length = 0;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

async function analyzeHarness(overrides?: Parameters<typeof startHarness>[0]): Promise<Harness> {
  const harness = startHarness(overrides);
  await vi.advanceTimersByTimeAsync(0);
  typeText(composer(), DRAFT_TEXT);
  await settleCapture();
  return harness;
}

describe('Optimize availability (VAL-OPT-001)', () => {
  it('shows an enabled Optimize action for a qualifying draft with a key', async () => {
    const harness = await analyzeHarness();
    const section = find(harness.panel(), 'overlay-optimizer')!;
    const optimize = find(section, 'overlay-optimize')!;
    expect(optimize.dataset.state).toBe('enabled');
    expect(optimize.textContent).toBe('Optimize');
  });

  it('disables Optimize without a key and points the guidance to Options', async () => {
    const harness = await analyzeHarness({ keyPresent: false });
    const section = find(harness.panel(), 'overlay-optimizer')!;
    expect(find(section, 'overlay-optimize')!.dataset.state).toBe('disabled');
    const notice = find(section, 'overlay-optimizer-notice')!;
    expect(notice.textContent).toMatch(/Options/);
    expect(find(section, 'overlay-optimizer-connect')).not.toBeNull();
  });

  it('disables Optimize with a reason while the AI lane is off in Settings', async () => {
    const harness = await analyzeHarness({ settings: { jevForDrafts: false } });
    const section = find(harness.panel(), 'overlay-optimizer')!;
    expect(find(section, 'overlay-optimize')!.dataset.state).toBe('disabled');
    expect(find(section, 'overlay-optimizer-notice')!.textContent).toMatch(/off in Settings/);
  });

  it('renders no overlay UI at all for an empty (below-minimum) draft', async () => {
    startHarness();
    await vi.advanceTimersByTimeAsync(0);
    // M5: no qualifying draft means no host, no pill and no panel — so there is no Optimize
    // affordance anywhere near the composer (the old panel rendered an empty state instead).
    expect(document.querySelector(HOST_SELECTOR)).toBeNull();
    expect(find(document, 'overlay-optimizer')).toBeNull();
    expect(find(document, OVERLAY_PILL_TESTID)).toBeNull();
  });
});

describe('Optimize lifecycle (VAL-OPT-002, VAL-OPT-003)', () => {
  it('click -> loading with one dispatch; reply renders ranked variants with kind labels', async () => {
    const harness = await analyzeHarness();
    const section = () => find(harness.panel(), 'overlay-optimizer')!;

    click(find(section(), 'overlay-optimize')!);
    expect(section().dataset.optimizerState).toBe('loading');
    expect(find(section(), 'overlay-optimizer-pending')).not.toBeNull();
    expect(harness.optimizeRequests).toHaveLength(1);
    expect(harness.optimizeRequests[0]!.text).toBe(DRAFT_TEXT);

    harness.optimizeReply(optimized(harness.optimizeRequests[0]!));
    expect(section().dataset.optimizerState).toBe('done');
    const items = section().querySelectorAll<HTMLElement>('[data-testid="overlay-optimizer-variant"]');
    expect(items).toHaveLength(2);
    expect(items[0]!.dataset.variantKind).toBe('question');
    expect(find(section(), 'overlay-optimizer-variant-text')!.textContent).toBe(VARIANT_QUESTION);
    expect(find(section(), 'overlay-optimizer-hashtags')).not.toBeNull();
  });

  it('renders hashtag suggestions with rationales and drop advice when present', async () => {
    const harness = await analyzeHarness();
    click(find(harness.panel(), 'overlay-optimize')!);
    harness.optimizeReply(optimized(harness.optimizeRequests[0]!, DEFAULT_VARIANTS, 'You use 5 hashtags. Drop #Grind, #Hustle.'));

    const box = find(harness.panel(), 'overlay-optimizer-hashtags')!;
    const suggestions = box.querySelectorAll<HTMLElement>('[data-testid="overlay-optimizer-hashtag"]');
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]!.textContent).toContain('#System');
    expect(suggestions[0]!.textContent).toContain('Comes straight from your draft');
    expect(find(box, 'overlay-optimizer-drop-advice')!.textContent).toMatch(/Drop #Grind/);
  });
});

describe('Copy action (VAL-OPT-004, VAL-OPT-005)', () => {
  it('puts exactly the variant text on the clipboard and never changes the composer', async () => {
    const harness = await analyzeHarness();
    click(find(harness.panel(), 'overlay-optimize')!);
    harness.optimizeReply(optimized(harness.optimizeRequests[0]!));

    const copy = find(harness.panel(), 'overlay-optimizer-copy')!;
    click(copy);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.copied).toEqual([VARIANT_QUESTION]); // EXACT text, no labels or extra text
    expect(composer().textContent).toBe(DRAFT_TEXT); // composer untouched
    expect(copy.textContent).toBe('Copied');
  });
});

describe('Over-limit flag (VAL-OPT-007)', () => {
  it('flags an over-limit variant and leaves within-limit variants unflagged', async () => {
    const harness = await analyzeHarness();
    click(find(harness.panel(), 'overlay-optimize')!);
    harness.optimizeReply(
      optimized(harness.optimizeRequests[0]!, [
        variant('question', VARIANT_QUESTION, 0.9, 300, true),
        variant('story', VARIANT_STORY, 0.7, 120, false),
      ]),
    );

    const items = harness.panel().querySelectorAll<HTMLElement>('[data-testid="overlay-optimizer-variant"]');
    expect(items[0]!.dataset.overLimit).toBe('true');
    expect(find(items[0]!, 'overlay-optimizer-variant-chars')!.textContent).toMatch(/280-character limit/);
    expect(items[1]!.dataset.overLimit).toBe('false');
    expect(find(items[1]!, 'overlay-optimizer-variant-chars')!.textContent).toMatch(/120 characters/);
  });
});

describe('Failure and identity (VAL-OPT-009, VAL-OPT-010)', () => {
  it('shows an explicit non-blocking error: local score and composer intact, retry available', async () => {
    const harness = await analyzeHarness();
    click(find(harness.panel(), 'overlay-optimize')!);
    harness.optimizeFail();

    const section = find(harness.panel(), 'overlay-optimizer')!;
    expect(section.dataset.optimizerState).toBe('error');
    expect(find(section, 'overlay-optimizer-notice')!.textContent).toMatch(/failed/i);
    expect(find(section, 'overlay-optimize')!.dataset.state).toBe('enabled');
    // Non-blocking: the local analysis half is still fully rendered.
    expect(find(harness.panel(), 'overlay-headline')).not.toBeNull();
    expect(find(harness.panel(), 'overlay-signals')).not.toBeNull();
    expect(composer().textContent).toBe(DRAFT_TEXT);
  });

  it('discards a reply for a different draft (the user kept typing)', async () => {
    const harness = await analyzeHarness();
    click(find(harness.panel(), 'overlay-optimize')!);
    const dispatchA = harness.optimizeRequests[0]!;

    typeText(composer(), 'A different draft that also clears the minimum length bar.');
    await settleCapture();
    harness.optimizeReply(optimized(dispatchA), dispatchA);

    const section = find(harness.panel(), 'overlay-optimizer')!;
    expect(section.dataset.optimizerState).toBe('idle'); // B never sees A's result
  });

  it('resets the section on a draft change so a re-click is a fresh (cache-served) dispatch', async () => {
    const harness = await analyzeHarness();
    click(find(harness.panel(), 'overlay-optimize')!);
    harness.optimizeReply(optimized(harness.optimizeRequests[0]!));
    expect(find(harness.panel(), 'overlay-optimizer')!.dataset.optimizerState).toBe('done');

    typeText(composer(), 'Another draft, also long enough to analyze properly here.');
    await settleCapture();
    expect(find(harness.panel(), 'overlay-optimizer')!.dataset.optimizerState).toBe('idle');

    // Re-click dispatches again — the API-level dedup (max one call per unique draft) lives in
    // the background's optimizer cache; identical text re-served without a network call.
    click(find(harness.panel(), 'overlay-optimize')!);
    expect(harness.optimizeRequests).toHaveLength(2);
  });

  it('does not dispatch while the AI lane is off even if the button state is forced', async () => {
    const harness = await analyzeHarness({ settings: { jevForDrafts: false } });
    click(find(harness.panel(), 'overlay-optimize')!);
    expect(harness.optimizeRequests).toHaveLength(0);
  });
});

describe('English-only optimizer surface (VAL-CROSS-016)', () => {
  it('renders only English text across idle, no-key, loading, done, and error states', async () => {
    const english = /^[A-Za-z0-9 .,:;!?%'"()\-–—/+·…#]*$/;
    const visibleText = (root: ParentNode): string =>
      [...root.querySelectorAll('*')].map((node) => node.textContent ?? '').join(' ');

    const noKey = await analyzeHarness({ keyPresent: false });
    expect(visibleText(find(noKey.panel(), 'overlay-optimizer')!)).toMatch(english);
    // One live harness at a time: the first harness's watcher must be stopped BEFORE the second
    // harness replaces the body, or its observer re-attaches and its host wins the id race.
    noKey.watcher.stop();
    noKey.overlay.destroy();

    const harness = await analyzeHarness();
    expect(visibleText(find(harness.panel(), 'overlay-optimizer')!)).toMatch(english); // idle
    click(find(harness.panel(), 'overlay-optimize')!);
    expect(visibleText(find(harness.panel(), 'overlay-optimizer')!)).toMatch(english); // loading
    harness.optimizeReply(optimized(harness.optimizeRequests[0]!));
    expect(visibleText(find(harness.panel(), 'overlay-optimizer')!)).toMatch(english); // done

    typeText(composer(), 'A second draft long enough for the error state sweep here.');
    await settleCapture();
    click(find(harness.panel(), 'overlay-optimize')!);
    harness.optimizeFail();
    expect(visibleText(find(harness.panel(), 'overlay-optimizer')!)).toMatch(english); // error
  });
});
