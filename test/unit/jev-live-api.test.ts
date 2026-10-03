// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeDraft } from '../helpers/draft';
import { createJevClient } from '@/core/jev-client';

/**
 * THE one live-API test per feature (extension-worker skill): gated on JEV_API_KEY from repo
 * `.env.local`. When the key is absent the suite is skipped with an explicit visible warning —
 * never silently. The key value is read into memory only, passed to the client, and never
 * printed, logged, or embedded in an assertion message (results never carry it by design, and a
 * unit test pins that).
 *
 * Runs in the node environment: the live exchange needs the real WHATWG fetch semantics the
 * shared transport relies on (full-response abort, streamed body); happy-dom's fetch is a
 * DOM-sandbox implementation, not a network client.
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
  // Visible in the run output whenever the live leg is skipped — required by the contract.
  console.warn(
    '[jev-live-api] JEV_API_KEY not found in .env.local — SKIPPING the live Jev API smoke test. ' +
      '(This is expected in environments without the mission secrets; all mocked-transport tests still run.)',
  );
}

describe.skipIf(!liveApiKey)('live Jev API smoke (real api.typesafe.ai exchange)', () => {
  it(
    'analyzes a real draft through the verified contract and reuses the cached verdict without a second call',
    { timeout: 30_000 },
    async () => {
      if (!liveApiKey) throw new Error('unreachable: gated by describe.skipIf');
      const client = createJevClient();
      const draft = makeDraft();

      // ONE real exchange (fresh), then the identical draft served from cache (no second call).
      const first = await client.analyzeDraft({ apiKey: liveApiKey, draft });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error('live analysis failed');
      expect(first.source).toBe('fresh');
      expect(first.latencyMs).toBeGreaterThanOrEqual(0);
      expect(first.verdict.ordinal).toBeGreaterThanOrEqual(0);
      expect(first.verdict.ordinal).toBeLessThanOrEqual(5);
      expect(first.verdict.confidence).toBeGreaterThanOrEqual(0);
      expect(first.verdict.confidence).toBeLessThanOrEqual(1);
      expect([
        'weak',
        'below-average',
        'moderate',
        'strong',
        'exceptional',
      ]).toContain(first.verdict.band);
      expect(first.verdict.weaknesses.length).toBeGreaterThan(0);

      const second = await client.analyzeDraft({
        apiKey: liveApiKey,
        draft: { ...draft, capturedAt: draft.capturedAt + 60_000 }, // identical content, later capture
      });
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error('cached analysis failed');
      expect(second.source).toBe('cache');
      expect(second.verdict).toEqual(first.verdict);
    },
  );
});
