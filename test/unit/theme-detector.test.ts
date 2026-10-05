/**
 * Unit tests for the pure X-theme mapping (m6-theme-foundation-and-realx-probe).
 *
 * The three known X body colors and the light fallback come from the Design 1b token table
 * (`library/design-1b.md` §2); the live representation (body background is an INLINE style) was
 * verified read-only on real x.com 2026-10-05 — `library/x-dom.md`, m6 insertion probe fact 4.
 */
import { describe, expect, it } from 'vitest';
import { mapBackgroundColor } from '../../src/dom/theme/theme-detector';

describe('mapBackgroundColor', () => {
  it('maps X light #ffffff to light', () => {
    expect(mapBackgroundColor('#ffffff')).toBe('light');
    expect(mapBackgroundColor('rgb(255, 255, 255)')).toBe('light');
  });

  it('maps X dim #15202b to dim', () => {
    expect(mapBackgroundColor('#15202b')).toBe('dim');
    expect(mapBackgroundColor('rgb(21, 32, 43)')).toBe('dim');
  });

  it('maps X lights-out #000000 to lights-out', () => {
    expect(mapBackgroundColor('#000000')).toBe('lights-out');
    expect(mapBackgroundColor('rgb(0, 0, 0)')).toBe('lights-out');
  });

  it('falls back to light for unknown backgrounds', () => {
    expect(mapBackgroundColor('rgb(18, 18, 18)')).toBe('light');
    expect(mapBackgroundColor('#0f1419')).toBe('light');
  });

  it('falls back to light for transparent and empty values', () => {
    expect(mapBackgroundColor('rgba(0, 0, 0, 0)')).toBe('light');
    expect(mapBackgroundColor('transparent')).toBe('light');
    expect(mapBackgroundColor('')).toBe('light');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(mapBackgroundColor('  RGB(21, 32, 43) ')).toBe('dim');
    expect(mapBackgroundColor('#15202B')).toBe('dim');
    expect(mapBackgroundColor('#FFFFFF')).toBe('light');
  });
});
