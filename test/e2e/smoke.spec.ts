import { expect, FIXTURE_URL, test } from './extension';

test.describe('extension smoke', () => {
  test('content script mounts its Shadow DOM marker on the fixture page', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });

    const marker = page.locator('#amplifyx-marker-host [data-testid="amplifyx-marker"]');
    await expect(marker).toBeVisible();
    await expect(marker).toHaveText('AmplifyX');
  });

  test('marker confirms a round trip to the background via the typed protocol', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#amplifyx-marker-host [data-testid="amplifyx-marker"]')).toHaveAttribute(
      'data-background',
      'connected',
    );
  });

  test('fixture renders a composer and timeline articles with real data-testids', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('div[data-testid="tweetTextarea_0"][role="textbox"][contenteditable="true"]')).toBeVisible();
    await expect(page.locator('article[data-testid="tweet"]')).toHaveCount(10);
    await expect(page.locator('article [data-testid="like"]').first()).toHaveAttribute('aria-label', /Curtir/);
  });

  test('the extension loads a background worker', async ({ context }) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
    expect(worker.url()).toMatch(/^chrome-extension:\/\/.+\/background\.js$/);
  });
});
