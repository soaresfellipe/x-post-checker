import { describe, expect, it } from 'vitest';
import { isE2EBuild, JEV_ENDPOINT_OVERRIDE_STORAGE_KEY } from '@/core/test-hooks';
import { JEV_ENDPOINT, postJevJson, setJevEndpointOverrideForTests } from '@/core/jev-client/transport';

/**
 * The endpoint override is the Firefox smoke harness's only deterministic Jev control surface
 * (event-page backgrounds cannot be reached by Playwright-style route interception). The safety
 * property that matters: in ANY build whose mode is not the e2e test mode — including every
 * release build — the override is inert and the verified endpoint is used (VAL-SETUP-020's
 * release packages must never be redirectable).
 */
describe('Jev endpoint override (test-only seam)', () => {
  it('is disabled outside the e2e build mode (release-build safety)', () => {
    // Vitest runs with MODE !== 'e2e', so the seam must be inert in this environment.
    expect(isE2EBuild()).toBe(false);
  });

  it('ignores an override attempt outside the e2e build mode and keeps the verified endpoint', async () => {
    setJevEndpointOverrideForTests('http://localhost:3177/__mock/jev');
    const urls: string[] = [];
    await postJevJson({
      apiKey: 'synthetic-key',
      body: { model: 'jev-latest', state: 'x' },
      timeoutMs: 1_000,
      fetchImpl: async (url) => {
        urls.push(url);
        return new Response('{}', { status: 200 });
      },
    });
    expect(urls).toEqual([JEV_ENDPOINT]);
  });

  it('exports the storage key the e2e seed and the background agree on', () => {
    expect(JEV_ENDPOINT_OVERRIDE_STORAGE_KEY).toBe('amplifyxTestJevEndpoint');
  });
});
