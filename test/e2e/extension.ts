import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, test as base, type BrowserContext } from '@playwright/test';
import { FIXTURE_PORT } from '../../scripts/build-variants';

export const TEST_EXTENSION_DIR = path.resolve('.output/chrome-mv3-e2e');
export const FIXTURE_URL = `http://localhost:${FIXTURE_PORT}/`;

export async function launchExtensionContext(
  profileDir: string,
  options: { reducedMotion?: 'reduce' | 'no-preference' } = {},
): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    reducedMotion: options.reducedMotion,
    args: [`--disable-extensions-except=${TEST_EXTENSION_DIR}`, `--load-extension=${TEST_EXTENSION_DIR}`],
    timeout: 45_000,
  });
}

/** Resolves the extension id from its background worker, then the Options page URL. */
export async function optionsUrl(context: BrowserContext): Promise<string> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
  return `chrome-extension://${new URL(worker.url()).host}/options.html`;
}

export async function popupUrl(context: BrowserContext): Promise<string> {
  return (await optionsUrl(context)).replace(/options\.html$/, 'popup.html');
}

/**
 * Extensions only load in full Chromium (`channel: 'chromium'`), not the default headless shell.
 * The context is persistent because Chromium requires a user-data dir to load extensions.
 */
export const test = base.extend<{ context: BrowserContext }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const profileDir = await mkdtemp(path.join(tmpdir(), 'amplifyx-e2e-'));
    const context = await launchExtensionContext(profileDir);
    await use(context);
    await context.close();
    await rm(profileDir, { recursive: true, force: true });
  },
});

export const expect = test.expect;
