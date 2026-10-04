import { beforeEach, describe, expect, it } from 'vitest';
import { isDraftEligible } from '../../src/core/draft-snapshot';
import {
  extractDraftSnapshot,
  findComposer,
  findComposerAnchorRegion,
  findComposerRegion,
  findComposers,
  getComposerText,
} from '../../src/dom/composer-watcher/extract';

/** Reply composer mirroring x.com's DraftEditor structure with rich context around it. */
const RICH_REPLY_COMPOSER_HTML = `
<div data-testid="primaryColumn">
  <div data-testid="replyComposerContainer">
    <div data-testid="app-bar-close" role="button">Voltar</div>
    <div data-testid="tweetTextarea_1RichTextInputContainer">
      <div class="DraftEditor-root">
        <div data-testid="tweetTextarea_1" role="textbox" contenteditable="true" aria-label="Texto do seu post" class="public-DraftEditor-content">
          <div>Great thread about #rustlang and #wasm, details at https://example.com/rust-notes soon</div>
        </div>
      </div>
      <div dir="ltr"><span>Respondendo a </span><a href="/ana_builds" role="link">@ana_builds</a></div>
      <span data-testid="socialContext">Seguindo</span>
    </div>
    <div data-testid="attachments"><div data-testid="tweetPhoto"><img alt="Imagem" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="/></div></div>
    <button type="button" data-testid="tweetButton" aria-disabled="false">Responder</button>
  </div>
</div>`;

const MAIN_COMPOSER_HTML = `
<div data-testid="primaryColumn">
  <div data-testid="toolBar">
    <div data-testid="tweetTextarea_0RichTextInputContainer">
      <div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" aria-label="Texto do post" class="public-DraftEditor-content"></div>
    </div>
    <button type="button" data-testid="tweetButtonInline" aria-disabled="true">Postar</button>
  </div>
  <div aria-label="Timeline: Sua Página Inicial">
    <article data-testid="tweet">
      <div data-testid="User-Name"><a href="/joaodev" role="link"><span>@joaodev</span></a></div>
      <div data-testid="tweetPhoto"><img alt="Imagem" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="/></div>
    </article>
  </div>
</div>`;

/**
 * The VERIFIED real status-page composer shape (library/x-dom.md, 2026-10-03 inspection): the
 * inline "Post your reply" composer under the primary post is tweetTextarea_0 and its region
 * (parent of tweetTextarea_0RichTextInputContainer) contains ONLY those two testids — no reply
 * chip, no follow badge. Reply context must come from the status ROUTE (/<handle>/status/<id>).
 */
const STATUS_PAGE_COMPOSER_HTML = `
<div data-testid="primaryColumn">
  <div data-testid="statusView">
    <article data-testid="tweet">
      <div data-testid="User-Name"><a href="/ana_builds" role="link"><span>@ana_builds</span></a></div>
      <div data-testid="tweetText"><span>The primary post being viewed lives above the composer</span></div>
    </article>
    <div>
      <div data-testid="tweetTextarea_0RichTextInputContainer">
        <div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" aria-label="Poste sua resposta" class="public-DraftEditor-content"></div>
      </div>
    </div>
    <button type="button" data-testid="tweetButtonInline" aria-disabled="true">Responder</button>
  </div>
</div>`;

/** Sets the SPA route the way x.com does (history API) without reloading the document. */
function navigateTo(path: string): void {
  history.pushState({}, '', path);
}

/** Reply-DIALOG shape: numbered composer WITHOUT a visible reply chip (handle not determinable). */
const REPLY_DIALOG_HTML = `
<div data-testid="primaryColumn">
  <div data-testid="replyComposerContainer">
    <div data-testid="tweetTextarea_1RichTextInputContainer">
      <div data-testid="tweetTextarea_1" role="textbox" contenteditable="true" class="public-DraftEditor-content"></div>
    </div>
  </div>
</div>`;

