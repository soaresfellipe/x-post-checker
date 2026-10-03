import type { BrowserContext, Page } from '@playwright/test';
import { expect, FIXTURE_URL, test } from './extension';
import { ALL_POSTS, EXTENDED_POSTS, FIXTURE_POSTS, FOLLOWING_IDS } from '../fixtures/x-fixture';

const SCANNER_HOST = '#amplifyx-marker-host';

interface PostDiagnostic {
  id: string;
  replyCount: number | null;
  repostCount: number | null;
  likeCount: number | null;
}

/** Opens the fixture and waits for BOTH the watcher and the scanner to be live. */
async function openFixture(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator(SCANNER_HOST)).toHaveAttribute('data-watcher-state', 'watching');
  await expect(page.locator(SCANNER_HOST)).toHaveAttribute('data-scanner-state', 'scanning');
  return page;
}

/** The scanner's LAST-pass diagnostics: visible posts in article order, ids + counts. */
async function scannedPosts(page: Page): Promise<PostDiagnostic[]> {
  const raw = await page.locator(SCANNER_HOST).getAttribute('data-scanner-posts');
  return raw ? (JSON.parse(raw) as PostDiagnostic[]) : [];
}

async function scannedIds(page: Page): Promise<string[]> {
  return (await scannedPosts(page)).map((post) => post.id);
}

async function dispatchCount(page: Page): Promise<number> {
  return Number(await page.locator(SCANNER_HOST).getAttribute('data-scanner-dispatches') ?? 0);
}

/** Scrolls the page to the bottom repeatedly so scroll-driven fixture behavior settles. */
async function scrollToBottom(page: Page, rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(400); // past the scanner throttle: the last pass has stamped
}

const fixtureEpoch = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __fixtureEpoch: number }).__fixtureEpoch);

