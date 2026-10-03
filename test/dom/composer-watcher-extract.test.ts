import { beforeEach, describe, expect, it } from 'vitest';
import { isDraftEligible } from '../../src/core/draft-snapshot';
import { extractDraftSnapshot, findComposer, findComposers, getComposerText } from '../../src/dom/composer-watcher/extract';

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
    expect(snapshot.replyToFollowedByViewer).toBe(true);
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

  it('omits replyToFollowedByViewer when no follow state is visible (never guessed)', () => {
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

  it('reads leading empty line blocks as the untouched-composer shape, not as newlines', () => {
    document.body.innerHTML =
      '<div id="c" role="textbox" contenteditable="true"><div><br></div><div><br></div><div>real text</div></div>';
    const composer = document.getElementById('c')!;

    expect(getComposerText(composer)).toBe('real text');
  });
});

describe('follow indicator binding (VAL-DRAFT-019: visible and target-specific only)', () => {
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

  it('grants the follow state for a visible badge beside the reply-to line (target-specific)', () => {
    document.body.innerHTML = RICH_REPLY_COMPOSER_HTML;
    const snapshot = extractDraftSnapshot(findComposer(document)!, { now: 1 });
    expect(snapshot.replyToHandle).toBe('ana_builds');
    expect(snapshot.replyToFollowedByViewer).toBe(true);
  });

  it('accepts the userFollowIndicator testid as the target-specific badge when visible', () => {
    document.body.innerHTML = RICH_REPLY_COMPOSER_HTML;
    document.querySelector('[data-testid="socialContext"]')!.setAttribute('data-testid', 'userFollowIndicator');
    const snapshot = extractDraftSnapshot(findComposer(document)!, { now: 1 });
    expect(snapshot.replyToFollowedByViewer).toBe(true);
  });

  it('stays absent when the badge is hidden with display:none', () => {
    document.body.innerHTML = RICH_REPLY_COMPOSER_HTML;
    document.querySelector('[data-testid="socialContext"]')!.setAttribute('style', 'display:none');
    const snapshot = extractDraftSnapshot(findComposer(document)!, { now: 1 });
    expect(snapshot.replyToHandle).toBe('ana_builds');
    expect('replyToFollowedByViewer' in snapshot).toBe(false);
  });

  it('stays absent when the badge carries the hidden attribute', () => {
    document.body.innerHTML = RICH_REPLY_COMPOSER_HTML;
    document.querySelector('[data-testid="socialContext"]')!.setAttribute('hidden', '');
    const snapshot = extractDraftSnapshot(findComposer(document)!, { now: 1 });
    expect('replyToFollowedByViewer' in snapshot).toBe(false);
  });

  it('stays absent when a socialContext badge in the region is unrelated to the reply line', () => {
    // Present in the composer region but nested away from the reply-to chip: it says nothing
    // about the reply target, so the boost must never be guessed from it.
    document.body.innerHTML = replyWith(
      '<div class="quoted-post-context"><span data-testid="socialContext">Seguindo</span></div>',
      '<div dir="ltr"><span>Respondendo a </span><a href="/ana_builds" role="link">@ana_builds</a></div>',
    );
    const snapshot = extractDraftSnapshot(findComposer(document)!, { now: 1 });
    expect(snapshot.replyToHandle).toBe('ana_builds');
    expect('replyToFollowedByViewer' in snapshot).toBe(false);
  });

  it('stays absent when the badge is inside a hidden subtree', () => {
    document.body.innerHTML = replyWith(
      '<div style="display:none"><span data-testid="socialContext">Seguindo</span></div>',
      '<div dir="ltr"><span>Respondendo a </span><a href="/ana_builds" role="link">@ana_builds</a></div>',
    );
    const snapshot = extractDraftSnapshot(findComposer(document)!, { now: 1 });
    expect('replyToFollowedByViewer' in snapshot).toBe(false);
  });

  it('stays absent when no visible reply target exists to bind the badge to', () => {
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
