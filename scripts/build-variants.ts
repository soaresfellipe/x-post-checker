/** WXT mode used for the Playwright/test build; the only build allowed to match the local fixture. */
export const TEST_MODE = 'e2e';

export const FIXTURE_PORT = 3177;
// Firefox match patterns do not support ports: `http://localhost:3177/*` is invalid and gets
// silently dropped from content_scripts, which kills injection. A pattern without a port
// matches any port on that host, so this single pattern covers the fixture server.
export const TEST_FIXTURE_MATCH = 'http://localhost/*';

/** Fixture origin needs host permission in e2e builds: Firefox MV3 only injects content
 * scripts into sites the manifest has host permission for. */
export const TEST_FIXTURE_HOST_PERMISSIONS = ['http://localhost/*'] as const;

/** Content-script site matches the release manifest must carry host permission for
 * (Firefox MV3 injection rule; see wxt.config.ts). */
export const REQUIRED_CONTENT_HOST_PERMISSIONS = ['https://x.com/*', 'https://twitter.com/*'] as const;

export const REQUIRED_CONTENT_MATCHES = ['https://x.com/*', 'https://twitter.com/*'] as const;
export const REQUIRED_HOST_PERMISSION = 'https://api.typesafe.ai/*';
