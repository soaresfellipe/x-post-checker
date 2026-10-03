import { describe, expect, it } from 'vitest';
import { weightedLength, isOverXLimit, X_POST_LIMIT } from '@/core/optimizer/char-limit';

/**
 * X's weighted character counting (VAL-OPT-007): plain characters count 1, East Asian ranges
 * count 2, and any URL counts a flat 23 (t.co wrapping) regardless of its true length. The
 * optimizer uses this to flag variants that exceed the 280-character post limit.
 */
describe('X weighted character counting (VAL-OPT-007)', () => {
  it('counts plain ASCII as one weighted character each', () => {
    expect(weightedLength('hello world')).toBe(11);
  });

  it('counts any https URL as exactly 23 weighted characters regardless of its length', () => {
    expect(weightedLength('https://example.com/a-very-long-path-that-goes-on-and-on-and-on')).toBe(23);
    expect(weightedLength('https://x.com')).toBe(23);
  });

  it('counts www URLs as 23 weighted characters', () => {
    expect(weightedLength('www.example.com')).toBe(23);
  });

  it('counts a URL at the end without trailing space as 23 (trailing punctuation belongs to text)', () => {
    expect(weightedLength(`See https://example.com/long-path. Done`)).toBe(4 + 23 + 6);
  });

  it('counts East Asian characters as two weighted characters each', () => {
    expect(weightedLength('こんにちは')).toBe(10);
    expect(weightedLength('日本語のテキスト')).toBe(16);
    expect(weightedLength('한국어')).toBe(6);
    expect(weightedLength('产品')).toBe(4);
  });

  it('counts fullwidth punctuation as two weighted characters', () => {
    expect(weightedLength('！')).toBe(2);
  });

  it('mixes URL, ASCII and CJK segments additively', () => {
    expect(weightedLength('https://x.com こんにちは')).toBe(23 + 1 + 10);
  });

  it('counts every URL in a multi-URL draft as 23', () => {
    expect(weightedLength('https://a.co https://b.co')).toBe(23 + 1 + 23);
  });

  it(`the ${X_POST_LIMIT} limit boundary: exactly ${X_POST_LIMIT} weighted chars is not over, one more is`, () => {
    const base = 'a'.repeat(X_POST_LIMIT);
    expect(isOverXLimit(base)).toBe(false);
    expect(isOverXLimit(`${base}!`)).toBe(true);
  });

  it('a long URL inside a draft still counts 23, keeping the draft under the limit', () => {
    const draft = `Check this https://example.com/${'x'.repeat(200)} out`;
    expect(weightedLength(draft)).toBe('Check this '.length + 23 + ' out'.length);
    expect(isOverXLimit(draft)).toBe(false);
  });
});
