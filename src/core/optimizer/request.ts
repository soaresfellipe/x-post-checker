/**
 * Pure request mapping for the optimizer: DraftSnapshot -> ONE verified systemone request whose
 * `state` carries the original draft plus every rewrite, and whose `questions` ask one verified
 * `noul` (yes/no probability) question per rewrite (head-to-head vs the original opening) and
 * one per hashtag candidate (topicality). No network, no storage, no DOM.
 */
import type { DraftSnapshot } from '@/core/draft-snapshot';
import { JEV_MODEL_ALIAS } from '@/core/jev-client/connection-test';
import { OPTIMIZER_HASHTAG_CANDIDATES, VARIANT_LABELS } from './config';
import { generateHashtagCandidates, type HashtagCandidate } from './hashtags';
import { generateHookVariants, type GeneratedVariant } from './variants';

export interface JevNoulQuestion {
  readonly type: 'noul';
  readonly instructions: string;
  readonly criteria: { true: string; false: string };
}

export interface OptimizerRequestBody {
  readonly model: typeof JEV_MODEL_ALIAS;
  readonly state: string;
  readonly questions: Record<string, JevNoulQuestion>;
}

/** Everything the exchange and its parser need: the wire body plus the ids it expects back. */
export interface OptimizerPipeline {
  readonly request: OptimizerRequestBody;
  readonly variants: readonly GeneratedVariant[];
  readonly variantIds: readonly string[];
  readonly candidates: readonly HashtagCandidate[];
  readonly hashtagIds: readonly string[];
}

function rewriteLabel(index: number, variant: GeneratedVariant): string {
  return `Rewrite ${String.fromCharCode(65 + index)} (${VARIANT_LABELS[variant.kind]})`;
}

/**
 * The `state` is the decision situation: the original draft first, then the context the text
 * alone cannot reveal (reply context, media, current hashtags), then every rewrite labeled.
 * Deterministic — identical drafts produce byte-identical states, which the cache identity
 * depends on.
 */
export function buildOptimizerState(draft: DraftSnapshot, variants: readonly GeneratedVariant[]): string {
  const context: string[] = [];
  context.push(
    draft.isReply
      ? draft.replyToHandle
        ? `This is a reply to @${draft.replyToHandle}.`
        : 'This is a reply to another post.'
      : 'This is an original post.',
  );
  if (draft.hasMedia) context.push('An image or video is attached to the post.');
  if (draft.hashtags.length > 0) {
    context.push(`The draft already uses these hashtags: ${draft.hashtags.map((tag) => `#${tag}`).join(', ')}.`);
  }

  const lines: string[] = ['Original draft:', draft.text, '', 'Context:', ...context.map((line) => `- ${line}`)];
  for (const [index, variant] of variants.entries()) {
    lines.push('', `${rewriteLabel(index, variant)}:`, variant.text);
  }
  return lines.join('\n');
}

const VARIANT_QUESTION_CRITERIA: JevNoulQuestion['criteria'] = {
  true: 'The rewrite opens with a hook likely to earn more attention than the original opening.',
  false: 'The original opening is at least as strong as the rewrite.',
};

function variantQuestion(label: string): JevNoulQuestion {
  return {
    type: 'noul',
    instructions:
      `For an English-language X audience, would ${label} likely earn more attention with its ` +
      'opening than the Original draft does? Judge only the opening lines. This is a heuristic ' +
      'judgment, not a guaranteed prediction.',
    criteria: VARIANT_QUESTION_CRITERIA,
  };
}

function hashtagQuestion(tag: string): JevNoulQuestion {
  return {
    type: 'noul',
    instructions:
      `Is the hashtag #${tag} directly relevant to the subject of the Original draft? Judge only ` +
      'topical match, not reach or popularity.',
    criteria: {
      true: 'The hashtag names a topic the draft is substantially about.',
      false: 'The hashtag is off-topic or only loosely related.',
    },
  };
}

/** Builds the full pipeline: wire request + the variants/candidates the answers map back to. */
export function buildOptimizerPipeline(draft: DraftSnapshot): OptimizerPipeline {
  const variants = generateHookVariants(draft.text);
  const candidates = generateHashtagCandidates(draft, OPTIMIZER_HASHTAG_CANDIDATES);

  const questions: Record<string, JevNoulQuestion> = {};
  const variantIds: string[] = [];
  for (const [index, variant] of variants.entries()) {
    const id = `variant_${variant.id}`;
    questions[id] = variantQuestion(rewriteLabel(index, variant));
    variantIds.push(id);
  }
  const hashtagIds: string[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const id = `hashtag_${index}`;
    questions[id] = hashtagQuestion(candidate.tag);
    hashtagIds.push(id);
  }

  return {
    request: { model: JEV_MODEL_ALIAS, state: buildOptimizerState(draft, variants), questions },
    variants,
    variantIds,
    candidates,
    hashtagIds,
  };
}