describe('composer extraction (VAL-DRAFT-030)', () => {
  beforeEach(() => {
    document.body.innerHTML = RICH_REPLY_COMPOSER_HTML;
  });

  it('extracts a rich reply draft field-for-field', () => {
    const composer = findComposer(document)!;
    const snapshot = extractDraftSnapshot(composer, { now: 1_700_000_000_000 });

    expect(snapshot.text).toBe('Great thread about #rustlang and #wasm, details at https://example.com/rust-notes soon');
    expect(snapshot.hashtags).toEqual(['rustlang', 'wasm']);
    expect(snapshot.urls).toEqual(['https://example.com/rust-notes']);
    expect(snapshot.hasMedia).toBe(true);
    expect(snapshot.isReply).toBe(true);
    expect(snapshot.replyToHandle).toBe('ana_builds');
    expect('replyToFollowedByViewer' in snapshot).toBe(false);
    expect(snapshot.charCount).toBe(snapshot.text.length);
    expect(snapshot.capturedAt).toBe(1_700_000_000_000);
  });

  it('extracts a plain main draft with isReply false and no reply fields', () => {
    document.body.innerHTML = MAIN_COMPOSER_HTML;
    const composer = findComposer(document)!;
    composer.replaceChildren();
    const line = document.createElement('div');
    line.textContent = 'What is the one tool you stopped using this year, and why?';
    composer.append(line);

    const snapshot = extractDraftSnapshot(composer, { now: 1 });

    expect(snapshot.text).toBe('What is the one tool you stopped using this year, and why?');
    expect(snapshot.hashtags).toEqual([]);
    expect(snapshot.urls).toEqual([]);
    expect(snapshot.hasMedia).toBe(false);
    expect(snapshot.isReply).toBe(false);
    expect('replyToHandle' in snapshot).toBe(false);
    expect('replyToFollowedByViewer' in snapshot).toBe(false);
    expect(snapshot.charCount).toBe(snapshot.text.length);
  });

  it('omits every optional reply field beyond the visible handle (nothing guessed)', () => {
    document.querySelector('[data-testid="socialContext"]')!.remove();
    const snapshot = extractDraftSnapshot(findComposer(document)!, { now: 1 });
    expect(snapshot.isReply).toBe(true);
    expect(snapshot.replyToHandle).toBe('ana_builds');
    expect('replyToFollowedByViewer' in snapshot).toBe(false);
  });

  it('stamps capturedAt from the clock when no now is injected', () => {
    const before = Date.now() - 1;
    const snapshot = extractDraftSnapshot(findComposer(document)!, { now: undefined });
    expect(snapshot.capturedAt).toBeGreaterThanOrEqual(before);
    expect(snapshot.capturedAt).toBeLessThanOrEqual(Date.now() + 1);
  });

  it('treats a main composer (tweetTextarea_0) with reply context markup as a reply', () => {
    document.body.innerHTML = MAIN_COMPOSER_HTML;
    const toolBar = document.querySelector('[data-testid="toolBar"]')!;
    toolBar.insertAdjacentHTML(
      'afterbegin',
      '<div dir="ltr"><span>Respondendo a </span><a href="/old_timer" role="link">@old_timer</a></div>',
    );
    const snapshot = extractDraftSnapshot(findComposer(document)!, { now: 1 });
    expect(snapshot.isReply).toBe(true);
    expect(snapshot.replyToHandle).toBe('old_timer');
  });
});

