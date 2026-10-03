import type { BrowserContext, Page } from '@playwright/test';
import { expect, FIXTURE_URL, optionsUrl, test } from './extension';

const MARKER_HOST = '#amplifyx-marker-host';
const OVERLAY_HOST = '#amplifyx-overlay-host';
const HOME_COMPOSER = '[data-testid="tweetTextarea_0"]';
const REPLY_COMPOSER = '[data-testid="tweetTextarea_1"]';

async function openFixture(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator(MARKER_HOST)).toHaveAttribute('data-watcher-state', 'watching');
  await expect(page.locator(MARKER_HOST)).toHaveAttribute('data-watcher-composer', 'tweetTextarea_0');
  return page;
}

async function openOptions(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(await optionsUrl(context));
  await expect(page.getByTestId('key-status')).not.toBeEmpty();
  return page;
}

test.describe('composer watcher', () => {
  test('watches the home composer and dispatches one debounced analysis per settled draft', async ({ context }) => {
    const page = await openFixture(context);
    await page.locator(HOME_COMPOSER).click();
    await page.keyboard.type('A draft long enough to be analyzed');
    await expect(page.locator(MARKER_HOST)).toHaveAttribute('data-watcher-dispatches', '1', { timeout: 5_000 });
  });

  test('keeps drafts below minDraftLength silent until the raw char count reaches it', async ({ context }) => {
    const page = await openFixture(context);
    await page.locator(HOME_COMPOSER).click();
    await page.keyboard.type('123456789'); // 9 raw chars; default minDraftLength is 10
    await page.waitForTimeout(1_200); // well past the ~700ms debounce
    await expect(page.locator(MARKER_HOST)).toHaveAttribute('data-watcher-dispatches', '0');

    await page.keyboard.type('0'); // exactly 10 raw chars
    await expect(page.locator(MARKER_HOST)).toHaveAttribute('data-watcher-dispatches', '1', { timeout: 5_000 });
  });

  test('counts a trailing blank line toward minDraftLength: raw chars include the newline (VAL-SETUP-014)', async ({ context }) => {
    const page = await openFixture(context);
    const marker = page.locator(MARKER_HOST);
    await page.locator(HOME_COMPOSER).click();
    await page.keyboard.type('123456789'); // 9 raw chars on the line
    await page.waitForTimeout(1_200);
    await expect(marker).toHaveAttribute('data-watcher-dispatches', '0');

    await page.keyboard.press('Enter'); // blank line block: the newline makes it 10 raw chars
    await expect(marker).toHaveAttribute('data-watcher-dispatches', '1', { timeout: 5_000 });
  });

  test('analyzes an IME composition exactly once, after compositionend + debounce', async ({ context }) => {
    const page = await openFixture(context);
    const marker = page.locator(MARKER_HOST);
    await page.locator(HOME_COMPOSER).evaluate((element) => {
      const box = element as HTMLElement;
      const fire = (type: string) => box.dispatchEvent(new Event(type, { bubbles: true }));
      fire('compositionstart');
      const line = document.createElement('div');
      line.textContent = ' composed via IME events';
      box.replaceChildren(line);
      fire('compositionupdate');
      fire('compositionend');
      fire('input'); // the final input browsers deliver right after compositionend
    });
    await expect(marker).toHaveAttribute('data-watcher-dispatches', '1', { timeout: 5_000 });
    await page.waitForTimeout(1_200); // no duplicate analysis may appear afterwards
    await expect(marker).toHaveAttribute('data-watcher-dispatches', '1');
  });

  test('treats a paste like typed input without duplicate analyses', async ({ context }) => {
    const page = await openFixture(context);
    const marker = page.locator(MARKER_HOST);
    await page.locator(HOME_COMPOSER).evaluate((element) => {
      const box = element as HTMLElement;
      const line = document.createElement('div');
      line.textContent = 'Pasted long draft that must qualify for analysis';
      box.replaceChildren(line);
      const fire = (type: string) => box.dispatchEvent(new Event(type, { bubbles: true }));
      fire('paste');
      fire('input'); // paste bursts collapse into the same debounced capture
    });
    await expect(marker).toHaveAttribute('data-watcher-dispatches', '1', { timeout: 5_000 });
    await page.waitForTimeout(1_200);
    await expect(marker).toHaveAttribute('data-watcher-dispatches', '1');
  });

  test('follows SPA navigation to the reply composer and back home idempotently', async ({ context }) => {
    const page = await openFixture(context);
    const marker = page.locator(MARKER_HOST);

    await page.locator('a[href*="/status/"]').first().click();
    await expect(marker).toHaveAttribute('data-watcher-composer', 'tweetTextarea_1', { timeout: 5_000 });

    await page.locator(REPLY_COMPOSER).click();
    await page.keyboard.type('Reply draft long enough');
    await expect(marker).toHaveAttribute('data-watcher-dispatches', '1', { timeout: 5_000 });

    await page.locator('[data-testid="app-bar-close"]').click();
    await expect(marker).toHaveAttribute('data-watcher-composer', 'tweetTextarea_0', { timeout: 5_000 });
    await expect(marker).toHaveAttribute('data-watcher-state', 'watching');
    await expect(marker).toHaveAttribute('data-watcher-dispatches', '1'); // preserved: no stale re-dispatch

    await page.locator(HOME_COMPOSER).click();
    await page.keyboard.type('Another draft after returning home');
    await expect(marker).toHaveAttribute('data-watcher-dispatches', '2', { timeout: 5_000 });
  });

  test('autoAnalyze off: typing captures silently; nothing dispatches', async ({ context }) => {
    const options = await openOptions(context);
    await options.getByTestId('pref-autoAnalyze').uncheck();
    await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');

    const page = await openFixture(context);
    await page.locator(HOME_COMPOSER).click();
    await page.keyboard.type('Draft typed while autoAnalyze is disabled');
    await page.waitForTimeout(1_200);
    await expect(page.locator(MARKER_HOST)).toHaveAttribute('data-watcher-dispatches', '0');
  });

  test('master off stops the watcher in an open tab; on resumes it', async ({ context }) => {
    const options = await openOptions(context);
    const page = await openFixture(context);
    const marker = page.locator(MARKER_HOST);

    await options.getByTestId('pref-enabled').uncheck();
    await expect(marker).toHaveCount(0); // nothing of the watcher remains in the page

    await options.getByTestId('pref-enabled').check();
    await expect(marker).toHaveAttribute('data-watcher-state', 'watching');
    await expect(marker).toHaveAttribute('data-watcher-composer', 'tweetTextarea_0');
  });

  test('ignores an unrelated editor on a composer-less route: no overlay, no analysis, no error (VAL-DRAFT-029)', async ({ context }) => {
    const page = await openFixture(context);
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(String(error)));
    const marker = page.locator(MARKER_HOST);

    // The Explore route carries an unrelated DraftEditor search box and NO composer container.
    await page.locator('[data-testid="navExplore"]').click();
    await expect(marker).toHaveAttribute('data-watcher-state', 'idle');
    await expect(marker).toHaveAttribute('data-watcher-composer', '(none)');
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(0);

    // Typing into the unrelated editor must not attract the watcher, an overlay or a request.
    await page.locator('[data-testid="exploreView"] [role="textbox"]').click();
    await page.keyboard.type('Text typed into an unrelated editor, long enough to qualify');
    await page.waitForTimeout(1_200);
    await expect(marker).toHaveAttribute('data-watcher-dispatches', '0');
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(0);
    expect(errors).toEqual([]);

    // Returning home resumes normal watching.
    await page.goBack();
    await expect(marker).toHaveAttribute('data-watcher-state', 'watching');
    await expect(marker).toHaveAttribute('data-watcher-composer', 'tweetTextarea_0');
  });

  for (const badgeCase of [
    { href: '/ana_builds/status/1800000000000000001', expectBoost: true, name: 'visible badge beside the reply line' },
    { href: '/badge_hidden/status/1800000000000000011', expectBoost: false, name: 'hidden follow badge' },
    { href: '/badge_elsewhere/status/1800000000000000012', expectBoost: false, name: 'unrelated follow badge' },
  ]) {
    test(`reply follow boost only with a visible, target-specific badge: ${badgeCase.name} (VAL-DRAFT-019)`, async ({ context }) => {
      const page = await openFixture(context);
      await page.locator(`a[href="${badgeCase.href}"]`).first().click();
      await expect(page.locator(REPLY_COMPOSER)).toBeVisible();
      await page.locator(REPLY_COMPOSER).click();
      await page.keyboard.type('Reply draft that is long enough');

      const signals = page.getByTestId('overlay-signals');
      await expect(signals).toBeVisible({ timeout: 5_000 });
      const row = signals.locator('li[data-signal-id="reply-mutual"]');
      if (badgeCase.expectBoost) {
        await expect(row).toContainText('the viewer follows (visible)');
        await expect(row.locator('.points')).toHaveText('+5');
      } else {
        await expect(row).toContainText('not visible, boost not applied');
        await expect(row.locator('.points')).toHaveText('0');
      }
    });
  }
});
