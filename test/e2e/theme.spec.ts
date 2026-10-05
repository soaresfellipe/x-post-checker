/**
 * M6 theme foundation E2E on the fixture (m6-theme-foundation-and-realx-probe): the fixture's
 * `__fixtureSetTheme` hook writes the body background INLINE STYLE exactly the way real x.com
 * does (verified live 2026-10-05, `library/x-dom.md` m6 insertion probe fact 4d). The extension
 * surfaces must stamp the resolved theme on their host's `data-theme` attribute and resolve the
 * Design 1b token custom properties per :host — through live switches and the light fallback for
 * an unknown background. No visual redesign is asserted here (that is the later M6 features):
 * only that the token plumbing is live on the overlay and badge hosts.
 */
import type { BrowserContext, Page } from '@playwright/test';
import { expect, FIXTURE_URL, test } from './extension';

const OVERLAY_HOST = '#amplifyx-overlay-host';
const BADGE_HOST = '[data-amplifyx-host="badge"]';
const HOME_COMPOSER = '[data-testid="tweetTextarea_0"]';
/** A draft long enough to mount the overlay (above the ~10-char minimum). */
const DRAFT =
  'Does the AmplifyX theme plumbing follow a live theme switch? This synthetic draft says it must. #fixture';

async function openFixture(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#amplifyx-marker-host')).toHaveAttribute('data-watcher-state', 'watching');
  return page;
}

function setTheme(page: Page, theme: 'light' | 'dim' | 'lights-out' | 'unknown'): Promise<void> {
  return page.evaluate(
    (t: string) => (window as unknown as { __fixtureSetTheme: (t: string) => void }).__fixtureSetTheme(t),
    theme,
  );
}

/** The resolved --bg custom property on a themed HOST element (tokens apply via :host rules). */
function hostBg(locator: ReturnType<Page['locator']>): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).getPropertyValue('--bg').trim());
}

test.describe('M6 theme foundation', () => {
  test('overlay and badge hosts carry the light tokens by default and follow live switches', async ({ context }) => {
    const page = await openFixture(context);
    await page.locator(HOME_COMPOSER).click();
    await page.keyboard.type(DRAFT);
    const overlay = page.locator(OVERLAY_HOST);
    await expect(overlay).toBeVisible();
    await expect(overlay).toHaveAttribute('data-theme', 'light');
    await expect(page.locator(BADGE_HOST).first()).toHaveAttribute('data-theme', 'light');
    await expect.poll(() => hostBg(page.locator(OVERLAY_HOST))).toBe('#ffffff');
    await expect.poll(() => hostBg(page.locator(BADGE_HOST).first())).toBe('#ffffff');

    // Live switch -> MutationObserver on body style -> data-theme + token values follow.
    await setTheme(page, 'dim');
    await expect(overlay).toHaveAttribute('data-theme', 'dim');
    await expect(page.locator(BADGE_HOST).first()).toHaveAttribute('data-theme', 'dim');
    await expect.poll(() => hostBg(page.locator(OVERLAY_HOST))).toBe('#15202b');
    await expect.poll(() => hostBg(page.locator(BADGE_HOST).first())).toBe('#15202b');

    await setTheme(page, 'lights-out');
    await expect(overlay).toHaveAttribute('data-theme', 'lights-out');
    await expect(page.locator(BADGE_HOST).first()).toHaveAttribute('data-theme', 'lights-out');
    await expect.poll(() => hostBg(page.locator(OVERLAY_HOST))).toBe('#000000');
    await expect.poll(() => hostBg(page.locator(BADGE_HOST).first())).toBe('#000000');
  });

  test('an unknown body background falls back to light tokens', async ({ context }) => {
    const page = await openFixture(context);
    await page.locator(HOME_COMPOSER).click();
    await page.keyboard.type(DRAFT);
    const overlay = page.locator(OVERLAY_HOST);
    await expect(overlay).toBeVisible();
    await setTheme(page, 'unknown');
    await expect(overlay).toHaveAttribute('data-theme', 'light');
    await expect.poll(() => hostBg(page.locator(OVERLAY_HOST))).toBe('#ffffff');
  });
});