describe('real status-page reply shape (M2 scrutiny round 3, VAL-DRAFT-019)', () => {
  beforeEach(() => {
    document.body.innerHTML = STATUS_PAGE_COMPOSER_HTML;
    history.pushState({}, '', '/');
  });

  it('classifies the inline status-page composer as a reply from the ROUTE (tweetTextarea_0, no chip)', () => {
    navigateTo('/ana_builds/status/1800000000000000001');
    const snapshot = extractDraftSnapshot(findComposer(document)!, { now: 1 });

    expect(snapshot.isReply).toBe(true);
    expect(snapshot.replyToHandle).toBe('ana_builds');
    expect('replyToFollowedByViewer' in snapshot).toBe(false);
  });

  it('keeps the same composer standalone on a home route (context follows the route, not the markup)', () => {
    navigateTo('/home');
    const snapshot = extractDraftSnapshot(findComposer(document)!, { now: 1 });

    expect(snapshot.isReply).toBe(false);
    expect('replyToHandle' in snapshot).toBe(false);
    expect('replyToFollowedByViewer' in snapshot).toBe(false);
  });

  it('never guesses a handle from a reserved non-handle status root (/i/status/...)', () => {
    navigateTo('/i/status/1800000000000000001');
    const snapshot = extractDraftSnapshot(findComposer(document)!, { now: 1 });

    expect(snapshot.isReply).toBe(false);
    expect('replyToHandle' in snapshot).toBe(false);
  });

  it('prefers the visible in-region chip over the route handle (nested-reply dialog shapes)', () => {
    document.body.innerHTML = RICH_REPLY_COMPOSER_HTML; // chip says @ana_builds, route differs
    navigateTo('/someone_else/status/1800000000000000099');
    const snapshot = extractDraftSnapshot(findComposer(document)!, { now: 1 });

    expect(snapshot.isReply).toBe(true);
    expect(snapshot.replyToHandle).toBe('ana_builds');
  });

  it('yields isReply true with NO handle when the chip is absent and the route is not a status shape', () => {
    // Dialog shape on a non-status route: reply via the numbered composer, handle not determinable.
    document.body.innerHTML = REPLY_DIALOG_HTML;
    navigateTo('/home');
    const snapshot = extractDraftSnapshot(findComposer(document)!, { now: 1 });

    expect(snapshot.isReply).toBe(true);
    expect('replyToHandle' in snapshot).toBe(false);
  });
});

describe('composer detection chains (VAL-DRAFT-029)', () => {
  it('prefers the primary testid, then numbered composers, then the structural fallback', () => {
    document.body.innerHTML = MAIN_COMPOSER_HTML;
    expect(findComposer(document)!.getAttribute('data-testid')).toBe('tweetTextarea_0');

    const renamed = document.querySelector('[data-testid="tweetTextarea_0"]')!;
    renamed.setAttribute('data-testid', 'tweetTextarea_2');
    expect(findComposer(document)!.getAttribute('data-testid')).toBe('tweetTextarea_2');

    renamed.removeAttribute('data-testid');
    expect(findComposer(document)!.classList.contains('public-DraftEditor-content')).toBe(true);
  });

  it('returns no composer and no snapshot when no known selector matches', () => {
    document.body.innerHTML = '<div data-testid="primaryColumn"><div class="plain">nothing here</div></div>';
    expect(findComposer(document)).toBeNull();
    expect(findComposers(document)).toEqual([]);
    expect(() => findComposer(document)).not.toThrow();
  });
});

