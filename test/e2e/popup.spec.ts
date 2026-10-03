import type { Page } from '@playwright/test';
import { expect, FIXTURE_URL, optionsUrl, popupUrl, test } from './extension';
import { FIXTURE_POSTS } from '../fixtures/x-fixture';

const SYNTHETIC_KEY = 'synthetic-popup-key-0001';
const MARKER = '#amplifyx-marker-host [data-testid="amplifyx-marker"]';

declare const chrome: {
  storage: { local: { get(keys: null): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> } };
};

async function openPopup(context: Parameters<typeof popupUrl>[0]): Promise<{ page: Page; logs: string[] }> {
  const page = await context.newPage();
  const logs: string[] = [];
  page.on('console', (message) => logs.push(message.text()));
  page.on('pageerror', (error) => logs.push(error.message));
  await page.goto(await popupUrl(context));
  await expect(page.getByTestId('key-indicator')).not.toBeEmpty();
  return { page, logs };
}

const storageSnapshot = (page: Page) => page.evaluate(() => chrome.storage.local.get(null));

test.describe('popup', () => {
  test('Options button opens the extension Options page in a tab without errors', async ({ context }) => {
    const { page, logs } = await openPopup(context);
    const opened = context.waitForEvent('page');
    await page.getByTestId('open-options').click();
    const options = await opened;
    const optionErrors: string[] = [];
    options.on('pageerror', (error) => optionErrors.push(error.message));
    await options.waitForLoadState('domcontentloaded');

    expect(options.url()).toBe(await optionsUrl(context));
    await expect(options.getByRole('heading', { name: 'AmplifyX settings' })).toBeVisible();
    await expect(options.getByTestId('key-status')).not.toBeEmpty();
    expect(optionErrors).toEqual([]);
    expect(logs).toEqual([]);
  });

  test('defaults: master on, no key, explicit empty last-analysis state', async ({ context }) => {
    const { page } = await openPopup(context);
    await expect(page.getByTestId('master-toggle')).toBeChecked();
    await expect(page.getByTestId('key-indicator')).toHaveAttribute('data-state', 'missing');
    await expect(page.getByTestId('last-analysis')).toHaveAttribute('data-state', 'empty');
    await expect(page.getByTestId('last-analysis')).toHaveText('No analysis yet.');
  });

  test('agrees with settings changed in Options and the recorded analysis', async ({ context }) => {
    const options = await context.newPage();
    await options.goto(await optionsUrl(context));
    await expect(options.getByTestId('key-status')).not.toBeEmpty();
    await options.getByTestId('api-key-input').fill(SYNTHETIC_KEY);
    await options.getByTestId('save-key').click();
    await expect(options.getByTestId('save-status')).toHaveAttribute('data-state', 'success');
    await options.getByTestId('pref-enabled').uncheck();
    await expect(options.getByTestId('prefs-status')).toContainText('Preferences saved');

    const { page } = await openPopup(context);
    await expect(page.getByTestId('master-toggle')).not.toBeChecked();
    await expect(page.getByTestId('master-label')).toHaveText('AmplifyX is off');
    await expect(page.getByTestId('key-indicator')).toHaveAttribute('data-state', 'present');
    await expect(page.getByTestId('last-analysis')).toHaveAttribute('data-state', 'empty');
    expect(await page.locator('body').innerText()).not.toContain(SYNTHETIC_KEY);

    const at = Date.now() - 2 * 60_000;
    await page.evaluate((stamp) => chrome.storage.local.set({ lastAnalysis: { at: stamp, outcome: 'ok' } }), at);
    await expect(page.getByTestId('last-analysis')).toHaveAttribute('data-state', 'ok');
    await expect(page.getByTestId('last-analysis')).toHaveText('Completed 2 minutes ago');

    await options.getByTestId('pref-enabled').check();
    await expect(page.getByTestId('master-toggle')).toBeChecked();
    await options.getByTestId('remove-key').click();
    await expect(page.getByTestId('key-indicator')).toHaveAttribute('data-state', 'missing');

    await page.reload();
    await expect(page.getByTestId('master-toggle')).toBeChecked();
    await expect(page.getByTestId('last-analysis')).toHaveAttribute('data-at', String(at));
  });

  test('master switch writes storage and shows only English text in each state', async ({ context }) => {
    const { page } = await openPopup(context);
    const texts: string[] = [await page.locator('body').innerText()];
    await page.getByTestId('master-toggle').uncheck();
    await expect(page.getByTestId('master-label')).toHaveText('AmplifyX is off');
    expect((await storageSnapshot(page)).enabled).toBe(false);
    texts.push(await page.locator('body').innerText());

    // Another context wrote the key directly; the write carries its keyRevision (the key lane's
    // ordering token), so the popup's strictly-newer gate admits it over the absent@0 fact.
    await page.evaluate(() => chrome.storage.local.set({ jevApiKey: 'k', keyRevision: 1, lastAnalysis: { at: Date.now(), outcome: 'local-only' } }));
    await expect(page.getByTestId('last-analysis')).toHaveAttribute('data-state', 'local-only');
    texts.push(await page.locator('body').innerText());
    await page.evaluate(() => chrome.storage.local.set({ lastAnalysis: { at: Date.now() - 3 * 86_400_000, outcome: 'error' } }));
    await expect(page.getByTestId('last-analysis')).toHaveAttribute('data-state', 'error');
    texts.push(await page.locator('body').innerText());

    await page.getByTestId('master-toggle').check();
    expect((await storageSnapshot(page)).enabled).toBe(true);
    for (const text of texts) expect(text).toMatch(/^[\s!-~]*$/);
  });
});

test.describe('popup master switch broadcast', () => {
  test('an open fixture tab drops and regains its marker without reloading', async ({ context }) => {
    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
    await expect(fixture.locator(MARKER)).toHaveAttribute('data-background', 'connected');
    await fixture.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));

    const { page: popup } = await openPopup(context);
    await popup.getByTestId('master-toggle').uncheck();
    await expect(fixture.locator('#amplifyx-marker-host')).toHaveCount(0);

    await popup.getByTestId('master-toggle').check();
    await expect(fixture.locator(MARKER)).toHaveAttribute('data-background', 'connected');
    expect(await fixture.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
  });

  test('a tab opened while disabled injects nothing until re-enabled', async ({ context }) => {
    const { page: popup } = await openPopup(context);
    await popup.getByTestId('master-toggle').uncheck();

    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
    await expect(fixture.locator('article[data-testid="tweet"]')).toHaveCount(FIXTURE_POSTS.length);
    await fixture.waitForTimeout(1000);
    await expect(fixture.locator('#amplifyx-marker-host')).toHaveCount(0);

    await popup.getByTestId('master-toggle').check();
    await expect(fixture.locator(MARKER)).toBeVisible();
  });

  test('a disable made in Options reaches the open tab too', async ({ context }) => {
    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
    await expect(fixture.locator(MARKER)).toBeVisible();

    const options = await context.newPage();
    await options.goto(await optionsUrl(context));
    await expect(options.getByTestId('key-status')).not.toBeEmpty();
    await options.getByTestId('pref-enabled').uncheck();
    await expect(fixture.locator('#amplifyx-marker-host')).toHaveCount(0);
  });
});
