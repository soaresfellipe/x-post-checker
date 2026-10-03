/**
 * Hook-variant generation: deterministic structural rewrites of the draft's OWN words. Jev cannot
 * write text (it returns typed judgments, never prose), so the variants come from meaning-
 * preserving templates — framing leads, a stat echo, and a conclusion-first reorder — and Jev's
 * verified `noul` questions rank which rewrites out-earn the original opening (VAL-OPT-003).
 * No synonym swaps, no punctuation-only edits: every kind changes the opening's structure.
 */
import type { HookKind } from './types';

export interface GeneratedVariant {
  readonly id: HookKind;
  readonly kind: HookKind;
  readonly text: string;
}

interface Sentence {
  readonly core: string;
  readonly terminator: string;
}

/** Splits on ., !, ? followed by whitespace/end — decimals ("3.5") never split. */
function splitSentences(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  let start = 0;
  for (const match of text.matchAll(/([.!?]+)(?:\s+|$)/g)) {
    const core = text.slice(start, match.index).trim();
    if (core) sentences.push({ core, terminator: match[1]! });
    start = (match.index ?? 0) + match[0].length;
  }
  const tail = text.slice(start).trim();
  if (tail) sentences.push({ core: tail, terminator: '' });
  return sentences;
}

function joinSentences(parts: readonly string[]): string {
  return parts.filter(Boolean).join(' ');
}

export function generateHookVariants(text: string): GeneratedVariant[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const sentences = splitSentences(trimmed);
  const first = sentences[0]!;
  const restText = sentences
    .slice(1)
    .map((sentence) => sentence.core + sentence.terminator)
    .join(' ');
  const variants: GeneratedVariant[] = [];

  // Question hook — "What happened when I spent 30 days…?" reuses the draft verbatim; drafts that
  // do not open with "I" get a relatable question lead in front of the untouched draft.
  if (!first.terminator.includes('?')) {
    if (first.core.startsWith('I ')) {
      variants.push({
        id: 'question',
        kind: 'question',
        text: joinSentences([`What happened when ${first.core}?`, restText]),
      });
    } else {
      variants.push({
        id: 'question',
        kind: 'question',
        text: joinSentences(['Does this sound familiar?', `${first.core}${first.terminator}`, restText]),
      });
    }
  }

  // Number lead — a stat echo: the draft's first number phrase leads, the draft follows whole.
  const numberMatch = /\b\w*\d\w*(?:\s+\p{L}+)?/u.exec(trimmed);
  if (numberMatch && (numberMatch.index ?? 0) > 0) {
    variants.push({ id: 'number', kind: 'number', text: `${numberMatch[0]}. ${trimmed}` });
  }

  // Story teaser — a narrative framing lead in front of the untouched draft.
  if (!/^here's what happened/i.test(trimmed)) {
    variants.push({ id: 'story', kind: 'story', text: `Here's what happened: ${trimmed}` });
  }

  // Claim first — the concluding sentence moves to the front (pure reorder, needs two sentences).
  if (sentences.length >= 2) {
    const last = sentences[sentences.length - 1]!;
    const head = sentences
      .slice(0, -1)
      .map((sentence) => sentence.core + sentence.terminator)
      .join(' ');
    variants.push({ id: 'claim', kind: 'claim', text: joinSentences([last.core + last.terminator, head]) });
  }

  // At least one variant always applies (VAL-OPT-002): the story lead fits any draft.
  if (variants.length === 0) {
    variants.push({ id: 'story', kind: 'story', text: `Here's what happened: ${trimmed}` });
  }
  return variants;
}