describe('composer text extraction', () => {
  it('joins DraftEditor line blocks with newlines and reads plain text nodes', () => {
    document.body.innerHTML = '<div id="c" role="textbox" contenteditable="true"></div>';
    const composer = document.getElementById('c')!;
    composer.append('first');
    const second = document.createElement('div');
    second.textContent = 'second';
    composer.append(second);

    expect(getComposerText(composer)).toBe('first\nsecond');
  });

  it('counts a trailing empty line block as the raw newline (9-char line + blank = 10 raw chars)', () => {
    // DraftEditor renders an empty line as a block whose content is just <br>; its newline is a
    // raw character for the minDraftLength gate (VAL-DRAFT-030, VAL-SETUP-014).
    document.body.innerHTML =
      '<div id="c" role="textbox" contenteditable="true"><div>123456789</div><div><br></div></div>';
    const composer = document.getElementById('c')!;

    expect(getComposerText(composer)).toBe('123456789\n');
    const snapshot = extractDraftSnapshot(composer, { now: 1 });
    expect(snapshot.charCount).toBe(10);
    expect(isDraftEligible(snapshot, 10)).toBe(true);
  });

  it('keeps blank lines between paragraphs in text and charCount', () => {
    document.body.innerHTML =
      '<div id="c" role="textbox" contenteditable="true"><div>one</div><div><br></div><div>two</div></div>';
    const composer = document.getElementById('c')!;

    expect(getComposerText(composer)).toBe('one\n\ntwo');
    expect(extractDraftSnapshot(composer, { now: 1 }).charCount).toBe(8);
  });

  it('reads an untouched composer (single empty placeholder block) as zero raw chars', () => {
    // The empty-composer shape must stay empty, or the overlay would never show its empty state.
    document.body.innerHTML = '<div id="c" role="textbox" contenteditable="true"><div><br></div></div>';
    const composer = document.getElementById('c')!;

    expect(getComposerText(composer)).toBe('');
    expect(extractDraftSnapshot(composer, { now: 1 }).charCount).toBe(0);
  });

  it('counts a USER-entered leading blank line as the raw newline (blank + 9 chars = 10 raw chars)', () => {
    // Pressing Enter on the untouched composer leaves one empty leading block; typing nine
    // characters after it yields 10 RAW characters — eligible at minDraftLength 10
    // (VAL-SETUP-014, VAL-DRAFT-030). Only the untouched placeholder may read as zero.
    document.body.innerHTML =
      '<div id="c" role="textbox" contenteditable="true"><div><br></div><div>123456789</div></div>';
    const composer = document.getElementById('c')!;

    expect(getComposerText(composer)).toBe('\n123456789');
    const snapshot = extractDraftSnapshot(composer, { now: 1 });
    expect(snapshot.charCount).toBe(10);
    expect(isDraftEligible(snapshot, 10)).toBe(true);
  });

  it('keeps the leading-blank boundary honest: blank + 8 chars = 9 raw chars, below the gate', () => {
    document.body.innerHTML =
      '<div id="c" role="textbox" contenteditable="true"><div><br></div><div>12345678</div></div>';
    const composer = document.getElementById('c')!;

    const snapshot = extractDraftSnapshot(composer, { now: 1 });
    expect(snapshot.text).toBe('\n12345678');
    expect(snapshot.charCount).toBe(9);
    expect(isDraftEligible(snapshot, 10)).toBe(false);
  });

  it('counts EVERY user-entered leading blank line (two leading blanks + text = two raw newlines)', () => {
    document.body.innerHTML =
      '<div id="c" role="textbox" contenteditable="true"><div><br></div><div><br></div><div>real text</div></div>';
    const composer = document.getElementById('c')!;

    expect(getComposerText(composer)).toBe('\n\nreal text');
    expect(extractDraftSnapshot(composer, { now: 1 }).charCount).toBe(11);
  });
});

describe('follow proof is never inferred from composer DOM (VAL-DRAFT-019, verified real-x absence)', () => {
  // library/x-dom.md (2026-10-03 inspection): the real reply composer region exposes NO node for
  // "viewer follows the reply target" — no socialContext, no userFollowIndicator, no follow-
  // vocabulary text, for in-network AND out-of-network targets, before and after focus. A badge
  // near the reply-to line is therefore never follow proof, whatever its testid or words.
  const replyWith = (badgeHtml: string, replyLineHtml = ''): string => `
<div data-testid="primaryColumn">
  <div data-testid="replyComposerContainer">
    <div data-testid="tweetTextarea_1RichTextInputContainer">
      <div data-testid="tweetTextarea_1" role="textbox" contenteditable="true" class="public-DraftEditor-content"></div>
      ${replyLineHtml}
      ${badgeHtml}
    </div>
  </div>
</div>`;
  const replyLine = '<div dir="ltr"><span>Respondendo a </span><a href="/ana_builds" role="link">@ana_builds</a></div>';

  it('never treats a generic socialContext sibling of the reply-to line as follow proof', () => {
    // The round-2 blocker: a generic "Liked by someone" badge shares the reply line's container —
    // proximity is not a follow relationship, and liking the post proves nothing about following.
    document.body.innerHTML = replyWith(
      '<span data-testid="socialContext">Curtido por alguém</span>',
      replyLine,
    );
    const snapshot = extractDraftSnapshot(findComposer(document)!, { now: 1 });
    expect(snapshot.replyToHandle).toBe('ana_builds');
    expect('replyToFollowedByViewer' in snapshot).toBe(false);
  });

  it('never treats even follow-WORDED badges beside the reply line as follow proof', () => {
    document.body.innerHTML = replyWith('<span data-testid="socialContext">Seguindo</span>', replyLine);
    const snapshot = extractDraftSnapshot(findComposer(document)!, { now: 1 });
    expect('replyToFollowedByViewer' in snapshot).toBe(false);
  });

  it('never treats a userFollowIndicator badge as viewer-follows-target proof (direction is the reverse)', () => {
    document.body.innerHTML = replyWith('<span data-testid="userFollowIndicator">Segue você</span>', replyLine);
    const snapshot = extractDraftSnapshot(findComposer(document)!, { now: 1 });
    expect('replyToFollowedByViewer' in snapshot).toBe(false);
  });

  it('stays absent when the badge is hidden with display:none', () => {
    document.body.innerHTML = replyWith(
      '<span data-testid="socialContext" style="display:none">Seguindo</span>',
      replyLine,
    );
    const snapshot = extractDraftSnapshot(findComposer(document)!, { now: 1 });
    expect('replyToFollowedByViewer' in snapshot).toBe(false);
  });

  it('stays absent when a socialContext badge in the region is unrelated to the reply line', () => {
    document.body.innerHTML = replyWith(
      '<div class="quoted-post-context"><span data-testid="socialContext">Seguindo</span></div>',
      replyLine,
    );
    const snapshot = extractDraftSnapshot(findComposer(document)!, { now: 1 });
    expect('replyToFollowedByViewer' in snapshot).toBe(false);
  });

  it('stays absent when no visible reply target exists to bind a badge to', () => {
    document.body.innerHTML = replyWith('<span data-testid="socialContext">Seguindo</span>');
    const snapshot = extractDraftSnapshot(findComposer(document)!, { now: 1 });
    expect(snapshot.isReply).toBe(true); // numbered reply composer
    expect('replyToHandle' in snapshot).toBe(false);
    expect('replyToFollowedByViewer' in snapshot).toBe(false);
  });
});

