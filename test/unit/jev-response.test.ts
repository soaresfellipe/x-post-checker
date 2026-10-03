import { describe, expect, it } from 'vitest';
import { WEAKNESS_LABELS } from '@/core/jev-client';
import { buildDraftJevVerdict, parseDraftAnalysisResponse } from '@/core/jev-client/response';
import { VERIFIED_JEV_RESPONSE } from '../helpers/jev-fixtures';

/** Deep-clones the verified reply so mutations in one case cannot leak into another. */
function verifiedResponse(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(VERIFIED_JEV_RESPONSE)) as Record<string, unknown>;
}

/** Digs out one answer object for surgical corruption. */
function answer(id: string): Record<string, unknown> {
  const parsed = verifiedResponse();
  return (parsed.answers as Record<string, Record<string, unknown>>)[id]!;
}

describe('parseDraftAnalysisResponse (verified wire format)', () => {
  it('parses the verified response into typed answers: ordinal, confidence, probabilities, choice', () => {
    const result = parseDraftAnalysisResponse(verifiedResponse());
    expect(result).toEqual({
      ok: true,
      answers: {
        viralPotential: {
          ordinal: 3.44,
          confidence: 0.65,
          probabilities: { '0': 0.0, '1': 0.0, '2': 0.04, '3': 0.48, '4': 0.48, '5': 0.0 },
        },
        mainWeakness: {
          choice: 'not_specific_enough',
          confidence: 0.87,
          probabilities: {
            unclear_audience_value: 0.0,
            no_major_weakness: 0.03,
            weak_share_trigger: 0.06,
            not_specific_enough: 0.91,
            weak_hook: 0.0,
          },
        },
      },
    });
  });

  it('tolerates absent probabilities but validates them when present', () => {
    const withoutScoreProbabilities = verifiedResponse();
    delete (answer('viral_potential') as { probabilities?: unknown }).probabilities;
    const withoutChoiceProbabilities = verifiedResponse();
    delete (answer('main_weakness') as { probabilities?: unknown }).probabilities;

    expect(parseDraftAnalysisResponse(withoutScoreProbabilities)).toMatchObject({
      ok: true,
      answers: { viralPotential: { probabilities: {} } },
    });
    expect(parseDraftAnalysisResponse(withoutChoiceProbabilities)).toMatchObject({
      ok: true,
      answers: { mainWeakness: { probabilities: {} } },
    });

    const corrupt = answer('viral_potential');
    corrupt.probabilities = { '3': 'most likely' };
    expect(parseDraftAnalysisResponse(verifiedResponseFrom(corrupt, 'viral_potential')).ok).toBe(false);
  });

  it('rejects a missing or non-object answers map', () => {
    expect(parseDraftAnalysisResponse(null).ok).toBe(false);
    expect(parseDraftAnalysisResponse('nope').ok).toBe(false);
    expect(parseDraftAnalysisResponse({}).ok).toBe(false);
    expect(parseDraftAnalysisResponse({ answers: null }).ok).toBe(false);
  });

  it('rejects a missing score answer', () => {
    const data = verifiedResponse();
    delete (data.answers as Record<string, unknown>).viral_potential;
    expect(parseDraftAnalysisResponse(data).ok).toBe(false);
  });

  it('rejects a missing choice answer', () => {
    const data = verifiedResponse();
    delete (data.answers as Record<string, unknown>).main_weakness;
    expect(parseDraftAnalysisResponse(data).ok).toBe(false);
  });

  it('rejects a score answer with the wrong question type', () => {
    const corrupt = answer('viral_potential');
    corrupt.type = 'choice';
    expect(parseDraftAnalysisResponse(verifiedResponseFrom(corrupt, 'viral_potential')).ok).toBe(false);
  });

  it('rejects a non-numeric or out-of-range ordinal', () => {
    for (const score of ['high', null, 5.5, -0.5]) {
      const corrupt = answer('viral_potential');
      corrupt.score = score;
      expect(parseDraftAnalysisResponse(verifiedResponseFrom(corrupt, 'viral_potential')).ok).toBe(false);
    }
  });

  it('rejects a missing or out-of-range score confidence', () => {
    for (const confidence of [undefined, 1.2, -0.1, 'unsure']) {
      const corrupt = answer('viral_potential');
      if (confidence === undefined) delete corrupt.confidence;
      else corrupt.confidence = confidence;
      expect(parseDraftAnalysisResponse(verifiedResponseFrom(corrupt, 'viral_potential')).ok).toBe(false);
    }
  });

  it('rejects a choice answer that is not one of the rubric options', () => {
    for (const choice of ['made_up_option', '', null]) {
      const corrupt = answer('main_weakness');
      corrupt.choice = choice;
      expect(parseDraftAnalysisResponse(verifiedResponseFrom(corrupt, 'main_weakness')).ok).toBe(false);
    }
  });

  it('rejects a choice inherited from Object.prototype with the typed malformed reason (never a fabricated verdict)', () => {
    for (const choice of ['toString', 'constructor', 'hasOwnProperty']) {
      const corrupt = answer('main_weakness');
      corrupt.choice = choice;
      const parsed = parseDraftAnalysisResponse(verifiedResponseFrom(corrupt, 'main_weakness'));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toBe('main_weakness choice is not one of the rubric options');
    }
  });

  it('rejects a choice answer with the wrong question type or a missing confidence', () => {
    const wrongType = answer('main_weakness');
    wrongType.type = 'score';
    expect(parseDraftAnalysisResponse(verifiedResponseFrom(wrongType, 'main_weakness')).ok).toBe(false);

    const noConfidence = answer('main_weakness');
    delete noConfidence.confidence;
    expect(parseDraftAnalysisResponse(verifiedResponseFrom(noConfidence, 'main_weakness')).ok).toBe(false);
  });
});

