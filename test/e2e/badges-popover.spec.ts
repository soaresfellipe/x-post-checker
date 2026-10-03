import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page, Route } from '@playwright/test';
import { expect, FIXTURE_URL, launchExtensionContext, optionsUrl, test } from './extension';
import { EXTENDED_POSTS, FIXTURE_POSTS } from '../fixtures/x-fixture';

/**
 * Target badges + popover end to end through the REAL content script, background, and (for Deep
 * analysis) the intercepted Jev endpoint. The Jev key in these tests is SYNTHETIC: every request
 * to api.typesafe.ai is intercepted and answered by this file, and any unexpected request is
 * ABORTED so nothing ever reaches the real API.
 *
 * Fixture scroll note: the For You timeline RECYCLES its oldest cells for the extended posts, so
 * after a full scroll the rendered set is posts 4-12 followed by the extended posts (posts 1-3
 * are gone from the DOM). Badge-content assertions for post 1 therefore run at load, and set
 * assertions run after the scroll.
 */

const ID = (index: number): string => FIXTURE_POSTS[index]!.id;
const POST_1 = ID(0); // ana_builds: question, verified, followed, high velocity -> ~85
const POST_6 = ID(5); // tech_weekly: ~71 (just above the default 70)
const POST_8 = ID(7); // pedro_pm: ~81
const STALE_POST = ID(3); // 60h old: hard-ineligible (48h AgeFilter)
const OON_REPLY_POST = ID(4); // out-of-network reply: hard-ineligible
const NEWBIE_POST = ID(6); // ~52: below the default threshold
const BAIT_POST = ID(8); // engagement bait: heavily downranked
const JOAODEV_POST = ID(1); // ~69: just below the default threshold
const EXTENDED = EXTENDED_POSTS.map((post) => post.id); // 13 (69), 14 (~75), 15 (~81)

const BADGE = '[data-testid="amplifyx-target-badge"]';
const BADGE_SCORE = '[data-testid="amplifyx-badge-score"]';
const BADGE_REASON = '[data-testid="amplifyx-badge-reason"]';
const POPOVER = '[data-testid="amplifyx-target-popover"]';
const POPOVER_AI = '[data-testid="amplifyx-popover-ai"]';
const DEEP_ANALYSIS = '[data-testid="amplifyx-popover-deep-analysis"]';
const MARKER_HOST = '#amplifyx-marker-host';

/** A Jev reply in the VERIFIED wire shape for the target rubric (reply_potential + reply_angle). */
const TARGET_JEV_RESPONSE = {
  model: 'jev-1.13.0',
  answers: {
    reply_potential: {
      type: 'score',
      score: 4.2,
      confidence: 0.7,
      legend: { '0': 'low', '5': 'high' },
      probabilities: { '4': 0.7 },
    },
    reply_angle: {
      type: 'choice',
      choice: 'share_experience',
      confidence: 0.8,
      probabilities: { share_experience: 0.8 },
    },
  },
  usage: { input_tokens: 100, output_tokens: 20 },
};

interface JevStub {
  count(): number;
  setFailFirst(value: boolean): void;
}

/**
 * Intercepts the Jev endpoint for ANY context (the background worker included — context.route
 * reaches the SW fetch because this context has NO CDP debugging port). Requests are answered
 * with the stub response; `failFirst` (then the first request only) makes the first exchange a
 * 500, and `delayMs` holds each response open so the loading state is observable.
 */
async function stubJev(context: BrowserContext, { delayMs = 0, failFirst = false } = {}): Promise<JevStub> {
  let requests = 0;
  let failing = failFirst;
  await context.route('https://api.typesafe.ai/**', async (route: Route) => {
    requests += 1;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (failing && requests === 1) {
      failing = false;
      await route.fulfill({ status: 500, contentType: 'text/plain', body: 'stub failure' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(TARGET_JEV_RESPONSE),
    });
  });
  return {
    count: () => requests,
    setFailFirst: (value: boolean) => {
      failing = value;
    },
  };
}

/** Counts (and ABORTS) every Jev request — the zero-call assertions must never hit the real API. */
async function countJevAndAbort(context: BrowserContext): Promise<{ count(): number }> {
  let requests = 0;
  await context.route('https://api.typesafe.ai/**', async (route: Route) => {
    requests += 1;
    await route.abort();
  });
  return { count: () => requests };
}

/** Opens the fixture and waits for BOTH the watcher and the scanner to be live. */
async function openFixture(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator(MARKER_HOST)).toHaveAttribute('data-watcher-state', 'watching');
  await expect(page.locator(MARKER_HOST)).toHaveAttribute('data-scanner-state', 'scanning');
  return page;
}

