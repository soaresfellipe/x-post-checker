import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAFT_DEBOUNCE_MS } from '../../src/core/draft-snapshot';
import {
  createComposerWatcher,
  type AnalysisDispatch,
  type ComposerChangeEvent,
  type DraftEvent,
} from '../../src/dom/composer-watcher';

const HOME_HTML = `
<div data-testid="primaryColumn">
  <div data-testid="toolBar">
    <div data-testid="tweetTextarea_0RichTextInputContainer">
      <div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" class="public-DraftEditor-content"></div>
    </div>
  </div>
</div>`;

const REPLY_VIEW_HTML = `
<div data-testid="primaryColumn">
  <div data-testid="replyComposerContainer">
    <div data-testid="app-bar-close" role="button">Voltar</div>
    <div data-testid="tweetTextarea_1RichTextInputContainer">
      <div dir="ltr"><span>Respondendo a </span><a href="/ana_builds" role="link">@ana_builds</a></div>
      <div data-testid="tweetTextarea_1" role="textbox" contenteditable="true" class="public-DraftEditor-content"></div>
    </div>
  </div>
</div>`;

/** Composer-less route (Explore): an unrelated DraftEditor editor with no composer container. */
const EXPLORE_VIEW_HTML = `
<div data-testid="primaryColumn">
  <div data-testid="exploreView">
    <div class="DraftEditor-root">
      <div class="public-DraftEditor-content" role="textbox" contenteditable="true" id="searchbox"></div>
    </div>
  </div>
</div>`;

/**
 * The VERIFIED real status-page view (library/x-dom.md, 2026-10-03): the inline "Post your reply"
 * composer under the primary post is tweetTextarea_0 and its region holds NO reply chip. Reply
 * context must flip with the ROUTE, not with the composer markup.
 */
const STATUS_PAGE_VIEW_HTML = `
<div data-testid="primaryColumn">
  <div data-testid="statusView">
    <article data-testid="tweet">
      <div data-testid="User-Name"><a href="/ana_builds" role="link"><span>@ana_builds</span></a></div>
      <div data-testid="tweetText"><span>Primary post above the inline composer</span></div>
    </article>
    <div>
      <div data-testid="tweetTextarea_0RichTextInputContainer">
        <div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" class="public-DraftEditor-content"></div>
      </div>
    </div>
    <button type="button" data-testid="tweetButtonInline" aria-disabled="true">Responder</button>
  </div>
</div>`;

interface Harness {
  dispatches: AnalysisDispatch[];
  draftEvents: DraftEvent[];
  composerEvents: ComposerChangeEvent[];
  /** Immediate user-edit notifications (input / compositionend / paste), pre-debounce. */
  userEdits: number;
}

