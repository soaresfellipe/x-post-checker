/**
 * VAL-THEME-003 as a pure invariant: every TEXT color the extension surfaces render meets
 * >= 4.5:1 WCAG contrast on its actual background in ALL THREE X themes, and yellow (--ok) is
 * never a text color (dot only — design-1b §10).
 *
 * The Design 1b token table's --good/--weak (and --fg2 on the --hover surface) FAIL 4.5:1 in
 * some themes (e.g. #00ba7c on the 14% green tint over white is ~2.2:1), so text uses the
 * dedicated per-theme *text* tokens (`--good-text`, `--weak-text`, `--fg2-hover`) derived in
 * `src/dom/theme/tokens.ts` — same hue family, accessible in every theme. The tint backgrounds
 * and the non-text uses (dots, solid hover inversions with white text) stay exactly as spec'd.
 */
import { describe, expect, it } from 'vitest';
import { THEME_TOKENS, type ThemeTokens, type XTheme } from '../../src/dom/theme/tokens';

const THEMES: XTheme[] = ['light', 'dim', 'lights-out'];

/** Parses `#rgbhex` or `rgb()/rgba()` into [r, g, b, a]. */
function parse(color: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const parts = color.replace(/[^0-9.,]/g, '').split(',').map(Number);
  const [r = 0, g = 0, b = 0, a = 1] = parts as [number, number, number, number?];
  return [r, g, b, a === undefined ? 1 : a];
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb: readonly number[]): number {
  return 0.2126 * srgbToLinear(rgb[0]!) + 0.7152 * srgbToLinear(rgb[1]!) + 0.0722 * srgbToLinear(rgb[2]!);
}

/** WCAG 2.x contrast ratio between two RGB colors. */
function contrast(a: readonly number[], b: readonly number[]): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Blends an `rgba()` tint over an opaque base color (what the eye actually sees). */
function blendOver(tint: string, base: readonly number[]): number[] {
  const [r, g, b, a] = parse(tint);
  return [base[0]! * (1 - a) + r * a, base[1]! * (1 - a) + g * a, base[2]! * (1 - a) + b * a];
}

function tokens(theme: XTheme): ThemeTokens {
  return THEME_TOKENS[theme];
}

describe('VAL-THEME-003: text contrast >= 4.5:1 in all three themes', () => {
  it.each(THEMES)('%s: secondary text on the surface background', (theme) => {
    const t = tokens(theme);
    expect(contrast(parse(t.fg2), parse(t.bg))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(THEMES)('%s: good text on the good tint (and on the plain surface)', (theme) => {
    const t = tokens(theme);
    const bg = parse(t.bg);
    expect(contrast(parse(t.goodText), blendOver(t.goodBg, bg))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(parse(t.goodText), bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(THEMES)('%s: weak text on the weak tint (and on the plain surface)', (theme) => {
    const t = tokens(theme);
    const bg = parse(t.bg);
    expect(contrast(parse(t.weakText), blendOver(t.weakBg, bg))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(parse(t.weakText), bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(THEMES)('%s: muted text on the hover surface (neutral toggles, ok chips)', (theme) => {
    const t = tokens(theme);
    expect(contrast(parse(t.fg2Hover), parse(t.hover))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(THEMES)('%s: primary text on the surface background', (theme) => {
    const t = tokens(theme);
    expect(contrast(parse(t.fg), parse(t.bg))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('yellow is never a text color (design-1b §10)', () => {
  it('exposes the --ok dot color but no text-color token derived from it', () => {
    for (const theme of THEMES) {
      const t = tokens(theme);
      // The ok token IS yellow in the dark themes — and it must never appear as a *text* token.
      expect(t.ok).not.toBe(t.fg);
      expect(t.ok).not.toBe(t.fg2);
      expect(t.ok).not.toBe(t.goodText);
      expect(t.ok).not.toBe(t.weakText);
      expect(t.ok).not.toBe(t.fg2Hover);
    }
  });
});

describe('the a11y text tokens keep the design hue family', () => {
  it('good-text stays green, weak-text stays red in every theme', () => {
    for (const theme of THEMES) {
      const t = tokens(theme);
      const [gr, gg] = parse(t.goodText);
      const [wr, , wb] = parse(t.weakText);
      expect(gg!).toBeGreaterThan(gr!); // green channel dominates
      expect(wr!).toBeGreaterThan(wb!); // red channel dominates
    }
  });
});
