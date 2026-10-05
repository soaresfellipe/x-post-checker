/**
 * One-shot interactive verification for m6-theme-foundation-and-realx-probe (sanctioned route (b):
 * isolated headless launchPersistentContext, fresh mkdtemp profile, NO debugging port — see
 * library/user-testing.md). Types a draft on the fixture, then switches the body theme live and
 * captures the themed overlay/badge host state + screenshots.
 */
import { chromium } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXTENSION_DIR = '/home/agents/x-post-checker/.output/chrome-mv3-e2e';
const OUT = '/home/agents/x-post-checker/evidence/m6-theme-interactive';
const DRAFT =
  'Interactive theme check: does the token plumbing follow the fixture theme switch live? #fixture';

const profile = mkdtempSync(join(tmpdir(), 'amplifyx-theme-verify-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
});
try {
  const page = await context.newPage();
  await page.goto('http://localhost:3177/', { waitUntil: 'domcontentloaded' });
  await page.locator('#amplifyx-marker-host').waitFor({ state: 'attached', timeout: 15_000 });

  await page.locator('[data-testid="tweetTextarea_0"]').click();
  await page.keyboard.type(DRAFT);
  await page.waitForTimeout(1200);

  const readState = () =>
    page.evaluate(() => {
      const host = document.getElementById('amplifyx-overlay-host');
      const badges = [...document.querySelectorAll('[data-amplifyx-host="badge"]')];
      const firstBadge = badges[0] ?? null;
      return {
        overlayMounted: host !== null,
        overlayTheme: host?.getAttribute('data-theme') ?? null,
        overlayBg: host ? getComputedStyle(host).getPropertyValue('--bg').trim() : null,
        badgeCount: badges.length,
        badgeTheme: firstBadge?.getAttribute('data-theme') ?? null,
        badgeBg: firstBadge ? getComputedStyle(firstBadge).getPropertyValue('--bg').trim() : null,
      };
    });

  const results = {};
  for (const theme of ['light', 'dim', 'lights-out', 'unknown']) {
    await page.evaluate((t) => window.__fixtureSetTheme(t), theme);
    await page.waitForTimeout(400);
    results[theme] = await readState();
    await page.locator('[data-testid="primaryColumn"]')
      .screenshot({ path: join(OUT, `composer-${theme}.png`) })
      .catch(() => {});
  }
  console.log('INTERACTIVE THEME RESULTS:', JSON.stringify(results, null, 1));
  console.log('RESULT: interactive-verify-complete');
} finally {
  await context.close().catch(() => undefined);
  rmSync(profile, { recursive: true, force: true });
}