function typeText(composer: Element, text: string): void {
  composer.replaceChildren();
  const line = document.createElement('div');
  line.textContent = text;
  composer.append(line);
  composer.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Mutates the composer DOM WITHOUT dispatching any event — the real-site edit path the m4
 * clear-reset defect ran on: Draft.js performs selection deletion (Ctrl+A + Backspace) through
 * its own programmatic DOM writes, and neither `beforeinput` nor `input` fires (verified live,
 * read-only, 2026-10-03: the clear produced childList mutations with the text dropping to empty
 * and ZERO input events).
 */
function setDomText(composer: Element, text: string): void {
  composer.replaceChildren();
  const line = document.createElement('div');
  line.textContent = text;
  composer.append(line);
}

/** The verified real-site post-clear composer shape: one empty Draft.js block (`br[data-text]`). */
function draftJsClearShape(composer: Element): void {
  composer.replaceChildren();
  const contents = document.createElement('div');
  contents.setAttribute('data-contents', 'true');
  const block = document.createElement('div');
  block.setAttribute('data-block', 'true');
  const line = document.createElement('div');
  const span = document.createElement('span');
  span.setAttribute('data-text', 'true');
  span.append(document.createElement('br'));
  line.append(span);
  block.append(line);
  contents.append(block);
  composer.append(contents);
}

function fire(composer: Element, type: string): void {
  composer.dispatchEvent(new Event(type, { bubbles: true }));
}

/** The active textbox (never the *RichTextInputContainer wrapper, whose testid shares the prefix). */
function composer(): Element {
  return (document.querySelector('[data-testid="tweetTextarea_1"]') ??
    document.querySelector('[data-testid="tweetTextarea_0"]'))!;
}

/**
 * Every watcher `start()` hands back, so afterEach can stop them. A watcher left running keeps
 * its composer's event listeners alive across tests (the document body is reused), which would
 * let one test's user edits be counted by the NEXT test's counters.
 */
const liveWatchers = new Set<ReturnType<typeof createComposerWatcher>>();

function start(overrides: Partial<Parameters<typeof createComposerWatcher>[0]> = {}) {
  const harness: Harness = { dispatches: [], draftEvents: [], composerEvents: [], userEdits: 0 };
  const watcher = createComposerWatcher({
    getMinDraftLength: () => 10,
    getAutoAnalyze: () => true,
    dispatchAnalysis: (dispatch) => harness.dispatches.push(dispatch),
    ...overrides,
  });
  watcher.onDraft((event) => harness.draftEvents.push(event));
  watcher.onComposerChange((event) => harness.composerEvents.push(event));
  watcher.onUserEdit(() => {
    harness.userEdits += 1;
  });
  watcher.start();
  liveWatchers.add(watcher);
  return { watcher, harness };
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = HOME_HTML;
});

