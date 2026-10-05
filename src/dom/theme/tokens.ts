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
