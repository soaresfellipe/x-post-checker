/**
 * The VERIFIED live Jev exchange from research/readiness/dependency-readiness.md (2026-10-02,
 * HTTP 200, median ~238 ms). Response stubs in unit/E2E tests reuse it so parsing is pinned to
 * the real wire format, and the live-API smoke test compares against the same shapes.
 */
export const VERIFIED_JEV_RESPONSE = {
  model: 'jev-1.13.0',
  answers: {
    viral_potential: {
      type: 'score',
      score: 3.44,
      confidence: 0.65,
      legend: {
        '0': 'Very low: generic or unclear, with no audience value or reason to engage.',
        '1': 'Low: limited audience interest; the idea or presentation is mostly generic.',
        '2': 'Below average: some useful value, but the hook or share trigger is weak.',
        '3': 'Moderate: clear value for a defined audience and a plausible reason to engage.',
        '4': 'High: memorable or useful, with a strong reason to reply, save, or share.',
        '5': 'Very high: unusually distinctive and compelling, with multiple strong reasons to engage and share.',
      },
      probabilities: { '0': 0.0, '1': 0.0, '2': 0.04, '3': 0.48, '4': 0.48, '5': 0.0 },
    },
    main_weakness: {
      type: 'choice',
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
  usage: { input_tokens: 630, output_tokens: 92 },
} as const;

/** A `Response` carrying the verified reply, for mocked transports. */
export function jevOkResponse(): Response {
  return new Response(JSON.stringify(VERIFIED_JEV_RESPONSE), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