afterEach(() => {
  // Every watcher registered by `start()` must stop: `stop()` detaches the composer's listeners,
  // and a leaked one keeps its user-edit listener attached to this document's shared body.
  for (const watcher of liveWatchers) watcher.stop();
  liveWatchers.clear();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('composer detection', () => {
  it('attaches to the home composer on start, exactly once, and stays put across rescans', async () => {
    const { watcher, harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.composerEvents).toEqual([{ type: 'attached', composer: composer() }]);
    expect(watcher.getActiveComposer()).toBe(composer());

    document.body.append(document.createElement('div'));
    await vi.advanceTimersByTimeAsync(0);
    document.body.append(document.createElement('div'));
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.composerEvents).toHaveLength(1);
  });

  it('attaches nothing and reports nothing when no known selector matches', async () => {
    document.body.innerHTML = '<div data-testid="primaryColumn"><p>no composer</p></div>';
    const { watcher, harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.composerEvents).toEqual([]);
    expect(watcher.getActiveComposer()).toBeNull();

    document.body.innerHTML = HOME_HTML;
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.getActiveComposer()).toBe(composer());
  });

  it('switches to the reply composer when it appears over the home composer', async () => {
    document.body.innerHTML = HOME_HTML + REPLY_VIEW_HTML;
    const { watcher, harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.getActiveComposer()).toBe(document.querySelector('[data-testid="tweetTextarea_1"]'));
    expect(watcher.getActiveComposer()).not.toBe(document.querySelector('[data-testid="tweetTextarea_0"]'));
    expect(harness.composerEvents).toEqual([
      { type: 'attached', composer: document.querySelector('[data-testid="tweetTextarea_1"]') },
    ]);
  });

  it('tears down a dead composer after SPA removal and re-attaches the new view idempotently', async () => {
    const { watcher, harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    const home = composer();

    document.body.innerHTML = '<div data-testid="primaryColumn"></div>';
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.composerEvents).toEqual([
      { type: 'attached', composer: home },
      { type: 'detached', composer: home },
    ]);
    expect(watcher.getActiveComposer()).toBeNull();

    document.body.innerHTML = REPLY_VIEW_HTML;
    await vi.advanceTimersByTimeAsync(0);
    const reply = document.querySelector('[data-testid="tweetTextarea_1"]')!;
    expect(harness.composerEvents).toEqual([
      { type: 'attached', composer: home },
      { type: 'detached', composer: home },
      { type: 'attached', composer: reply },
    ]);

    // Repeated scans over the settled view stay silent (idempotent remount).
    document.body.append(document.createElement('div'));
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.composerEvents).toHaveLength(3);
    expect(watcher.getActiveComposer()).toBe(reply);
  });

  it('rescans on popstate/hashchange route signals', async () => {
    document.body.innerHTML = '<div data-testid="primaryColumn"></div>';
    const { harness } = start();
    await vi.advanceTimersByTimeAsync(0);

    window.dispatchEvent(new Event('popstate'));
    document.body.innerHTML = HOME_HTML;
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.composerEvents).toEqual([{ type: 'attached', composer: composer() }]);
  });

  it('flips reply context BOTH ways across SPA navigation (status route = reply, home = standalone)', async () => {
    // M2 scrutiny round 3: the real status page's inline "Post your reply" composer is
    // tweetTextarea_0 with NO chip — only the route (/<handle>/status/<id>) makes it a reply.
    const { harness } = start();
    await vi.advanceTimersByTimeAsync(0);

    typeText(composer(), 'Draft typed on the home timeline');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(harness.dispatches[0]!.snapshot.isReply).toBe(false);
    expect('replyToHandle' in harness.dispatches[0]!.snapshot).toBe(false);

    // SPA navigation home -> status: the inline composer (tweetTextarea_0, no chip) replaces the
    // home composer, and the route carries the reply context.
    history.pushState({}, '', '/ana_builds/status/1800000000000000001');
    document.body.innerHTML = STATUS_PAGE_VIEW_HTML;
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'Draft typed under a status page');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(harness.dispatches[1]!.snapshot.isReply).toBe(true);
    expect(harness.dispatches[1]!.snapshot.replyToHandle).toBe('ana_builds');
    expect('replyToFollowedByViewer' in harness.dispatches[1]!.snapshot).toBe(false);

    // And status -> home flips it back: no stale reply classification survives the route change.
    history.pushState({}, '', '/home');
    document.body.innerHTML = HOME_HTML;
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'Draft typed back on the home timeline');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(harness.dispatches[2]!.snapshot.isReply).toBe(false);
    expect('replyToHandle' in harness.dispatches[2]!.snapshot).toBe(false);
  });

  it('attaches nothing on a composer-less route that contains an unrelated DraftEditor editor', async () => {
    // The structural fallback must not match outside a composer container: no attach, no events,
    // and typing into the unrelated editor produces nothing (VAL-DRAFT-029).
    document.body.innerHTML = EXPLORE_VIEW_HTML;
    const { watcher, harness } = start();
    await vi.advanceTimersByTimeAsync(0);

    expect(watcher.getActiveComposer()).toBeNull();
    expect(harness.composerEvents).toEqual([]);

    typeText(document.getElementById('searchbox')!, 'unrelated editor text that would qualify');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS * 2);
    expect(harness.draftEvents).toEqual([]);
    expect(harness.dispatches).toEqual([]);
    expect(watcher.getActiveComposer()).toBeNull();
  });
});

describe('debounced typing analysis', () => {
  it('analyzes once ~700ms after the last keystroke, coalescing bursts', async () => {
    const { harness } = start();
    await vi.advanceTimersByTimeAsync(0);

    typeText(composer(), 'Hello vi');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS - 1);
    expect(harness.dispatches).toEqual([]);
    typeText(composer(), 'Hello viral world');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS - 1);
    expect(harness.dispatches).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(harness.dispatches).toHaveLength(1);
    expect(harness.dispatches[0]!.trigger).toBe('auto');
    expect(harness.dispatches[0]!.snapshot.text).toBe('Hello viral world');
    expect(harness.dispatches[0]!.snapshot.charCount).toBe(17);
  });

  it('emits a capture event even when the draft is not dispatched', async () => {
    const { harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'short');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(harness.draftEvents).toHaveLength(1);
    expect(harness.draftEvents[0]!.snapshot.charCount).toBe(5);
    expect(harness.draftEvents[0]!.eligible).toBe(false);
  });

  it('reports a cleared draft (empty text) as an ineligible capture', async () => {
    const { watcher, harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'enough chars');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(watcher.getSnapshot()?.charCount).toBe(12);

    typeText(composer(), '');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(harness.draftEvents).toHaveLength(2);
    expect(harness.draftEvents[1]!.snapshot.text).toBe('');
    expect(harness.draftEvents[1]!.eligible).toBe(false);
    expect(harness.dispatches).toHaveLength(1); // only the earlier eligible draft
  });
});

