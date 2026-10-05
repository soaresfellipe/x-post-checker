import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAFT_DEBOUNCE_MS, type DraftSnapshot } from '../../src/core/draft-snapshot';
import { draftCacheKey } from '../../src/core/jev-client/hash';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/settings-store';
import type { HookVariant, Optimization, OptimizationResult } from '../../src/core/optimizer';
import { OVERLAY_HOST_ID, OVERLAY_ROW_TESTID, OVERLAY_TESTID, createScoreOverlay, type ScoreOverlay } from '../../src/dom/overlay';
import { OPTIMIZER_COPY_RESET_MS } from '../../src/dom/overlay/config';
import { createComposerWatcher } from '../../src/dom/composer-watcher';

/**
 * The optimizer section of the expanded inline block (m4-optimizer, restyled by M6 Design 1b),
 * DOM-tier: availability gates (VAL-OPT-001 — the section is HIDDEN entirely without AI), the
 * loading -> success/error lifecycle (VAL-OPT-002/010), exact-text clipboard copy (VAL-OPT-004)
 * that never touches the composer (VAL-OPT-005), the over-limit flag (VAL-OPT-007), per-draft
 * identity (stale replies never paint), and the reset on draft change (VAL-OPT-009).
 *
 * Migrated to the M6 model: the section lives INSIDE the expanded block, so every flow begins
 * with a row click, and typing a new draft collapses the block (which each test re-expands).
 */

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
      <button type="button" data-testid="tweetButtonInline" aria-disabled="true">Postar</button>
    </div>
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
  /** The expanded block, clicking the row first when collapsed (the only way to get it). */
  expanded(): HTMLElement;
}

/** Live harnesses, stopped + destroyed after EVERY test: a leaked MutationObserver survives the
 * body reset, re-attaches to the next test's composer, and pollutes its dispatches (the m3
 * scanner-suite lesson from library/environment.md). */
const harnesses: Harness[] = [];

async function startHarness(
  overrides: { settings?: Partial<Settings>; keyPresent?: boolean } = {},
): Promise<Harness> {
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
  // Drain the watcher's first scan so the composer is attached before any test types.
  await vi.advanceTimersByTimeAsync(0);

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
    expanded(): HTMLElement {
      const shadow = document.querySelector<HTMLElement>(HOST_SELECTOR)?.shadowRoot;
      if (shadow === null || shadow === undefined) throw new Error('the overlay host is not mounted');
      if (shadow.querySelector(`[data-testid="${OVERLAY_TESTID}"]`) === null) {
        // M6: the expanded block only exists after an explicit row click.
        const row = shadow.querySelector<HTMLElement>(`[data-testid="${OVERLAY_ROW_TESTID}"]`);
        if (row === null) throw new Error('the status row is not rendered');
        row.dispatchEvent(new Event('click', { bubbles: true, composed: true }));
      }
      const block = shadow.querySelector<HTMLElement>(`[data-testid="${OVERLAY_TESTID}"]`);
      if (block === null) throw new Error('the row click did not expand the inline analysis');
      return block;
    },
  };
  harnesses.push(harness);
  return harness;
}

