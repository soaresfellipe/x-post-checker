/**
 * Pure response parsing: the verified systemone reply -> typed answers -> the JevVerdict the
 * overlay renders. Strict on everything the verdict depends on (score, confidence, choice), so a
 * malformed answer surfaces as a typed failure instead of a fabricated score.
 */
import { toJevVerdict, type JevVerdict } from '@/core/heuristic-engine';
import {
  MAIN_WEAKNESS_QUESTION,
  MAIN_WEAKNESS_QUESTION_ID,
  VIRAL_ORDINAL_MAX,
  VIRAL_POTENTIAL_QUESTION_ID,
  WEAKNESS_LABELS,
  type MainWeaknessId,
} from './config';

export interface ParsedScoreAnswer {
  readonly ordinal: number;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

export interface ParsedChoiceAnswer {
  readonly choice: MainWeaknessId;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

export interface ParsedDraftAnalysis {
  readonly viralPotential: ParsedScoreAnswer;
  readonly mainWeakness: ParsedChoiceAnswer;
}

export type ParseDraftAnalysisResult =
  | { ok: true; answers: ParsedDraftAnalysis }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Probabilities are optional (lenient when absent, strict when present). */
function parseProbabilities(value: unknown): Record<string, number> | undefined {
  if (value === undefined) return {};
  if (!isRecord(value)) return undefined;
  const probabilities: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    const probability = finiteNumber(entry);
    if (probability === undefined) return undefined;
    probabilities[key] = probability;
  }
  return probabilities;
}

function parseConfidence(value: unknown): number | undefined {
  const confidence = finiteNumber(value);
  return confidence === undefined || confidence < 0 || confidence > 1 ? undefined : confidence;
}

export function parseDraftAnalysisResponse(data: unknown): ParseDraftAnalysisResult {
  if (!isRecord(data) || !isRecord(data.answers)) return { ok: false, reason: 'missing answers object' };

  const score = data.answers[VIRAL_POTENTIAL_QUESTION_ID];
  if (!isRecord(score)) return { ok: false, reason: 'missing viral_potential answer' };
  if (score.type !== 'score') return { ok: false, reason: 'viral_potential answer is not a score answer' };
  const ordinal = finiteNumber(score.score);
  if (ordinal === undefined || ordinal < 0 || ordinal > VIRAL_ORDINAL_MAX) {
    return { ok: false, reason: 'viral_potential score is not an ordinal in range' };
  }
  const scoreConfidence = parseConfidence(score.confidence);
  if (scoreConfidence === undefined) return { ok: false, reason: 'viral_potential confidence is missing or invalid' };
  const scoreProbabilities = parseProbabilities(score.probabilities);
  if (scoreProbabilities === undefined) return { ok: false, reason: 'viral_potential probabilities are malformed' };

  const choice = data.answers[MAIN_WEAKNESS_QUESTION_ID];
  if (!isRecord(choice)) return { ok: false, reason: 'missing main_weakness answer' };
  if (choice.type !== 'choice') return { ok: false, reason: 'main_weakness answer is not a choice answer' };
  const chosen =
    // Prototype-safe membership: `in` would admit inherited Object.prototype names ("toString",
    // "constructor"), which are not rubric options — they must degrade to the typed malformed
    // failure, never reach the verdict (VAL-DRAFT-016).
    typeof choice.choice === 'string' && Object.hasOwn(MAIN_WEAKNESS_QUESTION.criteria, choice.choice)
      ? (choice.choice as MainWeaknessId)
      : undefined;
  if (chosen === undefined) return { ok: false, reason: 'main_weakness choice is not one of the rubric options' };
  const choiceConfidence = parseConfidence(choice.confidence);
  if (choiceConfidence === undefined) return { ok: false, reason: 'main_weakness confidence is missing or invalid' };
  const choiceProbabilities = parseProbabilities(choice.probabilities);
  if (choiceProbabilities === undefined) return { ok: false, reason: 'main_weakness probabilities are malformed' };

  return {
    ok: true,
    answers: {
      viralPotential: { ordinal, confidence: scoreConfidence, probabilities: scoreProbabilities },
      mainWeakness: { choice: chosen, confidence: choiceConfidence, probabilities: choiceProbabilities },
    },
  };
}

/** The typed verdict for the overlay: band derived from the ordinal, weakness from the choice. */
export function buildDraftJevVerdict(answers: ParsedDraftAnalysis): JevVerdict {
  return toJevVerdict({
    ordinal: answers.viralPotential.ordinal,
    confidence: answers.viralPotential.confidence,
    weaknesses: [WEAKNESS_LABELS[answers.mainWeakness.choice]],
  });
}
