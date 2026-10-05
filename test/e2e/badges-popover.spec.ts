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

    // At load: post 1 (well above 70) has a score-only chip in the green tone, its reason in the
    // aria-label (VAL-TARGET-006) — never as chip text.
    const badge1 = page.locator(`${BADGE}[data-amplifyx-post-id="${POST_1}"]`);
    await expect(badge1).toBeVisible();
    await expect(badge1).toHaveAttribute('data-tone', 'good');
    const score1 = Number(await badge1.locator(BADGE_SCORE).textContent());
    expect(score1).toBeGreaterThanOrEqual(70);
    expect((await badge1.textContent())?.trim()).toMatch(/^\d+$/);
    expect(await badge1.getAttribute('aria-label')).toBe(`Reply target score ${score1}: High engagement velocity`);

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

    // Every rendered badge is an above-70 score-only chip in the green tone with an English
    // reason in its aria-label.
    for (const id of rendered) {
      const badge = page.locator(`${BADGE}[data-amplifyx-post-id="${id}"]`);
      expect(Number(await badge.locator(BADGE_SCORE).textContent())).toBeGreaterThanOrEqual(70);
      await expect(badge).toHaveAttribute('data-tone', 'good');
      expect(await badge.getAttribute('aria-label')).toMatch(/^Reply target score \d+: [A-Za-z]/);
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
    // Target-signal chips with a "N neutral ›" rows toggle (the full rows list starts hidden).
    expect(await popover.locator('[data-testid="amplifyx-popover-chip"]').count()).toBeGreaterThanOrEqual(3);
    const toggle = popover.locator('[data-testid="amplifyx-popover-neutral-toggle"]');
    await expect(toggle).toHaveText(/^\d+ neutral ›$/);
    expect(await popover.locator('[data-testid="amplifyx-popover-signal-rows"] li').count()).toBeGreaterThanOrEqual(6);

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
    await expect(page.locator('[data-testid="amplifyx-popover-verdict-band"]')).toHaveText('AI · Strong');
    await expect(page.locator('[data-testid="amplifyx-popover-verdict-confidence"]')).toHaveText('70% confidence · a heuristic, not a prediction');
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

    // ...then the 500 lands: an explicit, recoverable error state (the §6 error line embeds the
    // reason verbatim, with an inline "Retry" link).
    await expect(page.locator(`${POPOVER} ${POPOVER_AI}`)).toHaveAttribute('data-ai-state', 'error', { timeout: 6_000 });
    await expect(page.locator('[data-testid="amplifyx-popover-ai-notice"]')).toContainText('HTTP 500');
    await expect(page.locator('[data-testid="amplifyx-popover-retry"]')).toBeVisible();

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
    // Above the lowered threshold but still below 70: the NEUTRAL chip tone, never green (VAL-TARGET-005).
    await expect(page.locator(`${BADGE}[data-amplifyx-post-id="${JOAODEV_POST}"]`)).toHaveAttribute('data-tone', 'neutral');
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

    // Type an eligible draft: the in-flow status row mounts before the composer's toolbar while
    // the badges stay put — the row is the whole overlay surface while typing (M6 design 1b).
    const composer = page.locator('[data-testid="tweetTextarea_0"]');
    await composer.click();
    await page.keyboard.type('What changed my year? One daily checklist that actually sticks.');
    const row = page.getByTestId('amplifyx-overlay-row');
    await expect(row).toBeVisible({ timeout: 5_000 });
    await expect(badge1).toBeVisible();

    // Both surfaces remain usable together. Expanding the inline analysis does not disturb the
    // badges, and it collapses back to the row (Escape) so the badge is reachable again — an
    // outside click collapses AND reaches the page (VAL-DRAFT-037), so a badge click is free to
    // aim wherever the user points it.
    await row.click();
    const overlay = page.getByTestId('amplifyx-overlay');
    await expect(overlay).toBeVisible();
    await expect(badge1).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
    await badge1.click();
    await expect(page.locator(POPOVER)).toBeVisible();
    await expect(row).toBeVisible(); // the overlay is untouched by the popover
    await page.keyboard.press('Escape');
    await expect(page.locator(POPOVER)).toHaveCount(0);
    await expect(row).toBeVisible();

    // The row's collapsed pass-through still works: typing collapses the block and keeps the
    // badges untouched, so the two surfaces never interfere in EITHER state.
    await composer.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('A second draft while the badges are on screen, long enough');
    await expect(overlay).toHaveCount(0);
    await expect(row).toBeVisible({ timeout: 5_000 });
    await expect(badge1).toBeVisible();
  });

  test('chip anatomy: inside User-Name after the time link with separator, hover tooltip, User-Name fallback (VAL-TARGET-026)', async ({ context }) => {
    const errors: string[] = [];
    const page = await openFixture(context);
    page.on('pageerror', (error) => errors.push(String(error)));
    const badge1 = page.locator(`${BADGE}[data-amplifyx-post-id="${POST_1}"]`);
    await expect(badge1).toBeVisible();

    // Placement: the host sits INSIDE the React-managed User-Name container as its LAST child
    // (after the time link), preceded by the "·" separator; the chip is score-only.
    const placement = await page.evaluate((id: string) => {
      for (const host of document.querySelectorAll('[data-amplifyx-host="badge"]')) {
        const badge = host.shadowRoot?.querySelector('[data-testid="amplifyx-target-badge"]');
        if (badge?.getAttribute('data-amplifyx-post-id') !== id) continue;
        const parent = host.parentElement;
        return {
          placement: host.getAttribute('data-placement'),
          parentTestId: parent?.getAttribute('data-testid') ?? null,
          isLastChild: parent !== null && parent.lastElementChild === host,
          parentHasTime: parent?.querySelector('time') !== null,
          separator: host.shadowRoot?.querySelector('[data-testid="amplifyx-badge-separator"]')?.textContent ?? null,
        };
      }
      return null;
    }, POST_1);
    expect(placement).toEqual({
      placement: 'user-name',
      parentTestId: 'User-Name',
      isLastChild: true,
      parentHasTime: true,
      separator: '·',
    });

    // Hover: the chip inverts and the tooltip "{reason} · reply target" opens 6px below it.
    // The tooltip is the chip's SIBLING in the badge host's shadow root; the geometry is read in
    // ONE atomic evaluate right after the mouse move (evaluate does not pierce shadow roots, so
    // the shadow traversal is manual) so a fixture repaint cannot drop :hover mid-assertion.
    const chipBox = await badge1.boundingBox();
    await page.mouse.move(chipBox!.x + chipBox!.width / 2, chipBox!.y + chipBox!.height / 2);
    const tooltipState = await page.evaluate((id: string) => {
      for (const host of document.querySelectorAll('[data-amplifyx-host="badge"]')) {
        const badge = host.shadowRoot?.querySelector(`[data-testid="amplifyx-target-badge"][data-amplifyx-post-id="${id}"]`);
        if (!badge) continue;
        const tooltip = host.shadowRoot?.querySelector('[data-testid="amplifyx-badge-tooltip"]');
        const chipRect = badge.getBoundingClientRect();
        const tipRect = tooltip?.getBoundingClientRect();
        return {
          visible: tooltip != null && getComputedStyle(tooltip).display !== 'none',
          text: tooltip?.textContent ?? '',
          chipBottom: chipRect.bottom,
          chipLeft: chipRect.left,
          tipTop: tipRect?.top ?? null,
          tipLeft: tipRect?.left ?? null,
        };
      }
      return null;
    }, POST_1);
    expect(tooltipState!.visible).toBe(true);
    expect(tooltipState!.text).toBe('High engagement velocity · reply target');
    expect(tooltipState!.tipTop!).toBeGreaterThanOrEqual(tooltipState!.chipBottom + 5);
    expect(tooltipState!.tipTop!).toBeLessThan(tooltipState!.chipBottom + 8);

    // Fallback: strip User-Name from the article (keeping the status link + time so the post
    // still extracts) — the chip re-renders at the END of the article with the SAME anatomy.
    await page.evaluate((id: string) => {
      const article = [...document.querySelectorAll('article')].find((a) => a.querySelector(`a[href*="/status/${id}"] time`));
      if (!article) throw new Error('fixture article not found');
      const userName = article.querySelector('[data-testid="User-Name"]');
      const time = article.querySelector('time');
      const link = time?.closest('a');
      if (!userName || !time || !link) throw new Error('fixture pieces missing');
      const holder = document.createElement('div');
      holder.append(link.cloneNode(true));
      userName.remove();
      article.prepend(holder.firstChild!);
    }, POST_1);
    await expect(badge1).toBeVisible();
    await page.waitForTimeout(600); // past the scanner throttle: all mutation passes settled
    const fallback = await page.evaluate((id: string) => {
      for (const host of document.querySelectorAll('[data-amplifyx-host="badge"]')) {
        const badge = host.shadowRoot?.querySelector('[data-testid="amplifyx-target-badge"]');
        if (badge?.getAttribute('data-amplifyx-post-id') !== id) continue;
        return {
          placement: host.getAttribute('data-placement'),
          parentTag: host.parentElement?.tagName ?? null,
          isArticleLastChild: host.parentElement?.tagName === 'ARTICLE' && host.parentElement.lastElementChild === host,
          separator: host.shadowRoot?.querySelector('[data-testid="amplifyx-badge-separator"]')?.textContent ?? null,
        };
      }
      return null;
    }, POST_1);
    expect(fallback).toEqual({ placement: 'article', parentTag: 'ARTICLE', isArticleLastChild: true, separator: '·' });
    await expect(page.locator(`${BADGE}[data-amplifyx-post-id="${POST_1}"]`)).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('popover restyle: 300px card anchored 6px below the chip, left-aligned and clamped, 1b header/chips/footer copy (VAL-TARGET-027)', async ({ context }) => {
    const errors: string[] = [];
    const page = await openFixture(context);
    page.on('pageerror', (error) => errors.push(String(error)));
    const badge1 = page.locator(`${BADGE}[data-amplifyx-post-id="${POST_1}"]`);
    await expect(badge1).toBeVisible();

    // Default settings (AI for targets off): the off footer, verbatim.
    await badge1.click();
    await expect(page.locator(`${POPOVER} ${POPOVER_AI}`)).toHaveAttribute('data-ai-state', 'off');
    await expect(page.locator(`${POPOVER} ${POPOVER_AI} [data-testid="amplifyx-popover-ai-notice"]`)).toHaveText(
      'Local signals only. AI analysis is off in Settings.',
    );
    await page.keyboard.press('Escape');
    await expect(page.locator(POPOVER)).toHaveCount(0);

    // AI-for-targets enabled WITHOUT a key: the no-key footer with the "Connect Jev" link.
    const options = await context.newPage();
    await options.goto(await optionsUrl(context));
    await options.getByTestId('pref-jevForTargets').check();
    await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');
    await options.close();
    await badge1.click();
    await expect(page.locator(`${POPOVER} ${POPOVER_AI}`)).toHaveAttribute('data-ai-state', 'no-key');
    await expect(page.locator(`${POPOVER} ${POPOVER_AI} [data-testid="amplifyx-popover-ai-notice"]`)).toHaveText(
      'Local signals only. Connect Jev to add AI judgment and hook variants.',
    );
    await page.keyboard.press('Escape');

    // With a key present: the idle footer + the 1b geometry and header, anchored to the CHIP.
    // (The pref is already on from the no-key leg, so only the synthetic key save runs here.)
    const keyOptions = await context.newPage();
    await keyOptions.goto(await optionsUrl(context));
    await keyOptions.getByTestId('api-key-input').fill('key-targets-e2e-synthetic');
    await keyOptions.getByTestId('save-key').click();
    await expect(keyOptions.getByTestId('key-status')).toHaveAttribute('data-state', 'present');
    await keyOptions.close();
    await badge1.click();
    const popover = page.locator(`${POPOVER}[data-amplifyx-post-id="${POST_1}"]`);
    await expect(popover).toBeVisible();
    // Geometry in ONE atomic snapshot (evaluate does not pierce shadow roots — traverse manually):
    // the 300px panel sits 6px below the chip, left-aligned to it (scrollY is 0 here).
    const geometry = await page.evaluate((id: string) => {
      const panel = document.getElementById('amplifyx-target-popover-host')?.shadowRoot?.querySelector('[data-testid="amplifyx-target-popover"]');
      const panelRect = panel?.getBoundingClientRect();
      for (const host of document.querySelectorAll('[data-amplifyx-host="badge"]')) {
        const badge = host.shadowRoot?.querySelector(`[data-testid="amplifyx-target-badge"][data-amplifyx-post-id="${id}"]`);
        if (!badge) continue;
        const chipRect = badge.getBoundingClientRect();
        return {
          chipTop: chipRect.top,
          chipBottom: chipRect.bottom,
          chipLeft: chipRect.left,
          panelTop: panelRect?.top ?? null,
          panelLeft: panelRect?.left ?? null,
          panelWidth: panelRect?.width ?? null,
        };
      }
      return null;
    }, POST_1);
    expect(geometry).not.toBeNull();
    expect(geometry!.panelWidth).toBe(300);
    // 6px below the chip, left-aligned to it (rounded to whole px — sub-pixel tolerance).
    expect(Math.abs(geometry!.panelTop! - (geometry!.chipBottom + 6))).toBeLessThan(1.5);
    expect(Math.abs(geometry!.panelLeft! - geometry!.chipLeft)).toBeLessThan(1.5);
    await expect(popover.locator('[data-testid="amplifyx-popover-local-score"]')).toHaveText(
      String(await badge1.locator(BADGE_SCORE).textContent()),
    );
    const headlineStyle = await popover.locator('[data-testid="amplifyx-popover-local-score"]').evaluate((el) => {
      const style = getComputedStyle(el);
      return { size: style.fontSize, weight: style.fontWeight, numeric: style.fontVariantNumeric };
    });
    expect(headlineStyle).toEqual({ size: '22px', weight: '800', numeric: 'tabular-nums' });
    await expect(popover.locator('[data-testid="amplifyx-popover-title"]')).toHaveText('Reply target');
    await expect(popover.locator('[data-testid="amplifyx-popover-caption"]')).toHaveText('local signals · @ana_builds');
    const closeBox = await popover.locator('[data-testid="amplifyx-popover-close"]').boundingBox();
    expect(closeBox!.height).toBe(28);
    await expect(popover.locator('[data-testid="amplifyx-popover-ai-notice"]')).toHaveText('AI judgment, once, cached');
    await expect(popover.locator(DEEP_ANALYSIS)).toHaveText('Deep analysis');

    // Viewport clamp: a narrow viewport pushes the popover's left edge to the 8px margin.
    await page.setViewportSize({ width: 360, height: 800 });
    await expect(popover).toBeVisible();
    const clampedBox = await popover.boundingBox();
    expect(clampedBox!.width).toBe(300);
    expect(clampedBox!.x).toBeGreaterThanOrEqual(8);
    expect(clampedBox!.x + clampedBox!.width).toBeLessThanOrEqual(360 - 8);
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });
});