describe('buildDraftJevVerdict (typed JevVerdict)', () => {
  it('derives the band from the ordinal and maps the weakness choice to a readable label', () => {
    const parsed = parseDraftAnalysisResponse(verifiedResponse());
    if (!parsed.ok) throw new Error('verified response must parse');
    const verdict = buildDraftJevVerdict(parsed.answers);

    expect(verdict.ordinal).toBe(3.44);
    expect(verdict.confidence).toBe(0.65);
    expect(verdict.band).toBe('moderate'); // 3.44 ∈ [2.5, 3.5)
    expect(verdict.weaknesses).toEqual([WEAKNESS_LABELS.not_specific_enough]);
    expect(verdict.strengths).toEqual([]);
    expect(verdict.suggestions).toEqual([]);
  });

  it('maps boundary ordinals through the approved band table', () => {
    const at = (ordinal: number) => {
      const data = verifiedResponse();
      ((data.answers as Record<string, Record<string, unknown>>).viral_potential!).score = ordinal;
      const parsed = parseDraftAnalysisResponse(data);
      if (!parsed.ok) throw new Error('boundary ordinal must parse');
      return buildDraftJevVerdict(parsed.answers).band;
    };
    expect(at(0)).toBe('weak');
    expect(at(1.49)).toBe('weak');
    expect(at(1.5)).toBe('below-average');
    expect(at(2.5)).toBe('moderate');
    expect(at(3.5)).toBe('strong');
    expect(at(4.5)).toBe('exceptional');
    expect(at(5)).toBe('exceptional');
  });
});

/**
 * Rebuilds a verified response with `corrupt` substituted for the `viral_potential`/`main_weakness`
 * answer, so each malformed case differs from the verified wire format in exactly one place.
 */
function verifiedResponseFrom(corrupt: Record<string, unknown>, id: 'viral_potential' | 'main_weakness') {
  const data = verifiedResponse();
  (data.answers as Record<string, unknown>)[id] = corrupt;
  return data;
}