const find = (root: ParentNode, testid: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-testid="${testid}"]`);

/** The LIVE status row (re-queried after every re-render). */
const rowOf = (): HTMLElement => {
  const row = document
    .querySelector<HTMLElement>(HOST_SELECTOR)
    ?.shadowRoot?.querySelector<HTMLElement>(`[data-testid="${OVERLAY_ROW_TESTID}"]`);
  if (row === null || row === undefined) throw new Error('the status row is not rendered');
  return row;
};

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
  const harness = await startHarness(overrides);
  typeText(composer(), DRAFT_TEXT);
  await settleCapture();
  return harness;
}

describe('Optimizer availability (VAL-OPT-001, M6 decision D3)', () => {
  it('shows the enabled "Find stronger hooks" outline action for a qualifying draft with a key', async () => {
    const harness = await analyzeHarness();
    const section = find(harness.expanded(), 'overlay-optimizer')!;
    const optimize = find(section, 'overlay-optimize')!;
    expect(optimize.textContent).toBe('Find stronger hooks');
    expect(optimize.tagName).toBe('BUTTON');
  });

  it('hides the optimizer section ENTIRELY without a Jev key (user decision D3)', async () => {
    const harness = await analyzeHarness({ keyPresent: false });
    // No section, no disabled button, no guidance notice — but the AI block still carries the
    // Connect Jev prompt and the row keeps the local score.
    expect(find(harness.expanded(), 'overlay-optimizer')).toBeNull();
    expect(find(harness.expanded(), 'overlay-connect-jev')).not.toBeNull();
    expect(find(harness.expanded(), 'overlay-signals')).not.toBeNull();
    expect(find(rowOf(), 'overlay-headline')).not.toBeNull();
  });

  it('hides the optimizer section while the AI lane is off in Settings', async () => {
    const harness = await analyzeHarness({ settings: { jevForDrafts: false } });
    expect(find(harness.expanded(), 'overlay-optimizer')).toBeNull();
    expect(find(harness.expanded(), 'overlay-jev')).not.toBeNull(); // the AI block says why
  });

  it('renders no overlay UI at all for an empty (below-minimum) draft', async () => {
    await startHarness();
    expect(document.querySelector(HOST_SELECTOR)).toBeNull();
    expect(find(document, 'overlay-optimizer')).toBeNull();
    expect(find(document, OVERLAY_ROW_TESTID)).toBeNull();
  });
});

describe('Optimizer lifecycle (VAL-OPT-002, VAL-OPT-003)', () => {
  it('click -> loading with one dispatch; reply renders ranked variants with kind labels', async () => {
    const harness = await analyzeHarness();
    const section = () => find(harness.expanded(), 'overlay-optimizer')!;

    click(find(section(), 'overlay-optimize')!);
    expect(section().dataset.optimizerState).toBe('loading');
    expect(find(section(), 'overlay-optimizer-pending')!.textContent).toContain('Finding stronger hooks…');
    expect(harness.optimizeRequests).toHaveLength(1);
    expect(harness.optimizeRequests[0]!.text).toBe(DRAFT_TEXT);

    harness.optimizeReply(optimized(harness.optimizeRequests[0]!));
    expect(section().dataset.optimizerState).toBe('done');
    expect(section().textContent).toContain('Stronger hooks');
    expect(section().textContent).toContain('copy only · composer untouched');
    const items = section().querySelectorAll<HTMLElement>('[data-testid="overlay-optimizer-variant"]');
    expect(items).toHaveLength(2);
    expect(items[0]!.dataset.variantKind).toBe('question');
    expect(find(section(), 'overlay-optimizer-variant-text')!.textContent).toBe(VARIANT_QUESTION);
    expect(find(section(), 'overlay-optimizer-hashtags')).not.toBeNull();
  });

  it('renders hashtag suggestions as accent links with rationale titles, plus drop advice', async () => {
    const harness = await analyzeHarness();
    click(find(harness.expanded(), 'overlay-optimize')!);
    harness.optimizeReply(optimized(harness.optimizeRequests[0]!, DEFAULT_VARIANTS, 'You use 5 hashtags. Drop #Grind, #Hustle.'));

    const box = find(harness.expanded(), 'overlay-optimizer-hashtags')!;
    const suggestions = box.querySelectorAll<HTMLElement>('[data-testid="overlay-optimizer-hashtag"]');
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]!.textContent).toBe('#System');
    expect(suggestions[0]!.getAttribute('title')).toContain('Comes straight from your draft');
    expect(find(box, 'overlay-optimizer-drop-advice')!.textContent).toMatch(/Drop #Grind/);
  });
});

describe('Copy action (VAL-OPT-004, VAL-OPT-005)', () => {
  it('puts exactly the variant text on the clipboard and never changes the composer', async () => {
    const harness = await analyzeHarness();
    click(find(harness.expanded(), 'overlay-optimize')!);
    harness.optimizeReply(optimized(harness.optimizeRequests[0]!));

    const copy = find(harness.expanded(), 'overlay-optimizer-copy')!;
    click(copy);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.copied).toEqual([VARIANT_QUESTION]); // EXACT text, no labels or extra text
    expect(composer().textContent).toBe(DRAFT_TEXT); // composer untouched
    expect(copy.textContent).toBe('Copied');
  });

  it('reverts the Copied label to Copy exactly 1500ms later and re-enables the button (VAL-OPT-004)', async () => {
    const harness = await analyzeHarness();
    click(find(harness.expanded(), 'overlay-optimize')!);
    harness.optimizeReply(optimized(harness.optimizeRequests[0]!));

    const copy = find(harness.expanded(), 'overlay-optimizer-copy')! as HTMLButtonElement;
    click(copy);
    await vi.advanceTimersByTimeAsync(0);
    expect(copy.textContent).toBe('Copied');
    expect(copy.disabled).toBe(true);

    // One millisecond BEFORE the reset boundary: still the copied state.
    await vi.advanceTimersByTimeAsync(OPTIMIZER_COPY_RESET_MS - 1);
    expect(copy.textContent).toBe('Copied');

    // AT the boundary (exactly 1500ms after the copy): label reverted, button usable again.
    await vi.advanceTimersByTimeAsync(1);
    expect(copy.textContent).toBe('Copy');
    expect(copy.disabled).toBe(false);
  });
});

describe('Over-limit flag (VAL-OPT-007)', () => {
  it('flags an over-limit variant and leaves within-limit variants unflagged', async () => {
    const harness = await analyzeHarness();
    click(find(harness.expanded(), 'overlay-optimize')!);
    harness.optimizeReply(
      optimized(harness.optimizeRequests[0]!, [
        variant('question', VARIANT_QUESTION, 0.9, 300, true),
        variant('story', VARIANT_STORY, 0.7, 120, false),
      ]),
    );

    const items = harness.expanded().querySelectorAll<HTMLElement>('[data-testid="overlay-optimizer-variant"]');
    expect(items[0]!.dataset.overLimit).toBe('true');
    expect(find(items[0]!, 'overlay-optimizer-variant-chars')!.textContent).toBe('300 · over limit');
    expect(items[1]!.dataset.overLimit).toBe('false');
    expect(find(items[1]!, 'overlay-optimizer-variant-chars')!.textContent).toBe('120 chars');
  });
});

describe('Failure and identity (VAL-OPT-009, VAL-OPT-010)', () => {
  it('shows an explicit non-blocking error with Retry: local score and composer intact', async () => {
    const harness = await analyzeHarness();
    click(find(harness.expanded(), 'overlay-optimize')!);
    harness.optimizeFail();

    const section = find(harness.expanded(), 'overlay-optimizer')!;
    expect(section.dataset.optimizerState).toBe('error');
    expect(find(section, 'overlay-optimizer-notice')!.textContent).toContain(
      'Optimization failed — your draft and local score are untouched.',
    );
    // Non-blocking: the local analysis half is still fully rendered.
    expect(find(harness.expanded(), 'overlay-signals')).not.toBeNull();
    expect(find(rowOf(), 'overlay-headline')).not.toBeNull();
    expect(composer().textContent).toBe(DRAFT_TEXT);
  });

  it('discards a reply for a different draft (the user kept typing)', async () => {
    const harness = await analyzeHarness();
    click(find(harness.expanded(), 'overlay-optimize')!);
    const dispatchA = harness.optimizeRequests[0]!;

    typeText(composer(), 'A different draft that also clears the minimum length bar.');
    await settleCapture();
    harness.optimizeReply(optimized(dispatchA), dispatchA);

    const section = find(harness.expanded(), 'overlay-optimizer')!;
    expect(section.dataset.optimizerState).toBe('idle'); // B never sees A's result
  });

  it('resets the section on a draft change so a re-click is a fresh (cache-served) dispatch', async () => {
    const harness = await analyzeHarness();
    click(find(harness.expanded(), 'overlay-optimize')!);
    harness.optimizeReply(optimized(harness.optimizeRequests[0]!));
    expect(find(harness.expanded(), 'overlay-optimizer')!.dataset.optimizerState).toBe('done');

    typeText(composer(), 'Another draft, also long enough to analyze properly here.');
    await settleCapture();
    expect(find(harness.expanded(), 'overlay-optimizer')!.dataset.optimizerState).toBe('idle');

    // Re-click dispatches again — the API-level dedup (max one call per unique draft) lives in
    // the background's optimizer cache; identical text re-served without a network call.
    click(find(harness.expanded(), 'overlay-optimize')!);
    expect(harness.optimizeRequests).toHaveLength(2);
  });

  it('does not dispatch while the AI lane is off (the section, and with it the button, is hidden)', async () => {
    const harness = await analyzeHarness({ settings: { jevForDrafts: false } });
    expect(find(harness.expanded(), 'overlay-optimize')).toBeNull();
    expect(harness.optimizeRequests).toHaveLength(0);
  });
});

describe('English-only optimizer surface (VAL-CROSS-016)', () => {
  it('renders only English text across idle, loading, done, and error states', async () => {
    const english = /^[A-Za-z0-9 .,:;!?%'"()\-–—/+·…#]*$/;
    const visibleText = (root: ParentNode): string =>
      [...root.querySelectorAll('*')].map((node) => node.textContent ?? '').join(' ');

    const harness = await analyzeHarness();
    expect(visibleText(find(harness.expanded(), 'overlay-optimizer')!)).toMatch(english); // idle
    click(find(harness.expanded(), 'overlay-optimize')!);
    expect(visibleText(find(harness.expanded(), 'overlay-optimizer')!)).toMatch(english); // loading
    harness.optimizeReply(optimized(harness.optimizeRequests[0]!));
    expect(visibleText(find(harness.expanded(), 'overlay-optimizer')!)).toMatch(english); // done

    typeText(composer(), 'A second draft long enough for the error state sweep here.');
    await settleCapture();
    click(find(harness.expanded(), 'overlay-optimize')!);
    harness.optimizeFail();
    expect(visibleText(find(harness.expanded(), 'overlay-optimizer')!)).toMatch(english); // error
  });
});
