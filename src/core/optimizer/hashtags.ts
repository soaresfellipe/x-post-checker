/**
 * Hashtag suggestion logic (VAL-OPT-006). Jev cannot invent tags, so candidates are the draft's
 * own salient words (topicality is inherent: each rationale names the exact draft term); Jev's
 * verified `noul` questions rank them. When the draft already carries excess hashtags, the drop
 * advice names which to drop and never keeps more than three.
 */
import type { DraftSnapshot } from '@/core/draft-snapshot';
import type { HashtagSuggestion } from './types';
import { OPTIMIZER_MAX_HASHTAG_SUGGESTIONS, OPTIMIZER_HASHTAG_CANDIDATES } from './config';

export interface HashtagCandidate {
  /** Display form, capitalized: `System`. */
  readonly tag: string;
  /** The lowercase draft word this candidate came from (the rationale names it). */
  readonly term: string;
}

/** Compact English stopword set — words that make no sense as hashtags. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'with', 'that', 'this', 'these', 'those', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'to', 'of', 'in', 'on', 'at', 'by', 'it', 'its', 'itself', 'as', 'from',
  'about', 'into', 'over', 'after', 'i', "i'm", 'ive', 'my', 'me', 'we', 'our', 'you', 'your', 'they',
  'their', 'he', 'she', 'his', 'her', 'them', 'us', 'do', 'does', 'did', 'done', 'doing', 'have', 'has',
  'had', 'having', 'not', 'no', 'so', 'if', 'then', 'than', 'too', 'very', 'can', 'will', 'just', "don't",
  'dont', 'now', 'what', 'when', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other',
  'some', 'such', 'only', 'own', 'same', 'one', 'two', 'three', 'get', 'got', 'use', 'using', 'make', 'made',
]);

const WORD_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}']*/gu;

/**
 * Candidates from the draft's salient words: most frequent first, then longer words, then first
 * appearance. Words already used as the draft's hashtags are never suggested again.
 */
export function generateHashtagCandidates(
  snapshot: Pick<DraftSnapshot, 'text' | 'hashtags'>,
  max: number = OPTIMIZER_HASHTAG_CANDIDATES,
): HashtagCandidate[] {
  const existing = new Set(snapshot.hashtags.map((tag) => tag.toLowerCase()));
  const frequency = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  for (const match of snapshot.text.matchAll(WORD_PATTERN)) {
    const word = match[0].toLowerCase();
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    if (!frequency.has(word)) firstSeen.set(word, firstSeen.size);
    frequency.set(word, (frequency.get(word) ?? 0) + 1);
  }
  return [...frequency.keys()]
    .filter((word) => !existing.has(word))
    .sort(
      (a, b) =>
        (frequency.get(b) ?? 0) - (frequency.get(a) ?? 0) ||
        b.length - a.length ||
        (firstSeen.get(a) ?? 0) - (firstSeen.get(b) ?? 0),
    )
    .slice(0, max)
    .map((term) => ({ tag: term.charAt(0).toUpperCase() + term.slice(1), term }));
}

/** The one-line rationale shown with every suggestion: it names the draft term it came from. */
export function suggestionRationale(term: string): string {
  return `Comes straight from your draft ("${term}").`;
}

function tagList(tags: readonly string[]): string {
  return tags.map((tag) => `#${tag}`).join(', ');
}

/**
 * Drop advice for drafts with excess hashtags: keep up to three topical ones (their words appear
 * in the draft text, or Jev ranked them in), name the rest as drops. Undefined at three or fewer.
 */
export function buildDropAdvice(
  snapshot: Pick<DraftSnapshot, 'text' | 'hashtags'>,
  suggestions: ReadonlyArray<Pick<HashtagSuggestion, 'tag'>> = [],
): string | undefined {
  const tags = snapshot.hashtags;
  if (tags.length <= OPTIMIZER_MAX_HASHTAG_SUGGESTIONS) return undefined;

  const suggested = new Set(suggestions.map((suggestion) => suggestion.tag.toLowerCase()));
  const textLower = snapshot.text.toLowerCase();
  const topical = (tag: string): boolean => {
    const lower = tag.toLowerCase();
    return suggested.has(lower) || textLower.includes(lower);
  };

  const keep = tags.filter(topical).slice(0, OPTIMIZER_MAX_HASHTAG_SUGGESTIONS);
  const drop = tags.filter((tag) => !keep.includes(tag));
  const keepClause = keep.length > 0 ? ` Keep ${tagList(keep)}.` : '';
  return `You use ${tags.length} hashtags.${keepClause} Drop ${tagList(drop)} - three or fewer keeps a post readable.`;
}