describe('IME composition (VAL-DRAFT-012)', () => {
  it('never analyzes during composition and analyzes the final text exactly once after it', async () => {
    const { harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    const box = composer();

    typeText(box, 'prep');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS - 100); // pending pre-composition capture

    fire(box, 'compositionstart'); // composition begins: pending capture must be canceled
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS * 3);
    expect(harness.dispatches).toEqual([]);
    expect(harness.draftEvents).toEqual([]);

    fire(box, 'compositionupdate');
    typeText(box, 'prep Hello vir'); // intermediate composition text must not schedule anything
    fire(box, 'compositionupdate');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS * 3);
    expect(harness.dispatches).toEqual([]);
    expect(harness.draftEvents).toEqual([]);

    fire(box, 'compositionend');
    // Browsers deliver a final input right after compositionend: it must coalesce into the same
    // debounced capture (contract order: end -> final input -> debounce -> exactly one analysis).
    fire(box, 'input');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS - 1);
    expect(harness.dispatches).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.dispatches).toHaveLength(1);
    expect(harness.dispatches[0]!.snapshot.text).toBe('prep Hello vir');
  });

  it('keeps ignoring inputs while composing and analyzes once when compositionend arrives', async () => {
    const { harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    const box = composer();
    fire(box, 'compositionstart');
    fire(box, 'compositionupdate');
    fire(box, 'input'); // pathological: input while still composing
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS * 2);
    expect(harness.dispatches).toEqual([]);

    typeText(box, 'composed final text that is long enough'); // text lands while composing
    fire(box, 'compositionend'); // composition finishes: one debounced capture
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(harness.dispatches).toHaveLength(1);
    expect(harness.dispatches[0]!.snapshot.text).toBe('composed final text that is long enough');
  });
});

describe('paste (VAL-DRAFT-013)', () => {
  it('runs pasted text through the same debounced path without duplicates', async () => {
    const { harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    const box = composer();

    typeText(box, 'Pasted full text that is long enough to qualify here');
    fire(box, 'paste'); // paste + trailing input burst collapse into one capture
    fire(box, 'input');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS - 1);
    expect(harness.dispatches).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.dispatches).toHaveLength(1);
    expect(harness.dispatches[0]!.snapshot.text).toBe('Pasted full text that is long enough to qualify here');
    expect(harness.dispatches[0]!.snapshot.charCount).toBe(52);
  });
});

