/**
 * Fixture-contract E2E (m6-theme-foundation-and-realx-probe): pins the fixture shapes the M6
 * probe verified live on real x.com (`library/x-dom.md`, m6 insertion probe facts 1-2 and 4e):
 *  - BOTH composers (home + status-page inline reply) keep the toolBar in a SIBLING subtree of
 *    the editor's tight text-row wrapper — the in-flow status row inserts as the toolBar's
 *    immediate preceding sibling;
 *  - User-Name has exactly two NATIVE children with the status link + <time> chain LAST, plus the
 *    extension-owned badge host (marker attribute, design-1b §7) as the LAST child after paint;
 *  - the body background is switchable inline (the way X really renders it) via __fixtureSetTheme.
 */
import { BADGE_HOST_ATTRIBUTE, BADGE_HOST_VALUE } from '../../src/dom/timeline-scanner/scanner';
import { expect, FIXTURE_URL, test } from './extension';

/** A status URL from the fixture's post data (same shape composer-watcher.spec.ts uses). */
const STATUS_URL = `${FIXTURE_URL}joaodev/status/1800000000000000002`;

test.describe('fixture mirrors the real composer/User-Name nesting (m6 probe facts)', () => {
  test('home composer: toolBar is a sibling subtree, not an editor ancestor', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
    const shape = await page.evaluate(() => {
      const editor = document.querySelector('div[data-testid="tweetTextarea_0"]');
      const toolBar = document.querySelector('[data-testid="toolBar"]');
      if (!editor || !toolBar) return null;
      const ancestors = (e: Element): Element[] => {
        const out: Element[] = [];
        for (let a = e.parentElement; a; a = a.parentElement) out.push(a);
        return out;
      };
      const common = ancestors(editor).find((a) => ancestors(toolBar).includes(a)) ?? null;
      return {
        toolBarAncestorOfEditor: toolBar.contains(editor),
        commonExists: common !== null,
        toolBarParentIsCommon: common !== null && toolBar.parentElement === common,
      };
    });
    expect(shape).not.toBeNull();
    expect(shape!.toolBarAncestorOfEditor).toBe(false);
    expect(shape!.commonExists).toBe(true);
    expect(shape!.toolBarParentIsCommon).toBe(true);
  });

  test('status-page reply composer: own toolBar in the same sibling shape', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(STATUS_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="statusView"]')).toBeVisible();
    const shape = await page.evaluate(() => {
      const editor = document.querySelector('[data-testid="statusView"] div[data-testid="tweetTextarea_0"]');
      const toolBars = [...document.querySelectorAll('[data-testid="toolBar"]')];
      const toolBar = toolBars.find((t) => !t.contains(editor ?? null)) ?? null;
      if (!editor || !toolBar) return null;
      const region = editor.closest('[data-testid$="RichTextInputContainer"]')?.parentElement ?? null;
      return {
        toolBarPresent: true,
        toolBarAncestorOfEditor: toolBar.contains(editor),
        regionHoldsOnlyComposerTestids:
          region !== null &&
          [...region.querySelectorAll('[data-testid]')].every((e) =>
            /^tweetTextarea_0(RichTextInputContainer)?$/.test(e.getAttribute('data-testid') ?? ''),
          ),
        furnitureInsideToolBar: toolBar.querySelector('[data-testid="tweetButtonInline"]') !== null,
      };
    });
    expect(shape).not.toBeNull();
    expect(shape!.toolBarAncestorOfEditor).toBe(false);
    expect(shape!.regionHoldsOnlyComposerTestids).toBe(true);
    expect(shape!.furnitureInsideToolBar).toBe(true);
  });

  test('User-Name: two native children, status link + time chain in the second, badge host last', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });

    // The M6 badge controller appends its extension-owned host INSIDE the first article's
    // User-Name (design-1b §7) after the scanner paints. Waiting for it makes the sampled
    // anatomy stable instead of racing the scanner (2 children before paint, 3 after). If it
    // never paints, badge placement itself is broken — a real defect, not a skip.
    try {
      await page
        .locator('article')
        .first()
        .locator(`[data-testid="User-Name"] [${BADGE_HOST_ATTRIBUTE}="${BADGE_HOST_VALUE}"]`)
        .waitFor({ state: 'attached', timeout: 15_000 });
    } catch {
      throw new Error(
        `badge host ([${BADGE_HOST_ATTRIBUTE}="${BADGE_HOST_VALUE}"]) never painted inside the first article's User-Name within 15s — design-1b §7 badge placement is broken, not the fixture anatomy`,
      );
    }

    // Partition User-Name's children into native nodes vs extension-owned hosts (design-1b §7
    // appends one inside User-Name). The native contract is unchanged — exactly
    // two native children with the status link + <time> chain inside the SECOND native child —
    // and the extension host must be User-Name's LAST child (design-1b §7 placement).
    // Extension-owned hosts carry the scanner's OWN marker (imported, never duplicated here) —
    // never a tag/class heuristic. Partition: native fixture nodes vs extension hosts.
    const hostMarker: [string, string] = [BADGE_HOST_ATTRIBUTE, BADGE_HOST_VALUE];
    const shape = await page.evaluate(
      ([hostAttr, hostValue]: [string, string]) => {
        const name = document.querySelector('article [data-testid="User-Name"]');
        if (!name) return null;
        const isExtensionHost = (e: Element) => e.getAttribute(hostAttr) === hostValue;
        const native = [...name.children].filter((c) => !isExtensionHost(c));
        const hosts = [...name.children].filter(isExtensionHost);
        const timeLink = name.querySelector('a[href*="/status/"] time');
        return {
          nativeCount: native.length,
          timePresent: timeLink !== null,
          timeInsideSecondNativeChild: native[1]?.contains(timeLink) ?? false,
          timeLinkIsLastChain: Boolean(timeLink?.closest('a')),
          hostCount: hosts.length,
          hostIsLastChild: hosts.length === 1 && hosts[0] === name.lastElementChild,
        };
      },
      hostMarker,
    );
    expect(shape).not.toBeNull();
    expect(shape!.nativeCount).toBe(2);
    expect(shape!.timePresent).toBe(true);
    expect(shape!.timeInsideSecondNativeChild).toBe(true);
    expect(shape!.timeLinkIsLastChain).toBe(true);
    expect(shape!.hostCount).toBe(1);
    expect(shape!.hostIsLastChild).toBe(true);
  });
});