/** Scrolls through the whole timeline so every fixture post becomes visible and gets scanned. */
async function scrollAll(page: Page): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(180);
  }
  await page.waitForTimeout(400); // past the scanner throttle: the last pass has stamped
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
}

/** Enables AI-for-targets and saves a synthetic key through the REAL Options write path. */
async function enableTargetsAi(context: BrowserContext): Promise<Page> {
  const options = await context.newPage();
  await options.goto(await optionsUrl(context));
  await expect(options.getByTestId('key-status')).not.toBeEmpty();
  await options.getByTestId('pref-jevForTargets').check();
  await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');
  await options.getByTestId('api-key-input').fill('key-targets-e2e-synthetic');
  await options.getByTestId('save-key').click();
  await expect(options.getByTestId('key-status')).toHaveAttribute('data-state', 'present');
  return options;
}

const badgeIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    // Badges live inside each host's SHADOW root: plain querySelectorAll cannot see them, so
    // traverse the scanner's hosts explicitly (Playwright locators pierce, evaluate does not).
    const out: string[] = [];
    for (const host of document.querySelectorAll('[data-amplifyx-host="badge"]')) {
      const badge = host.shadowRoot?.querySelector('[data-testid="amplifyx-target-badge"]');
      if (badge) out.push(badge.getAttribute('data-amplifyx-post-id') ?? '');
    }
    return out;
  });

const fixtureClicks = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __fixtureClicks: { articles: Record<string, number>; controls: Record<string, number> } }).__fixtureClicks,
  );