describe('structural fallback is composer-container-scoped (VAL-DRAFT-029)', () => {
  it('ignores a DraftEditor editor outside any recognized composer container', () => {
    // An unrelated editor (e.g. an Explore search box) on a composer-less route: no composer,
    // no injection, no error.
    document.body.innerHTML = `
<div data-testid="primaryColumn">
  <div data-testid="exploreView">
    <div class="DraftEditor-root">
      <div class="public-DraftEditor-content" role="textbox" contenteditable="true" aria-label="Buscar"></div>
    </div>
  </div>
</div>`;
    expect(findComposer(document)).toBeNull();
    expect(findComposers(document)).toEqual([]);
  });

  it('still finds the structural fallback inside a RichTextInputContainer without a testid', () => {
    document.body.innerHTML = `
<div data-testid="primaryColumn">
  <div data-testid="tweetTextarea_0RichTextInputContainer">
    <div class="public-DraftEditor-content" role="textbox" contenteditable="true"></div>
  </div>
</div>`;
    expect(findComposer(document)).not.toBeNull();
  });

  it('accepts the toolbar as a recognized composer container', () => {
    document.body.innerHTML = `
<div data-testid="primaryColumn">
  <div data-testid="toolBar">
    <div class="public-DraftEditor-content" role="textbox" contenteditable="true"></div>
  </div>
</div>`;
    expect(findComposer(document)).not.toBeNull();
  });
});

describe('t.co expansion (VAL-DRAFT-030 urls contract)', () => {
  const composerWith = (lineHtml: string): Element => {
    document.body.innerHTML = `<div id="c" role="textbox" contenteditable="true">${lineHtml}</div>`;
    return document.getElementById('c')!;
  };

  it('keeps a short URL as written when no expansion is visible', () => {
    const snapshot = extractDraftSnapshot(composerWith('<div>Look https://t.co/abc123</div>'), { now: 1 });
    expect(snapshot.urls).toEqual(['https://t.co/abc123']);
  });

  it('uses the expanded destination exposed by the link chip href', () => {
    const snapshot = extractDraftSnapshot(
      composerWith('<div>Look <a href="https://example.com/full/path" role="link">https://t.co/abc123</a></div>'),
      { now: 1 },
    );
    expect(snapshot.urls).toEqual(['https://example.com/full/path']);
  });

  it('prefers an explicit data-expanded-url over the chip href', () => {
    const snapshot = extractDraftSnapshot(
      composerWith(
        '<div>Look <a href="https://t.co/abc123" data-expanded-url="https://example.com/expanded" role="link">https://t.co/abc123</a></div>',
      ),
      { now: 1 },
    );
    expect(snapshot.urls).toEqual(['https://example.com/expanded']);
  });

  it('keeps the short form when the chip href is the same short URL', () => {
    const snapshot = extractDraftSnapshot(
      composerWith('<div>Look <a href="https://t.co/abc123" role="link">https://t.co/abc123</a></div>'),
      { now: 1 },
    );
    expect(snapshot.urls).toEqual(['https://t.co/abc123']);
  });

  it('expands only the chips that expose a destination, preserving order and dedupe', () => {
    const snapshot = extractDraftSnapshot(
      composerWith(
        '<div>Two <a href="https://example.com/one" role="link">https://t.co/one</a> and https://t.co/plain and <a href="https://example.com/two" role="link">https://t.co/two</a></div>',
      ),
      { now: 1 },
    );
    expect(snapshot.urls).toEqual(['https://example.com/one', 'https://t.co/plain', 'https://example.com/two']);
  });
});

