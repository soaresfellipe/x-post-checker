/**
 * X's weighted character counting (VAL-OPT-007): plain characters count 1, the East Asian
 * double-width ranges count 2, and any URL counts a flat 23 (t.co wrapping) regardless of its
 * true length. The optimizer flags variants whose weighted length exceeds the 280-character
 * post limit instead of presenting them as ready to post.
 */

export const X_POST_LIMIT = 280;

/** Every URL counts this much on X, however long it really is. */
export const X_URL_WEIGHT = 23;

/** The double-width scripts X weights as two characters (Hangul, CJK, fullwidth forms). */
const DOUBLE_WEIGHT = /[\u1100-\u11FF\u2E80-\u312F\u3190-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFF00-\uFF60\uFFE0-\uFFE6]/;

/** The URL shapes the draft extractor recognizes (https?:// and www.). */
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

/** Trailing punctuation that belongs to the sentence, not the URL — same rule as extraction. */
const URL_TRAILING_PUNCTUATION = /[.,;:!?"'»›)\]}]+$/;

function plainWeight(segment: string): number {
  let weight = 0;
  for (const char of segment) weight += DOUBLE_WEIGHT.test(char) ? 2 : 1;
  return weight;
}

export function weightedLength(text: string): number {
  let total = 0;
  let lastIndex = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0];
    const urlStart = match.index ?? 0;
    const trimmed = url.replace(URL_TRAILING_PUNCTUATION, '');
    const trailing = url.length - trimmed.length;
    total += plainWeight(text.slice(lastIndex, urlStart)) + X_URL_WEIGHT + plainWeight(url.slice(url.length - trailing));
    lastIndex = urlStart + url.length;
  }
  return total + plainWeight(text.slice(lastIndex));
}

export function isOverXLimit(text: string): boolean {
  return weightedLength(text) > X_POST_LIMIT;
}
