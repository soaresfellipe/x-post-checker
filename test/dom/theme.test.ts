/**
 * DOM tests for the M6 theme foundation (m6-theme-foundation-and-realx-probe): ThemeDetector live
 * detection (mount read + body style-attribute MutationObserver + light fallback) and the shared
 * token STYLE block applied on each Shadow DOM :host (`library/design-1b.md` §2).
 */
import { describe, expect, it, vi } from 'vitest';
import { ThemeDetector, applyThemeTokens, setHostTheme } from '../../src/dom/theme';
import { THEME_TOKENS, THEME_TOKENS_CSS } from '../../src/dom/theme/tokens';

function setBodyBackground(doc: Document, value: string): void {
  doc.body.style.backgroundColor = value;
}

/** happy-dom dispatches MutationObserver callbacks asynchronously — flush the queue. */
const flushMutations = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('ThemeDetector', () => {
  it('reads the body background at mount', () => {
    setBodyBackground(document, 'rgb(21, 32, 43)');
    const detector = new ThemeDetector({ doc: document });
    expect(detector.getTheme()).toBe('dim');
    detector.destroy();
  });

  it('reacts to a live body style-attribute switch', async () => {
    const detector = new ThemeDetector({ doc: document });
    const seen: string[] = [];
    detector.subscribe((theme) => seen.push(theme));
    setBodyBackground(document, 'rgb(0, 0, 0)');
    await flushMutations();
    expect(detector.getTheme()).toBe('lights-out');
    setBodyBackground(document, 'rgb(255, 255, 255)');
    await flushMutations();
    expect(detector.getTheme()).toBe('light');
    expect(seen).toEqual(['lights-out', 'light']);
    detector.destroy();
  });

  it('falls back to light for unknown backgrounds, live and at mount', async () => {
    setBodyBackground(document, 'rgb(255, 255, 255)');
    const detector = new ThemeDetector({ doc: document });
    expect(detector.getTheme()).toBe('light');
    setBodyBackground(document, 'rgb(18, 18, 18)');
    await flushMutations();
    expect(detector.getTheme()).toBe('light');
    detector.destroy();
  });

  it('does not re-emit when the style attribute changes without a theme change', async () => {
    setBodyBackground(document, 'rgb(0, 0, 0)');
    const detector = new ThemeDetector({ doc: document });
    const seen: string[] = [];
    detector.subscribe((theme) => seen.push(theme));
    // An unrelated inline-style write keeps the same background color.
    document.body.style.margin = '1px';
    await flushMutations();
    expect(seen).toEqual([]);
    expect(detector.getTheme()).toBe('lights-out');
    detector.destroy();
  });

  it('stops observing after destroy()', async () => {
    setBodyBackground(document, 'rgb(255, 255, 255)');
    const detector = new ThemeDetector({ doc: document });
    const seen: string[] = [];
    detector.subscribe((theme) => seen.push(theme));
    detector.destroy();
    setBodyBackground(document, 'rgb(0, 0, 0)');
    await flushMutations();
    expect(seen).toEqual([]);
    // A destroyed detector is frozen at its last observed theme — it no longer reads the page.
    expect(detector.getTheme()).toBe('light');
  });

  it('subscribe returns an unsubscribe function', async () => {
    const detector = new ThemeDetector({ doc: document });
    const seen: string[] = [];
    const unsubscribe = detector.subscribe((theme) => seen.push(theme));
    unsubscribe();
    setBodyBackground(document, 'rgb(0, 0, 0)');
    await flushMutations();
    expect(seen).toEqual([]);
    detector.destroy();
  });
});

describe('theme tokens', () => {
  it('carries the Design 1b token table for all three themes', () => {
    expect(THEME_TOKENS.light).toMatchObject({
      bg: '#ffffff', fg: '#0f1419', fg2: '#536471', line: '#eff3f4', outline: '#cfd9de',
      hover: '#f7f9f9', accent: '#1d9bf0', good: '#00ba7c', ok: '#b58105', weak: '#f4212e',
    });
    expect(THEME_TOKENS.dim).toMatchObject({
      bg: '#15202b', fg: '#f7f9f9', fg2: '#8b98a5', line: '#38444d', outline: '#536471',
      hover: '#1e2732', accent: '#1d9bf0', good: '#00ba7c', ok: '#ffd400', weak: '#f4212e',
    });
    expect(THEME_TOKENS['lights-out']).toMatchObject({
      bg: '#000000', fg: '#e7e9ea', fg2: '#71767b', line: '#2f3336', outline: '#536471',
      hover: '#16181c', accent: '#1d9bf0', good: '#00ba7c', ok: '#ffd400', weak: '#f4212e',
    });
  });

  it('emits one shared STYLE block whose light values are the :host defaults (light fallback)', () => {
    expect(THEME_TOKENS_CSS.trim()).toMatch(/^:host \{/);
    expect(THEME_TOKENS_CSS).toContain('--bg:#ffffff');
    expect(THEME_TOKENS_CSS).toContain(":host([data-theme='dim'])");
    expect(THEME_TOKENS_CSS).toContain(":host([data-theme='lights-out'])");
    expect(THEME_TOKENS_CSS).toContain('--accent-bg:rgba(29,155,240,.12)');
  });

  it('applyThemeTokens injects the token block into a shadow root, idempotently', () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const first = applyThemeTokens(shadow);
    const second = applyThemeTokens(shadow);
    expect(first).toBe(second);
    const blocks = shadow.querySelectorAll('style[data-amplifyx-theme-tokens]');
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.textContent).toBe(THEME_TOKENS_CSS);
  });

  it('setHostTheme stamps the resolved theme on the host element', () => {
    const host = document.createElement('div');
    setHostTheme(host, 'dim');
    expect(host.dataset.theme).toBe('dim');
    setHostTheme(host, 'light');
    expect(host.dataset.theme).toBe('light');
  });

  it('token custom properties are exempt from a sibling all:initial host reset', () => {
    // The badge/overlay STYLE blocks open with `:host { all: initial; }`; CSS custom properties
    // are exempt from `all`, so the token block survives regardless of block order. happy-dom
    // cannot compute custom properties, so this asserts the structural fact the surfaces rely on.
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const reset = document.createElement('style');
    reset.textContent = ':host { all: initial; }';
    shadow.append(applyThemeTokens(shadow), reset);
    expect(applyThemeTokens(shadow).previousSibling).toBeNull();
  });
});

describe('detector + tokens wiring on a themed host', () => {
  it('drives a host data-theme through live switches', async () => {
    const detector = new ThemeDetector({ doc: document });
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    applyThemeTokens(shadow);
    setHostTheme(host, detector.getTheme());
    detector.subscribe((theme) => setHostTheme(host, theme));

    setBodyBackground(document, 'rgb(21, 32, 43)');
    await flushMutations();
    expect(host.dataset.theme).toBe('dim');
    setBodyBackground(document, 'rgb(0, 0, 0)');
    await flushMutations();
    expect(host.dataset.theme).toBe('lights-out');
    setBodyBackground(document, 'rgb(51, 51, 51)');
    await flushMutations();
    expect(host.dataset.theme).toBe('light');
    detector.destroy();
  });

  it('emits a live switch exactly once regardless of redundant style writes', async () => {
    const detector = new ThemeDetector({ doc: document });
    const spy = vi.fn();
    detector.subscribe(spy);
    setBodyBackground(document, 'rgb(0, 0, 0)');
    setBodyBackground(document, 'rgb(0, 0, 0)');
    await flushMutations();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('lights-out');
    detector.destroy();
  });
});