describe('immediate user-edit lane (M5 collapsed-first, VAL-DRAFT-036)', () => {
  it('notifies synchronously on the input event, BEFORE the debounced capture fires', async () => {
    const { harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    const box = composer();

    fire(box, 'input'); // the editor already wrote the DOM (event-after-write is the real order)
    // The overlay collapses its expanded panel on this notification: no timer has run, so the
    // capture (and therefore any analysis) is still pending.
    expect(harness.userEdits).toBe(1);
    expect(harness.draftEvents).toHaveLength(0);
    expect(harness.dispatches).toEqual([]);

    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(harness.draftEvents).toHaveLength(1);
    expect(harness.userEdits).toBe(1); // the debounced capture is not a second user edit
  });

  it('reports a typing burst once per edit and still debounces the capture', async () => {
    const { harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    const box = composer();

    for (const fragment of ['Thr', 'Three ', 'Three words ', 'Three words are enough']) {
      typeText(box, fragment); // the editor's DOM write
      fire(box, 'input'); // ...then its input event
      await vi.advanceTimersByTimeAsync(0); // the mutation lane absorbs this edit's own write
    }
    expect(harness.userEdits).toBe(4);
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(harness.draftEvents).toHaveLength(1); // one debounced capture for the whole burst
    expect(harness.userEdits).toBe(4);
  });

  it('reports a real paste ONCE even though paste fires input and mutates the DOM too', async () => {
    const { harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    const box = composer();

    typeText(box, 'Pasted text that is long enough to qualify here');
    fire(box, 'paste'); // the page's own listener then applies the text...
    fire(box, 'input'); // ...and the editor fires its paired input event
    await vi.advanceTimersByTimeAsync(0); // ...plus writes the DOM the mutation lane observes
    expect(harness.userEdits).toBe(1);

    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(harness.userEdits).toBe(1);
    expect(harness.draftEvents).toHaveLength(1);
    expect(harness.dispatches).toHaveLength(1);
  });

  it('still reports the real Draft.js clear, which fires NO input or paste event', async () => {
    const { harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    const box = composer();

    typeText(box, 'A draft long enough to be analyzed and then cleared');
    fire(box, 'input');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(harness.userEdits).toBe(1);

    // Select-all + Backspace on real x.com: pure DOM writes, no user-edit event at all. The panel
    // must collapse here too, otherwise it would keep covering the emptied composer.
    draftJsClearShape(box);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.userEdits).toBe(2);
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(harness.draftEvents.at(-1)!.snapshot.charCount).toBe(0);
    expect(harness.userEdits).toBe(2);
  });

  it('notifies on compositionend but NOT for input events during composition', async () => {
    const { harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    const box = composer();

    fire(box, 'compositionstart');
    typeText(box, 'composed');
    fire(box, 'input');
    typeText(box, 'composed text');
    fire(box, 'input');
    expect(harness.userEdits).toBe(0); // IME mid-composition is not a completed user edit

    fire(box, 'compositionend');
    expect(harness.userEdits).toBe(1);
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(harness.draftEvents).toHaveLength(1);
    expect(harness.userEdits).toBe(1); // the composition's own mutations are not re-reported
  });

  it('never reports once the lane has no listeners, and stops after unsubscribe', async () => {
    // A watcher with NO user-edit listener at all: the ambient lane must not even read the DOM
    // (there is nothing to collapse), so a page with no overlay wired pays nothing.
    let edits = 0;
    const watcher = createComposerWatcher({
      getMinDraftLength: () => 10,
      getAutoAnalyze: () => true,
      dispatchAnalysis: () => {},
    });
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    const box = composer();

    typeText(box, 'Typed with nothing listening on the lane');
    fire(box, 'input');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(edits).toBe(0);

    // Subscribing, then unsubscribing (teardown, or the overlay handing the lane back), stops it
    // for good — while the capture lanes keep working throughout.
    const count = (): void => {
      edits += 1;
    };
    watcher.onUserEdit(count);
    fire(box, 'input');
    expect(edits).toBe(1);
    watcher.onUserEdit(count)();
    fire(box, 'input');
    expect(edits).toBe(1);

    // Ambient edits (no user-edit event at all) are dropped too once nothing is listening.
    draftJsClearShape(box);
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(edits).toBe(1);
    expect(watcher.getSnapshot()?.charCount).toBe(0); // the capture lanes still ran
  });
});

describe('content-mutation lane (real-site clear, m4-fix-real-site-clear-reset)', () => {
  it('captures a clear that fires NO input event — the verified real Draft.js deletion path', async () => {
    const { watcher, harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'A draft long enough to be analyzed and then cleared');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(harness.draftEvents).toHaveLength(1);
    expect(harness.draftEvents[0]!.eligible).toBe(true);

    // Ctrl+A + Backspace on real x.com: the DOM drops to the empty block shape, NO input event.
    draftJsClearShape(composer());
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);

    expect(harness.draftEvents).toHaveLength(2);
    expect(harness.draftEvents[1]!.snapshot.text).toBe('');
    expect(harness.draftEvents[1]!.snapshot.charCount).toBe(0);
    expect(harness.draftEvents[1]!.eligible).toBe(false);
    expect(harness.dispatches).toHaveLength(1); // only the earlier eligible draft re-dispatched nothing
    expect(watcher.getSnapshot()?.charCount).toBe(0);
  });

  it('captures programmatic text changes without an input event at all (no event needed)', async () => {
    const { harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    setDomText(composer(), 'Changed entirely by the editor itself, no events');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(harness.draftEvents).toHaveLength(1);
    expect(harness.draftEvents[0]!.snapshot.text).toBe('Changed entirely by the editor itself, no events');
  });

  it('does not re-emit when a content mutation preserves the draft text (identity dedupe)', async () => {
    const { harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'Hello viral world again');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(harness.draftEvents).toHaveLength(1);

    // Editor re-render with identical text, different markup, no input event: not a new draft.
    const box = composer();
    const text = box.textContent ?? '';
    setDomText(box, text);
    const span = document.createElement('span');
    span.textContent = text;
    const line = document.createElement('div');
    line.append(span);
    box.replaceChildren(line);
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS * 2);

    expect(harness.draftEvents).toHaveLength(1);
    expect(harness.dispatches).toHaveLength(1);
  });

  it('re-emits when a user-edit event re-captures an identical draft (retype-retry contract)', async () => {
    // The dedupe only governs the AMBIENT mutation lane: a user edit (input event) that reads
    // identical must still re-emit and re-dispatch — retyping the identical draft is the retry
    // that lets its own transport failure settle with a success (pinned by the overlay's
    // success-after-failure flow).
    const { harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'Identical text typed twice for the retry');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(harness.draftEvents).toHaveLength(1);

    typeText(composer(), 'Identical text typed twice for the retry');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(harness.draftEvents).toHaveLength(2);
    expect(harness.dispatches).toHaveLength(2);
  });

  it('stays silent for content mutations during composition and captures once after compositionend', async () => {
    const { harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    const box = composer();
    fire(box, 'compositionstart');

    setDomText(box, 'composed text written by the IME itself'); // mutates without input
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS * 3);
    expect(harness.draftEvents).toEqual([]);
    expect(harness.dispatches).toEqual([]);

    fire(box, 'compositionend');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(harness.dispatches).toHaveLength(1);
    expect(harness.dispatches[0]!.snapshot.text).toBe('composed text written by the IME itself');
  });
});

describe('minDraftLength gate (VAL-SETUP-014)', () => {
  it('dispatches nothing below the threshold and dispatches at the raw-count boundary', async () => {
    const { harness } = start();
    await vi.advanceTimersByTimeAsync(0);

    typeText(composer(), '123456789'); // 9 raw chars, min 10
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS * 2);
    expect(harness.dispatches).toEqual([]);

    typeText(composer(), '1234567890'); // exactly 10 raw chars
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(harness.dispatches).toHaveLength(1);
  });

  it('counts spaces and newlines as characters (raw count)', async () => {
    const { harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'a b c d e '); // 10 raw chars incl. trailing space
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    expect(harness.dispatches).toHaveLength(1);
  });

  it('counts a blank line block as a raw character (9-char line + blank line = 10)', async () => {
    const { harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    const box = composer();
    box.replaceChildren();
    const line = document.createElement('div');
    line.textContent = '123456789';
    const blank = document.createElement('div');
    blank.innerHTML = '<br>'; // DraftEditor's empty-line block
    box.append(line, blank);
    box.dispatchEvent(new Event('input', { bubbles: true }));

    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS - 1);
    expect(harness.dispatches).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.dispatches).toHaveLength(1);
    expect(harness.dispatches[0]!.snapshot.charCount).toBe(10);
    expect(harness.dispatches[0]!.snapshot.text).toBe('123456789\n');
  });
});

describe('autoAnalyze off (VAL-SETUP-010)', () => {
  it('captures drafts on typing but never dispatches; the explicit request dispatches', async () => {
    const { watcher, harness } = start({ getAutoAnalyze: () => false });
    await vi.advanceTimersByTimeAsync(0);

    typeText(composer(), 'a manually analyzed draft');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS * 2);
    expect(harness.dispatches).toEqual([]);
    expect(harness.draftEvents).toHaveLength(1);

    expect(watcher.requestAnalysis()).toBe(true);
    expect(harness.dispatches).toHaveLength(1);
    expect(harness.dispatches[0]!.trigger).toBe('manual');
    expect(harness.dispatches[0]!.snapshot.text).toBe('a manually analyzed draft');
  });

  it('refuses the explicit request for drafts below minDraftLength', async () => {
    const { watcher, harness } = start({ getAutoAnalyze: () => false });
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'too short');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);

    expect(watcher.requestAnalysis()).toBe(false);
    expect(harness.dispatches).toEqual([]);
  });
});

