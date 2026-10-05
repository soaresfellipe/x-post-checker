/**
 * The Design 1b theme tokens (`library/design-1b.md` §2) — the single shared source for every
 * extension surface. Resolved tokens are exposed as CSS custom properties on each Shadow DOM
 * `:host` from ONE shared STYLE block (`THEME_TOKENS_CSS`); light values are the `:host`
 * defaults, so an unknown background's light fallback needs no attribute at all.
 *
 * Custom properties are exempt from the `all: initial` reset the surface STYLE blocks open with,
 * so this block composes with any surface stylesheet regardless of order.
 */

export type XTheme = 'light' | 'dim' | 'lights-out';

export interface ThemeTokens {
  bg: string;
  fg: string;
  fg2: string;
  line: string;
  outline: string;
  hover: string;
  accent: string;
  accentBg: string;
  good: string;
  goodBg: string;
  ok: string;
  weak: string;
  weakBg: string;
  shadow: string;
  /**
   * A11y text variants (VAL-THEME-003, m6-theme-a11y-sweep). The spec's --good/--weak FAIL
   * 4.5:1 as TEXT in some themes (#00ba7c on the 14% green tint over white is ~2.2:1), so every
   * textual use of the tier colors renders --good-text/--weak-text instead — same hue family,
   * computed accessible per theme (pinned by test/unit/theme-contrast.test.ts). --good/--weak
   * remain for NON-text uses only: dots and the solid hover inversions (white text on them).
   */
  goodText: string;
  weakText: string;
  /** `--fg2`-toned text sitting on the `--hover` surface (neutral toggles, ok chips): in
   * lights-out #71767b on #16181c is ~3.9:1, so that theme lifts the text a step. */
  fg2Hover: string;
}

export const THEME_TOKENS: Record<XTheme, ThemeTokens> = Object.freeze({
  light: Object.freeze({
    bg: '#ffffff',
    fg: '#0f1419',
    fg2: '#536471',
    line: '#eff3f4',
    outline: '#cfd9de',
    hover: '#f7f9f9',
    accent: '#1d9bf0',
    accentBg: 'rgba(29,155,240,.12)',
    good: '#00ba7c',
    goodBg: 'rgba(0,186,124,.14)',
    ok: '#b58105',
    weak: '#f4212e',
    weakBg: 'rgba(244,33,46,.12)',
    shadow: '0 0 15px rgba(101,119,134,.2), 0 0 3px 1px rgba(101,119,134,.15)',
    goodText: '#007a4d',
    weakText: '#cc1122',
    fg2Hover: '#536471',
  }),
  dim: Object.freeze({
    bg: '#15202b',
    fg: '#f7f9f9',
    fg2: '#8b98a5',
    line: '#38444d',
    outline: '#536471',
    hover: '#1e2732',
    accent: '#1d9bf0',
    accentBg: 'rgba(29,155,240,.12)',
    good: '#00ba7c',
    goodBg: 'rgba(0,186,124,.14)',
    ok: '#ffd400',
    weak: '#f4212e',
    weakBg: 'rgba(244,33,46,.12)',
    shadow: '0 0 15px rgba(255,255,255,.2), 0 0 3px 1px rgba(255,255,255,.15)',
    goodText: '#00ba7c',
    weakText: '#ff5a5f',
    fg2Hover: '#8b98a5',
  }),
  'lights-out': Object.freeze({
    bg: '#000000',
    fg: '#e7e9ea',
    fg2: '#71767b',
    line: '#2f3336',
    outline: '#536471',
    hover: '#16181c',
    accent: '#1d9bf0',
    accentBg: 'rgba(29,155,240,.12)',
    good: '#00ba7c',
    goodBg: 'rgba(0,186,124,.14)',
    ok: '#ffd400',
    weak: '#f4212e',
    weakBg: 'rgba(244,33,46,.12)',
    shadow: '0 0 15px rgba(255,255,255,.2), 0 0 3px 1px rgba(255,255,255,.15)',
    goodText: '#00ba7c',
    weakText: '#f4212e',
    fg2Hover: '#80858a',
  }),
});

/** The token custom property name for a ThemeTokens key. */
const TOKEN_VAR: Record<keyof ThemeTokens, string> = {
  bg: '--bg',
  fg: '--fg',
  fg2: '--fg2',
  line: '--line',
  outline: '--outline',
  hover: '--hover',
  accent: '--accent',
  accentBg: '--accent-bg',
  good: '--good',
  goodBg: '--good-bg',
  ok: '--ok',
  weak: '--weak',
  weakBg: '--weak-bg',
  shadow: '--shadow',
  goodText: '--good-text',
  weakText: '--weak-text',
  fg2Hover: '--fg2-hover',
};

function declarations(theme: ThemeTokens): string {
  return (Object.keys(TOKEN_VAR) as (keyof ThemeTokens)[])
    .map((key) => `${TOKEN_VAR[key]}:${theme[key]}`)
    .join(';');
}

/**
 * The ONE shared token STYLE block. Light values sit on plain `:host` (the fallback theme);
 * dim/lights-out apply via the `data-theme` attribute the ThemeDetector stamps on each host.
 */
export const THEME_TOKENS_CSS = `
:host { ${declarations(THEME_TOKENS.light)} }
:host([data-theme='dim']) { ${declarations(THEME_TOKENS.dim)} }
:host([data-theme='lights-out']) { ${declarations(THEME_TOKENS['lights-out'])} }
`;
