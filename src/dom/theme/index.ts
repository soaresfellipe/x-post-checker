/**
 * Shared theme foundation for ALL extension Shadow-DOM surfaces (overlay, badges, popover).
 * Each surface applies `THEME_TOKENS_CSS` to its own shadow root (the tokens become custom
 * properties on that `:host`) and stamps the ThemeDetector's resolved theme on the host
 * element's `data-theme` attribute.
 */
import type { ThemeDetector } from './theme-detector';
import { THEME_TOKENS_CSS, type XTheme } from './tokens';

export { ThemeDetector, mapBackgroundColor } from './theme-detector';
export type { ThemeDetectorOptions, ThemeListener } from './theme-detector';
export { THEME_TOKENS, THEME_TOKENS_CSS } from './tokens';
export type { XTheme, ThemeTokens } from './tokens';

/** Attribute stamped on every themed host by `setHostTheme` / the token STYLE block selector. */
export const THEME_ATTRIBUTE = 'data-theme';

/** The data attribute marking the token STYLE block inside a themed shadow root. */
const TOKENS_STYLE_MARKER = 'data-amplifyx-theme-tokens';

/**
 * Idempotently injects the shared token STYLE block into a shadow root and returns its element
 * (surfaces re-painting their shadow with `replaceChildren` must include the returned element).
 */
export function applyThemeTokens(shadow: ShadowRoot): HTMLStyleElement {
  const existing = shadow.querySelector(`style[${TOKENS_STYLE_MARKER}]`);
  if (existing) return existing as HTMLStyleElement;
  const style = shadow.ownerDocument.createElement('style');
  style.setAttribute(TOKENS_STYLE_MARKER, '');
  style.textContent = THEME_TOKENS_CSS;
  shadow.append(style);
  return style;
}

/** Stamps the resolved theme on a themed host element (light is also stamped explicitly). */
export function setHostTheme(host: Element, theme: XTheme): void {
  host.setAttribute(THEME_ATTRIBUTE, theme);
}

/** Convenience: mounts a detector-driven theme on a host (tokens + live data-theme updates). */
export function attachTheme(
  host: HTMLElement,
  shadow: ShadowRoot,
  detector: ThemeDetector,
): void {
  applyThemeTokens(shadow);
  setHostTheme(host, detector.getTheme());
  detector.subscribe((theme) => setHostTheme(host, theme));
}