describe('master disabled', () => {
  it('stops all activity on stop() and nothing runs until started again', async () => {
    const { watcher, harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'text that will never be analyzed');
    watcher.stop();

    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS * 3);
    expect(harness.dispatches).toEqual([]);
    document.body.append(document.createElement('div'));
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.composerEvents).toEqual([
      { type: 'attached', composer: composer() },
      { type: 'detached', composer: composer() },
    ]);

    // Restarting resumes detection from scratch.
    document.body.innerHTML = REPLY_VIEW_HTML;
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.getActiveComposer()).toBe(document.querySelector('[data-testid="tweetTextarea_1"]'));
  });

  it('never observes the DOM before start()', () => {
    const watcher = createComposerWatcher({
      getMinDraftLength: () => 10,
      getAutoAnalyze: () => true,
      dispatchAnalysis: () => undefined,
    });
    document.body.innerHTML = HOME_HTML;
    document.body.innerHTML = '<div></div>';
    expect(watcher.getActiveComposer()).toBeNull();
  });
});

describe('snapshot payload on dispatch', () => {
  it('carries the full extraction (hashtags, urls, reply context) to the analysis sink', async () => {
    document.body.innerHTML = REPLY_VIEW_HTML;
    const { harness } = start();
    await vi.advanceTimersByTimeAsync(0);
    typeText(composer(), 'Replying with #gratitude and https://thanks.example/x');
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);

    expect(harness.dispatches).toHaveLength(1);
    const { snapshot } = harness.dispatches[0]!;
    expect(snapshot.isReply).toBe(true);
    expect(snapshot.replyToHandle).toBe('ana_builds');
    expect('replyToFollowedByViewer' in snapshot).toBe(false);
    expect(snapshot.hashtags).toEqual(['gratitude']);
    expect(snapshot.urls).toEqual(['https://thanks.example/x']);
  });

  it('never sets replyToFollowedByViewer from any socialContext badge (verified real-x absence)', async () => {
    // library/x-dom.md (2026-10-03): the real reply composer exposes no viewer-follows-target
    // marker, so NO badge — visible or hidden, follow-worded or generic, beside the line or
    // nested away — may fabricate follow proof (VAL-DRAFT-019 never-guessed rule).
    const replyLine = '<div dir="ltr"><span>Respondendo a </span><a href="/ana_builds" role="link">@ana_builds</a></div>';
    const badgeCases = [
      { html: '<span data-testid="socialContext">Seguindo</span>' },
      { html: '<span data-testid="socialContext">Curtido por alguém</span>' },
      { html: '<span data-testid="socialContext" style="display:none">Seguindo</span>' },
      { html: '<div class="quoted-post-context"><span data-testid="socialContext">Seguindo</span></div>' },
    ] as const;
    for (const { html } of badgeCases) {
      document.body.innerHTML = REPLY_VIEW_HTML.replace(replyLine, `${replyLine}${html}`);
      const { harness } = start();
      await vi.advanceTimersByTimeAsync(0);
      typeText(composer(), 'Reply draft that is long enough');
      await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);

      expect(harness.dispatches).toHaveLength(1);
      const snapshot = harness.dispatches[0]!.snapshot;
      expect(snapshot.replyToHandle).toBe('ana_builds');
      expect('replyToFollowedByViewer' in snapshot).toBe(false);
      document.body.innerHTML = '';
    }
  });
});
