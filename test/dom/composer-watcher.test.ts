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
}

function typeText(composer: Element, text: string): void {
  composer.replaceChildren();
  const line = document.createElement('div');
  line.textContent = text;
  composer.append(line);
  composer.dispatchEvent(new Event('input', { bubbles: true }));
}

function fire(composer: Element, type: string): void {
  composer.dispatchEvent(new Event(type, { bubbles: true }));
}

/** The active textbox (never the *RichTextInputContainer wrapper, whose testid shares the prefix). */
function composer(): Element {
  return (document.querySelector('[data-testid="tweetTextarea_1"]') ??
    document.querySelector('[data-testid="tweetTextarea_0"]'))!;
}

function start(overrides: Partial<Parameters<typeof createComposerWatcher>[0]> = {}) {
  const harness: Harness = { dispatches: [], draftEvents: [], composerEvents: [] };
  const watcher = createComposerWatcher({
    getMinDraftLength: () => 10,
    getAutoAnalyze: () => true,
    dispatchAnalysis: (dispatch) => harness.dispatches.push(dispatch),
    ...overrides,
  });
  watcher.onDraft((event) => harness.draftEvents.push(event));
  watcher.onComposerChange((event) => harness.composerEvents.push(event));
  watcher.start();
  return { watcher, harness };
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = HOME_HTML;
});

afterEach(() => {
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