test.describe('target badges (fixture E2E)', () => {
  test('renders badges only above the threshold with score + English reason, zero API calls while scanning (VAL-TARGET-005/006/019, VAL-SETUP-012)', async ({ context }) => {
    const jev = await countJevAndAbort(context);
    const errors: string[] = [];
    const page = await openFixture(context);
    page.on('pageerror', (error) => errors.push(String(error)));

    // At load: post 1 (well above 70) has a badge with its score and its top-signal reason.
    const badge1 = page.locator(`${BADGE}[data-amplifyx-post-id="${POST_1}"]`);
    await expect(badge1).toBeVisible();
    expect(Number(await badge1.locator(BADGE_SCORE).textContent())).toBeGreaterThanOrEqual(70);
    expect((await badge1.locator(BADGE_REASON).textContent())?.trim()).toBe('High engagement velocity');

    // With jevForTargets off (default), Deep analysis is unavailable but the badge stays local.
    await badge1.click();
    await expect(page.locator(`${POPOVER} ${POPOVER_AI}`)).toHaveAttribute('data-ai-state', 'off');
    await expect(page.locator(DEEP_ANALYSIS)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator(POPOVER)).toHaveCount(0);

    // Full scan+scroll+navigation pass: zero api.typesafe.ai requests the whole time.
    await scrollAll(page);
    expect(jev.count()).toBe(0);
    expect(errors).toEqual([]);

    // Known scores on this fixture render exactly this badge set (posts 1-3 were recycled away):
    // above 70 -> 6 (~71), 8 (~81), 12 (~72), 14 (~75), 15 (~81); below/ineligible -> NO badge on
    // 4 (stale), 5 (OON reply), 7 (~52), 9 (bait ~16), 10/11 (~69), 13 (~69).
    const rendered = await badgeIds(page);
    expect(new Set(rendered)).toEqual(new Set([POST_6, POST_8, ID(11), EXTENDED[1], EXTENDED[2]]));
    for (const id of [STALE_POST, OON_REPLY_POST, NEWBIE_POST, BAIT_POST, ID(9), ID(10), EXTENDED[0]]) {
      expect(rendered, `post ${id} must have no badge`).not.toContain(id);
    }

    // Every rendered badge shows a score >= threshold and a non-empty English reason.
    for (const id of rendered) {
      const badge = page.locator(`${BADGE}[data-amplifyx-post-id="${id}"]`);
      expect(Number(await badge.locator(BADGE_SCORE).textContent())).toBeGreaterThanOrEqual(70);
      expect(((await badge.locator(BADGE_REASON).textContent()) ?? '').trim()).toMatch(/^[A-Za-z]/);
    }
  });

  test('popover opens with matching id/score/breakdown, isolates the click, closes by control and Escape (VAL-TARGET-014/015/016/007/008)', async ({ context }) => {
    const errors: string[] = [];
    const page = await openFixture(context);
    page.on('pageerror', (error) => errors.push(String(error)));
    const badge1 = page.locator(`${BADGE}[data-amplifyx-post-id="${POST_1}"]`);
    await expect(badge1).toBeVisible();

    // Click isolation + popover content (the badge click must not reach the article or controls).
    await badge1.click();
    const popover = page.locator(`${POPOVER}[data-amplifyx-post-id="${POST_1}"]`);
    await expect(popover).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');
    const clicks = await fixtureClicks(page);
    expect(clicks.articles[POST_1] ?? 0).toBe(0);
    expect(Object.keys(clicks.controls)).toEqual([]);

    const scoreOnBadge = Number(await badge1.locator(BADGE_SCORE).textContent());
    const scoreInPopover = Number(await popover.locator('[data-testid="amplifyx-popover-local-score"]').textContent());
    expect(scoreInPopover).toBe(scoreOnBadge);
    expect(await popover.locator('[data-testid="amplifyx-popover-signals"] li').count()).toBeGreaterThanOrEqual(6);

    // Close via the control...
    await page.locator('[data-testid="amplifyx-popover-close"]').click();
    await expect(page.locator(POPOVER)).toHaveCount(0);

    // ...and via Escape.
    await badge1.click();
    await expect(page.locator(POPOVER)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(POPOVER)).toHaveCount(0);

    // The underlying post's controls still work after badge rendering (exactly one activation).
    await page.locator(`article:has(a[href*="/status/${POST_1}"]) [data-testid="like"]`).click();
    const clicksAfter = await fixtureClicks(page);
    expect(clicksAfter.controls.like).toBe(1);
    expect(clicksAfter.articles[POST_1]).toBe(1); // the control's own click bubbled, as clicks do
    await expect(page.locator(POPOVER)).toHaveCount(0);

    // Feed re-render: the subtree is replaced, the badge must come back exactly once.
    await page.evaluate(
      (id: string) => (window as unknown as { __fixtureReplaceArticleInner: (id: string) => boolean }).__fixtureReplaceArticleInner(id),
      POST_1,
    );
    await expect(badge1).toBeVisible();
    await page.waitForTimeout(600); // past the scanner throttle: all mutation passes settled
    expect(await page.locator(`${BADGE}[data-amplifyx-post-id="${POST_1}"]`).count()).toBe(1);
    expect(errors).toEqual([]);
  });

  test('Deep analysis: exactly one Jev call per post, cached across close/reopen (VAL-TARGET-017/020)', async ({ context }) => {
    const jev = await stubJev(context);
    await enableTargetsAi(context);
    const page = await openFixture(context);
    const badge1 = page.locator(`${BADGE}[data-amplifyx-post-id="${POST_1}"]`);
    await expect(badge1).toBeVisible();

    // First activation: exactly one request, verdict rendered (band + confidence, never a %).
    await badge1.click();
    await page.locator(DEEP_ANALYSIS).click();
    await expect(page.locator(`${POPOVER} ${POPOVER_AI}`)).toHaveAttribute('data-ai-state', 'verdict');
    await expect(page.locator('[data-testid="amplifyx-popover-verdict-band"]')).toHaveText('Strong');
    await expect(page.locator('[data-testid="amplifyx-popover-verdict-confidence"]')).toContainText('70%');
    await expect(page.locator('[data-testid="amplifyx-popover-verdict-angle"]')).toContainText('Suggested angle');
    expect(jev.count()).toBe(1);

    // Close and reopen: the cached verdict renders immediately, zero further requests.
    await page.locator('[data-testid="amplifyx-popover-close"]').click();
    await expect(page.locator(POPOVER)).toHaveCount(0);
    await badge1.click();
    await expect(page.locator(`${POPOVER} ${POPOVER_AI}`)).toHaveAttribute('data-ai-state', 'verdict');
    expect(jev.count()).toBe(1);

    // A different post gets its own first request (its article is below the fold at load:
    // bring it into view first so the scanner paints its badge).
    await page.keyboard.press('Escape');
    await expect(page.locator(POPOVER)).toHaveCount(0);
    await page.locator(`article:has(a[href*="/status/${POST_8}"])`).scrollIntoViewIfNeeded();
    const badge8 = page.locator(`${BADGE}[data-amplifyx-post-id="${POST_8}"]`);
    await expect(badge8).toBeVisible();
    await badge8.click();
    await page.locator(DEEP_ANALYSIS).click();
    await expect(page.locator(`${POPOVER} ${POPOVER_AI}`)).toHaveAttribute('data-ai-state', 'verdict');
    expect(jev.count()).toBe(2);
  });

  test('Deep analysis loading and error states are visible and recoverable (VAL-TARGET-018)', async ({ context }) => {
    const jev = await stubJev(context, { delayMs: 900, failFirst: true });
    await enableTargetsAi(context);
    const errors: string[] = [];
    const page = await openFixture(context);
    page.on('pageerror', (error) => errors.push(String(error)));
    const badge1 = page.locator(`${BADGE}[data-amplifyx-post-id="${POST_1}"]`);
    await expect(badge1).toBeVisible();

    await badge1.click();
    await page.locator(DEEP_ANALYSIS).click();

    // While pending: an explicit loading state...
    await expect(page.locator(`${POPOVER} ${POPOVER_AI}`)).toHaveAttribute('data-ai-state', 'pending', { timeout: 3_000 });
    await expect(page.locator('[data-testid="amplifyx-popover-ai-notice"]')).toContainText('Analyzing');

    // ...then the 500 lands: an explicit, recoverable error state.
    await expect(page.locator(`${POPOVER} ${POPOVER_AI}`)).toHaveAttribute('data-ai-state', 'error', { timeout: 6_000 });
    await expect(page.locator('[data-testid="amplifyx-popover-ai-error-reason"]')).toContainText('HTTP 500');

    // The popover remains closable and its error survives a close/reopen.
    await page.keyboard.press('Escape');
    await expect(page.locator(POPOVER)).toHaveCount(0);
    await badge1.click();
    await expect(page.locator(`${POPOVER} ${POPOVER_AI}`)).toHaveAttribute('data-ai-state', 'error');

    // Try again re-dispatches (a failure is never cached) and now succeeds.
    await page.locator('[data-testid="amplifyx-popover-retry"]').click();
    await expect(page.locator(`${POPOVER} ${POPOVER_AI}`)).toHaveAttribute('data-ai-state', 'verdict', { timeout: 6_000 });
    expect(jev.count()).toBe(2);
    expect(errors).toEqual([]);
  });

  test('threshold changes in Options re-gate badges on the next scan; master off removes badges (VAL-TARGET-024, VAL-SETUP-016)', async ({ context }) => {
    const page = await openFixture(context);
    const badge1 = page.locator(`${BADGE}[data-amplifyx-post-id="${POST_1}"]`);
    const badge2 = page.locator(`${BADGE}[data-amplifyx-post-id="${JOAODEV_POST}"]`);
    await expect(badge1).toBeVisible();
    await expect(badge2).toHaveCount(0);

    const options = await context.newPage();
    await options.goto(await optionsUrl(context));
    await expect(options.getByTestId('key-status')).not.toBeEmpty();

    // 70 -> 50: the just-below post (69) gains a badge on the next scan; bait/stale/OON-reply never do.
    await options.getByTestId('pref-targetThreshold').fill('50');
    await options.getByTestId('pref-targetThreshold').blur();
    await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');
    await expect(page.locator(`${BADGE}[data-amplifyx-post-id="${JOAODEV_POST}"]`)).toBeVisible();
    await expect(page.locator(`${BADGE}[data-amplifyx-post-id="${BAIT_POST}"]`)).toHaveCount(0);
    await expect(page.locator(`${BADGE}[data-amplifyx-post-id="${STALE_POST}"]`)).toHaveCount(0);
    await expect(page.locator(`${BADGE}[data-amplifyx-post-id="${OON_REPLY_POST}"]`).count()).resolves.toBe(0);

    // Exactly at post 1's own score it keeps its badge; one above it loses it (>= boundary).
    const score1 = Number(await badge1.locator(BADGE_SCORE).textContent());
    await options.getByTestId('pref-targetThreshold').fill(String(score1));
    await options.getByTestId('pref-targetThreshold').blur();
    await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');
    await expect(badge1).toBeVisible();
    await options.getByTestId('pref-targetThreshold').fill(String(score1 + 1));
    await options.getByTestId('pref-targetThreshold').blur();
    await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');
    await expect(badge1).toHaveCount(0);

    // Back to 50, then the master switch off removes the rendered badges from the OPEN tab
    // without a reload...
    await options.getByTestId('pref-targetThreshold').fill('50');
    await options.getByTestId('pref-targetThreshold').blur();
    await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');
    await expect(page.locator(`${BADGE}[data-amplifyx-post-id="${JOAODEV_POST}"]`)).toBeVisible();
    const epoch = await page.evaluate(() => (window as unknown as { __fixtureEpoch: number }).__fixtureEpoch);
    await options.getByTestId('pref-enabled').uncheck();
    await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');
    await expect(page.locator(BADGE)).toHaveCount(0);
    await expect(page.locator(POPOVER)).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __fixtureEpoch: number }).__fixtureEpoch)).toBe(epoch);
    // ...and back on restores them (a fresh scan re-renders).
    await options.getByTestId('pref-enabled').check();
    await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');
    await expect(page.locator(`${BADGE}[data-amplifyx-post-id="${JOAODEV_POST}"]`)).toBeVisible();
  });

  test('threshold choice survives a browser restart (VAL-TARGET-024, restart leg)', async () => {
    test.setTimeout(120_000);
    const profileDir = await mkdtemp(path.join(tmpdir(), 'amplifyx-badges-'));
    let context: BrowserContext | undefined;
    try {
      // Session 1: lower the threshold through Options, then close the browser.
      context = await launchExtensionContext(profileDir);
      const page1 = await openFixture(context);
      await expect(page1.locator(`${BADGE}[data-amplifyx-post-id="${JOAODEV_POST}"]`)).toHaveCount(0);
      const options1 = await context.newPage();
      await options1.goto(await optionsUrl(context));
      await options1.getByTestId('pref-targetThreshold').fill('50');
      await options1.getByTestId('pref-targetThreshold').blur();
      await expect(options1.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');
      await expect(page1.locator(`${BADGE}[data-amplifyx-post-id="${JOAODEV_POST}"]`)).toBeVisible();
      await context.close();
      context = undefined;

      // Session 2 (same profile): the persisted threshold still gates the badges at 50.
      context = await launchExtensionContext(profileDir);
      const page2 = await openFixture(context);
      await expect(page2.locator(`${BADGE}[data-amplifyx-post-id="${JOAODEV_POST}"]`)).toBeVisible();
      await expect(page2.locator(`${BADGE}[data-amplifyx-post-id="${BAIT_POST}"]`)).toHaveCount(0);
    } finally {
      await context?.close().catch(() => undefined);
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test('badges and the draft score overlay coexist and stay independently usable (VAL-CROSS-003)', async ({ context }) => {
    const page = await openFixture(context);
    const badge1 = page.locator(`${BADGE}[data-amplifyx-post-id="${POST_1}"]`);
    await expect(badge1).toBeVisible();

    // Type an eligible draft: the overlay mounts near the composer while the badges stay put.
    const composer = page.locator('[data-testid="tweetTextarea_0"]');
    await composer.click();
    await page.keyboard.type('What changed my year? One daily checklist that actually sticks.');
    const overlay = page.getByTestId('amplifyx-overlay');
    await expect(overlay).toBeVisible();
    await expect(badge1).toBeVisible();

    // Both surfaces remain usable together: the badge popover opens over the timeline and the
    // overlay keeps its state; closing the popover leaves the overlay untouched.
    await badge1.click();
    await expect(page.locator(POPOVER)).toBeVisible();
    await expect(overlay).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(POPOVER)).toHaveCount(0);
    await expect(overlay).toBeVisible();
  });
});
