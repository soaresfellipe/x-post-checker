// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { postJevJson } from '@/core/jev-client/transport';

/**
 * THE one live-API test for the optimizer feature (extension-worker skill), gated on JEV_API_KEY
 * from repo `.env.local` — skipped with an explicit visible warning when absent, never silently.
 *
 * PURPOSE (m4-optimizer): the Jev `noul` question type (yes/no probability) is the PREFERRED
 * evaluation primitive for hook variants and hashtag topicality, but it had never been verified
 * live (library/jev-api.md: "documented but NOT verified"). The optimizer feature must verify it
 * against the live API BEFORE choosing the implementation; the approved fallback is score-ranked
 * self-generated variants evaluated via the verified `score` question.
 *
 * This test sends ONE real request exercising `noul` for both optimizer uses:
 *   1. a per-variant head-to-head judgment ("would this rewrite's hook out-earn the original's?");
 *   2. a hashtag-topicality judgment ("is this hashtag directly relevant to the draft's subject?");
 * and asserts the documented answer shape: `{type:'noul', noul:<0..1>}` — probability of yes,
 * no separate confidence (research/jev-typesafe/api-reference.md).
 *
 * The key is read into memory only and never printed, logged, or embedded in assertion messages.
 */

function loadLiveApiKey(): string | undefined {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (!existsSync(envPath)) return undefined;
  const match = readFileSync(envPath, 'utf8').match(/^JEV_API_KEY=(.*)$/m);
  const raw = match?.[1]?.trim().replace(/^["']|["']$/g, '');
  return raw && raw.length > 0 ? raw : undefined;
}

const liveApiKey = loadLiveApiKey();

if (!liveApiKey) {
  console.warn(
    '[optimizer-noul-live] JEV_API_KEY not found in .env.local — SKIPPING the live noul verification. ' +
      '(Expected only in environments without the mission secrets; mocked tests still run.)',
  );
}

const DRAFT =
  'I spent 30 days replacing my complicated productivity system with one daily checklist. I finish more work now.';
const VARIANT_A =
  'What happened when I spent 30 days replacing my complicated productivity system with one daily checklist? I finish more work now.';

/** The noul-verification request: one exchange, both optimizer question uses. */
function buildNoulVerificationRequest(): unknown {
  return {
    model: 'jev-latest',
    state: ['Original draft:', DRAFT, '', 'Rewrite A (question hook):', VARIANT_A].join('\n'),
    questions: {
      rewrite_a_beats_original: {
        type: 'noul',
        instructions:
          'For an English-language X audience, would Rewrite A (a question hook) likely earn more ' +
          'attention with its opening than the Original draft does? This is a heuristic judgment, ' +
          'not a guaranteed prediction.',
        criteria: {
          true: 'Rewrite A opens with a hook likely to earn more attention than the original.',
          false: 'The original opening is at least as strong as Rewrite A.',
        },
      },
      hashtag_productivity_relevant: {
        type: 'noul',
        instructions:
          'Is the hashtag #Productivity directly relevant to the subject of the Original draft? ' +
          'Judge only topical match, not reach.',
        criteria: {
          true: 'The hashtag names a topic the draft is substantially about.',
          false: 'The hashtag is off-topic or only loosely related.',
        },
      },
    },
  };
}

interface RawNoulAnswer {
  type?: unknown;
  noul?: unknown;
}

describe.skipIf(!liveApiKey)('live Jev API noul verification (optimizer primitive)', () => {
  it(
    'accepts noul questions for variant head-to-head and hashtag topicality and returns yes-probabilities',
    { timeout: 30_000 },
    async () => {
      if (!liveApiKey) throw new Error('unreachable: gated by describe.skipIf');

      const result = await postJevJson({
        apiKey: liveApiKey,
        body: buildNoulVerificationRequest(),
        timeoutMs: 10_000,
      });

      // The exchange must succeed: a 4xx here would mean the noul type is unusable and the
      // approved score-ranked fallback becomes the implementation (documented in the handoff).
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('live noul exchange failed');

      const answers = (result.data as { answers?: Record<string, RawNoulAnswer> }).answers ?? {};
      for (const questionId of ['rewrite_a_beats_original', 'hashtag_productivity_relevant']) {
        const answer = answers[questionId] as Record<string, unknown> | undefined;
        expect(answer, `missing answer for ${questionId}`).toBeTruthy();
        expect(answer?.type).toBe('noul');
        const probability = answer?.noul;
        expect(typeof probability).toBe('number');
        expect(probability as number).toBeGreaterThanOrEqual(0);
        expect(probability as number).toBeLessThanOrEqual(1);
      }
    },
  );
});
