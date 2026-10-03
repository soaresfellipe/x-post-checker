import { defineConfig } from '@playwright/test';
import { FIXTURE_PORT } from './scripts/build-variants';

export default defineConfig({
  testDir: 'test/e2e',
  globalSetup: './test/e2e/global-setup.ts',
  // One persistent Chromium profile per test; keep runs serial so profiles never contend.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  webServer: {
    command: 'pnpm fixture',
    url: `http://localhost:${FIXTURE_PORT}/`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