/**
 * The REAL home-composer nesting, verified live on logged-in x.com (2026-10-04,
 * m5-overlay-scroll-reach survey, scripts/real-x-dom-survey.mjs): the editor's
 * RichTextInputContainer parent is a TIGHT text-row wrapper (76px, only the editor inside), and
 * the furniture row (`toolBar`: media control, character counter, Post button) is a SIBLING
 * subtree of the common composer block. Anchoring overlay PLACEMENT to the tight wrapper made
 * the expanded panel cover the furniture row on the real site (measured: the panel box overlapped
 * the Post button's box), while the fixture's old nesting (toolBar wrapping the editor) hid the
 * defect from every E2E geometry pin.
 */
const REAL_HOME_COMPOSER_HTML = `
<div data-testid="primaryColumn">
  <div>
    <div>
      <div data-testid="tweetTextarea_0RichTextInputContainer">
        <div class="DraftEditor-root">
          <div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" aria-label="Texto do post" class="public-DraftEditor-content"></div>
        </div>
        <label data-testid="tweetTextarea_0_label">O que está acontecendo?</label>
      </div>
    </div>
    <div data-testid="toolBar">
      <button type="button" data-testid="addMedia" aria-label="Adicionar midia">Midia</button>
      <span data-testid="charCounter">0</span>
      <button type="button" data-testid="tweetButtonInline" aria-disabled="true">Postar</button>
    </div>
  </div>
</div>`;

describe('composer anchor region for overlay placement (m5-overlay-scroll-reach)', () => {
  it('climbs to the furniture-containing block on the REAL nesting; extraction stays tight', () => {
    document.body.innerHTML = REAL_HOME_COMPOSER_HTML;
    const composer = findComposer(document)!;
    const anchor = findComposerAnchorRegion(composer) as Element;
    // The PLACEMENT anchor contains the furniture row, so the expanded panel anchors below it
    // and the collapsed pill lands in the furniture row's band (VAL-DRAFT-033 on the real DOM).
    expect(anchor.querySelector('[data-testid="toolBar"]')).not.toBeNull();
    expect(anchor.querySelector('[data-testid="tweetButtonInline"]')).not.toBeNull();
    expect(anchor.contains(composer)).toBe(true);

    // EXTRACTION keeps the tight region: media chips and reply chips must never be read from
    // foreign subtrees the climb adds (a status page's primary post is NOT composer content).
    const extraction = findComposerRegion(composer) as Element;
    expect(extraction.querySelector('[data-testid="toolBar"]')).toBeNull();
  });

  it('returns the same region as extraction when the furniture row already wraps the editor (fixture nesting)', () => {
    document.body.innerHTML = MAIN_COMPOSER_HTML;
    const composer = findComposer(document)!;
    expect(findComposerAnchorRegion(composer)).toBe(findComposerRegion(composer));
  });

  it('falls back to the extraction region when no furniture exists anywhere above (reply dialog)', () => {
    document.body.innerHTML = REPLY_DIALOG_HTML;
    const composer = findComposer(document)!;
    expect(findComposerAnchorRegion(composer)).toBe(findComposerRegion(composer));
  });
});
