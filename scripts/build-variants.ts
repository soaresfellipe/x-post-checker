/** WXT mode used for the Playwright/test build; the only build allowed to match the local fixture. */
export const TEST_MODE = 'e2e';

export const FIXTURE_PORT = 3177;
export const TEST_FIXTURE_MATCH = `http://localhost:${FIXTURE_PORT}/*`;

export const REQUIRED_CONTENT_MATCHES = ['https://x.com/*', 'https://twitter.com/*'] as const;
export const REQUIRED_HOST_PERMISSION = 'https://api.typesafe.ai/*';
