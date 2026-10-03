/**
 * Pure response parsing for the optimizer: the verified systemone reply's `noul` answers ->
 * ranked variants and ranked hashtag suggestions. Strict on everything the result depends on
 * (every expected id present, `type: 'noul'`, probability a finite 0..1), so a malformed answer
 * surfaces as a typed parse failure instead of a fabricated ranking.
 */
import { suggestionRationale } from './hashtags';
import type { HookKind } from './types';
import type { OptimizerPipeline } from './request';

export interface RankedVariant {
  readonly id: HookKind;
  readonly kind: HookKind;
  readonly text: string;
  readonly probability: number;
}

export interface RankedHashtag {
  readonly tag: string;
  readonly rationale: string;
  readonly probability: number;
}

export type ParseOptimizeResult =
  | { ok: true; variants: RankedVariant[]; hashtags: RankedHashtag[] }
  | { ok: false; reason: string };

function parseNoulProbability(answer: unknown): number | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined;
  const record = answer as Record<string, unknown>;
  if (record.type !== 'noul') return undefined;
  const probability = record.noul;
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    return undefined;
  }
  return probability;
}

export function parseOptimizeResponse(data: unknown, pipeline: OptimizerPipeline): ParseOptimizeResult {
  if (typeof data !== 'object' || data === null) return { ok: false, reason: 'response is not an object' };
  const answers = (data as { answers?: unknown }).answers;
  if (typeof answers !== 'object' || answers === null) return { ok: false, reason: 'missing answers object' };
  const answerMap = answers as Record<string, unknown>;

  const variants: RankedVariant[] = [];
  for (const variant of pipeline.variants) {
    const id = `variant_${variant.id}`;
    const probability = parseNoulProbability(answerMap[id]);
    if (probability === undefined) return { ok: false, reason: `invalid or missing noul answer for ${id}` };
    variants.push({ id: variant.id, kind: variant.kind, text: variant.text, probability });
  }

  const hashtags: RankedHashtag[] = [];
  for (const [index, candidate] of pipeline.candidates.entries()) {
    const id = pipeline.hashtagIds[index]!;
    const probability = parseNoulProbability(answerMap[id]);
    if (probability === undefined) return { ok: false, reason: `invalid or missing noul answer for ${id}` };
    hashtags.push({ tag: candidate.tag, rationale: suggestionRationale(candidate.term), probability });
  }

  // Best-first; Array#sort is stable, so probability ties keep generation order (deterministic
  // presentation — the E2E fixtures depend on it).
  variants.sort((a, b) => b.probability - a.probability);
  hashtags.sort((a, b) => b.probability - a.probability);
  return { ok: true, variants, hashtags };
}
