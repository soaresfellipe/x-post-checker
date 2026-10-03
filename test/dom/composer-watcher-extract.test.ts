import { beforeEach, describe, expect, it } from 'vitest';
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
});