test.describe('timeline scanner (fixture E2E)', () => {
  test('scans visible posts on load with digits-only counts; off-screen posts wait for scroll (VAL-TARGET-001)', async ({ context }) => {
    const page = await openFixture(context);

    // Only the above-the-fold prefix of the stacked timeline is scanned...
    const before = await scannedPosts(page);
    const beforeIds = before.map((post) => post.id);
    expect(beforeIds.length).toBeGreaterThan(0);
    expect(beforeIds.length).toBeLessThan(FIXTURE_POSTS.length);
    expect(beforeIds).toEqual(FIXTURE_POSTS.slice(0, beforeIds.length).map((post) => post.id));
    expect(beforeIds).not.toContain(FIXTURE_POSTS[FIXTURE_POSTS.length - 1]!.id); // the last post is off-screen

    // ...and the counts come from the DIGITS in the localized (pt-BR) labels — post 1 renders
    // "45 Respostas / 12 reposts / 310 Curtidas".
    expect(before[0]).toEqual({ id: FIXTURE_POSTS[0]!.id, replyCount: 45, repostCount: 12, likeCount: 310 });

    // Scrolling reveals the off-screen posts, which are scanned then.
    await scrollToBottom(page);
    await expect.poll(() => scannedIds(page)).toContain(FIXTURE_POSTS[FIXTURE_POSTS.length - 1]!.id);
  });

  test('recycled article nodes re-diff by post id; badge hosts stay single and never go stale (VAL-TARGET-002)', async ({ context }) => {
    const page = await openFixture(context);
    const nodesBefore = await page.locator('article[data-testid="tweet"]').count();

    await scrollToBottom(page); // the fixture recycles its oldest article node per scroll step

    // The feed RECYCLED: the same number of article nodes now renders the extended posts.
    await expect(page.locator('article[data-testid="tweet"]')).toHaveCount(nodesBefore);
    const renderedIds = await page.evaluate(() =>
      [...document.querySelectorAll('article[data-testid="tweet"] a[href*="/status/"]')].map((a) =>
        (/(\d+)\/?$/.exec(a.getAttribute('href')!) ?? [])[1] ?? '',
      ),
    );
    expect(renderedIds).toContain(EXTENDED_POSTS[0]!.id); // a recycled node's new post is rendered
    expect(renderedIds).not.toContain(FIXTURE_POSTS[0]!.id); // its previous post is gone

    // The scanner's diff followed the recycling: the new ids were scanned and dispatched...
    await expect.poll(() => scannedIds(page)).toEqual(expect.arrayContaining(EXTENDED_POSTS.map((post) => post.id)));
    // ...and every new/changed id was dispatched (scoring invocations happened).
    expect(await dispatchCount(page)).toBeGreaterThanOrEqual(EXTENDED_POSTS.length);

    // No stale state: every scanned id is a CURRENTLY RENDERED post id.
    const [ids, hostCounts] = await Promise.all([
      scannedIds(page),
      page.evaluate(() =>
        [...document.querySelectorAll('article[data-testid="tweet"]')].map(
          (article) => article.querySelectorAll('[data-amplifyx-host="badge"]').length,
        ),
      ),
    ]);
    expect(ids.every((id) => renderedIds.includes(id))).toBe(true);

    // At most one badge host per article — on recycled nodes too.
    expect(hostCounts).toHaveLength(nodesBefore);
    expect(hostCounts.every((count) => count <= 1)).toBe(true);
  });

  test('rescans all four timeline routes via SPA navigation without a page reload (VAL-TARGET-003)', async ({ context }) => {
    const page = await openFixture(context);
    const epoch = await fixtureEpoch(page);
    const dispatchesAtLoad = await dispatchCount(page);
    expect(dispatchesAtLoad).toBeGreaterThan(0); // For You scanned on load

    // For You → Following (the tab swaps the timeline in place; the URL stays home). Scrolling
    // reveals the rest of the Following timeline, including its two scroll-set posts — new ids
    // here, so they were scored (at least those two dispatches happened).
    await page.getByTestId('tabFollowing').click();
    await scrollToBottom(page);
    await expect.poll(() => scannedIds(page)).toEqual(expect.arrayContaining(FOLLOWING_IDS.slice(-2)));
    expect((await scannedIds(page)).every((id) => FOLLOWING_IDS.includes(id))).toBe(true);
    const dispatchesAfterFollowing = await dispatchCount(page);
    expect(dispatchesAfterFollowing).toBeGreaterThanOrEqual(dispatchesAtLoad + 2); // 13 + 14 scored once

    // Following → profile (sidebar link, pushState — no reload). All three ana_builds posts fit
    // the viewport; two of them are profile-only posts.
    await page.getByTestId('navProfile').click();
    await expect(page.getByTestId('profileView')).toBeVisible();
    await expect.poll(() => scannedIds(page)).toEqual(
      ALL_POSTS.filter((post) => post.handle === 'ana_builds').map((post) => post.id),
    );
    expect(await dispatchCount(page)).toBe(dispatchesAfterFollowing + 2); // + profile-only 16, 17

    // Profile → search (sidebar link, pushState — no reload): the query matches three posts, two
    // of them seen for the first time.
    await page.getByTestId('navSearch').click();
    await expect(page.getByTestId('searchView')).toBeVisible();
    await expect.poll(() => scannedIds(page)).toEqual(
      ALL_POSTS.filter((post) => post.text.toLowerCase().includes('tool')).map((post) => post.id),
    );
    expect(await dispatchCount(page)).toBe(dispatchesAfterFollowing + 4); // + search-only 15, 18

    // Back home: the For You timeline scans again (its posts are known and unchanged → quiet).
    const scansBeforeHome = Number(await page.locator(SCANNER_HOST).getAttribute('data-scanner-scan-count') ?? 0);
    await page.getByTestId('navHome').click();
    await expect
      .poll(async () => Number(await page.locator(SCANNER_HOST).getAttribute('data-scanner-scan-count') ?? 0))
      .toBeGreaterThan(scansBeforeHome); // the navigation triggered a scan (throttle-bounded)
    const homeIds = await scannedIds(page);
    expect(homeIds.length).toBeGreaterThan(0);
    expect(homeIds).toEqual(FIXTURE_POSTS.slice(0, homeIds.length).map((post) => post.id));
    expect(await dispatchCount(page)).toBe(dispatchesAfterFollowing + 4); // nothing new → nothing rescored

    // No page reload happened anywhere: the load stamp survived the whole journey.
    expect(await fixtureEpoch(page)).toBe(epoch);
  });

  test('an in-place engagement-count change rescores exactly once and moves the badge, with no rescan (VAL-TARGET-004)', async ({ context }) => {
    const page = await openFixture(context);
    const postId = FIXTURE_POSTS[0]!.id;
    const badge = page.locator(`[data-testid="amplifyx-target-badge"][data-amplifyx-post-id="${postId}"]`);
    await expect(badge).toBeVisible();
    const scoreBefore = Number(await badge.locator('[data-testid="amplifyx-badge-score"]').textContent());
    const dispatchesBefore = await dispatchCount(page);
    expect(dispatchesBefore).toBeGreaterThan(0);

    // The page updates engagement counts INSIDE the existing article — the count TEXT NODE's data
    // and the button's aria-label. No childList record, no scroll, no navigation: only the
    // scanner's attribute/characterData observation can schedule the rescoring pass.
    await page.evaluate((id) => {
      const article = document.querySelector(`a[href*="/status/${id}"]`)!.closest('article')!;
      const like = article.querySelector('[data-testid="like"]')!;
      const count = like.querySelector('[data-testid="app-text-transition-container"] span')!;
      count.firstChild!.textContent = '31000';
      like.setAttribute('aria-label', '31 mil Curtidas. Curtir');
    }, postId);

    // Exactly ONE new scoring dispatch (the changed post alone — every unchanged post stays quiet,
    // so the counter increment of 1 is itself the no-rescore assertion at the integrated tier).
    await expect.poll(() => dispatchCount(page)).toBe(dispatchesBefore + 1);
    await expect.poll(async () => Number(await badge.locator('[data-testid="amplifyx-badge-score"]').textContent())).not.toBe(scoreBefore);

    // The settle window after the change stays quiet.
    await page.waitForTimeout(600);
    expect(await dispatchCount(page)).toBe(dispatchesBefore + 1);
  });
});
