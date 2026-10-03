/**
 * Test-only build seams for the e2e/smoke test builds (`wxt build --mode e2e`). Every consumer
 * gates its behavior on `isE2EBuild()`, so release builds (mode `production`) never activate any
 * of this — the shipped extension is byte-for-byte free of test behavior.
 *
 * The seams exist because the Firefox smoke harness cannot use Playwright-style route
 * interception: the Firefox MV3 background is an event page, which no test driver can reach.
 * The harness instead seeds `storage.local` (through the content-script seed listener) with a
 * Jev endpoint override pointing at a fixture-hosted mock; the background applies it via
 * `setJevEndpointOverrideForTests`. Chromium E2E keeps using `context.route()` — the same seam
 * is simply unused there.
 */

/** WXT build mode that carries the test-only behavior (scripts/build-variants.ts TEST_MODE). */
const E2E_MODE = 'e2e';

/** True only in the e2e test build; release builds are always false. */
export function isE2EBuild(): boolean {
  return import.meta.env.MODE === E2E_MODE;
}

/**
 * `storage.local` key holding the test Jev endpoint override (a full URL). Written by the
 * content-script seed listener; read by the background, which applies it to the Jev transport.
 * The key name is shared by both sides through this module.
 */
export const JEV_ENDPOINT_OVERRIDE_STORAGE_KEY = 'amplifyxTestJevEndpoint';

/** The seed message type the fixture page posts; the e2e content script applies its payload. */
export const E2E_SEED_MESSAGE_TYPE = 'amplifyx:e2e-seed';
