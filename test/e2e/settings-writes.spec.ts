import type { BrowserContext, Page } from '@playwright/test';
import { expect, FIXTURE_URL, optionsUrl, popupUrl, test } from './extension';

const MARKER_HOST = '#amplifyx-marker-host';
const MARKER = '#amplifyx-marker-host [data-testid="amplifyx-marker"]';

// Only evaluated inside the extension page; this just types the page-side calls.
declare const chrome: {
  storage: { local: { get(keys: null): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> } };
};

const storageSnapshot = (page: Page) => page.evaluate(() => chrome.storage.local.get(null));

async function openPage(context: BrowserContext, url: Promise<string>): Promise<Page> {
  const page = await context.newPage();
  await page.goto(await url);
  return page;
}

test.describe('cross-context settings writes (background single writer)', () => {
  // Regression for the round-2 scrutiny blocker: popup and Options are independent contexts that
  // used to write storage directly, so both could compute and persist the SAME settingsRevision
  // and a tab then rejected the final broadcast as a duplicate, diverging from the store.
  // Now every write from either page travels through the background's single writer, and the
  // storage.onChanged path in the tab reconciles whatever a lost or rejected broadcast skips.
  test('interleaved writes from popup and Options keep every tab and the store converged', async ({ context }) => {
    const fixture1 = await context.newPage();
    await fixture1.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
    const fixture2 = await context.newPage();
    await fixture2.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
    await expect(fixture1.locator(MARKER)).toHaveAttribute('data-background', 'connected');
    await expect(fixture2.locator(MARKER)).toHaveAttribute('data-background', 'connected');

    const options = await openPage(context, optionsUrl(context));
    await expect(options.getByTestId('key-status')).not.toBeEmpty();
    const popup = await openPage(context, popupUrl(context));
    await expect(popup.getByTestId('key-indicator')).not.toBeEmpty();

    // Part A: alternating writers on different keys, each awaited only to its visible completion.
    await popup.getByTestId('master-toggle').click(); // write 1: enabled -> false
    await expect(popup.getByTestId('master-label')).toHaveText('AmplifyX is off');
    await options.getByTestId('pref-minDraftLength').fill('40'); // write 2: minDraftLength -> 40
    await options.getByTestId('pref-minDraftLength').blur();
    await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');
    await popup.getByTestId('master-toggle').click(); // write 3: enabled -> true
    await expect(popup.getByTestId('master-label')).toHaveText('AmplifyX is on');
    await options.getByTestId('pref-minDraftLength').fill('25'); // write 4: minDraftLength -> 25
    await options.getByTestId('pref-minDraftLength').blur();
    await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');

    // Part B: alternating writers racing on the SAME key (the former collision scenario).
    await popup.getByTestId('master-toggle').click(); // write 5: enabled -> false
    await expect(fixture1.locator(MARKER_HOST)).toHaveCount(0);
    await options.getByTestId('pref-enabled').click(); // write 6: enabled -> true
    await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');
    await expect(fixture1.locator(MARKER)).toBeVisible();
    await popup.getByTestId('master-toggle').click(); // write 7: enabled -> false
    await expect(fixture2.locator(MARKER_HOST)).toHaveCount(0);
    await options.getByTestId('pref-enabled').click(); // write 8: enabled -> true (final)
    await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');

    const stored = await storageSnapshot(popup);
    // Exactly one revision per write: unique and monotonically increasing across contexts.
    // (Unwritten settings legitimately have no storage entry — defaults are applied on read.)
    expect(stored.settingsRevision).toBe(8);
    expect(stored.enabled).toBe(true);
    expect(stored.minDraftLength).toBe(25);

    // Every tab ends on the store's final revision with the final state applied — i.e. the final
    // broadcast was applied, never rejected as a duplicate of an earlier write.
    await expect(fixture1.locator(MARKER_HOST)).toHaveAttribute('data-settings-revision', '8');
    await expect(fixture2.locator(MARKER_HOST)).toHaveAttribute('data-settings-revision', '8');
    await expect(fixture1.locator(MARKER)).toHaveAttribute('data-background', 'connected');
    await expect(fixture2.locator(MARKER)).toHaveAttribute('data-background', 'connected');

    // The pages agree with the store too.
    await expect(popup.getByTestId('master-toggle')).toBeChecked();
    await expect(popup.getByTestId('master-label')).toHaveText('AmplifyX is on');
    await expect(options.getByTestId('pref-enabled')).toBeChecked();
    await expect(options.getByTestId('pref-minDraftLength')).toHaveValue('25');
  });

  // Belt-and-braces: a settings write whose broadcast never reaches a tab (the write is persisted
  // but tabs.sendMessage fails, or the tab applies a rejected envelope) must still converge via
  // the authoritative chrome.storage.onChanged path. A direct storage write from a page produces
  // exactly that situation for the tab: only the storage change is guaranteed.
  test('a tab converges through storage events when no broadcast arrives', async ({ context }) => {
    const fixture = await context.newPage();
    await fixture.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
    await expect(fixture.locator(MARKER)).toHaveAttribute('data-background', 'connected');
    const popup = await openPage(context, popupUrl(context));
    await expect(popup.getByTestId('key-indicator')).not.toBeEmpty();

    // Bypass the background writer but keep the revision contract (strictly newer than stored).
    const writeDirectly = (revision: number, enabled: boolean) =>
      popup.evaluate(([rev, on]) => chrome.storage.local.set({ enabled: on, settingsRevision: rev }), [revision, enabled] as const);

    const { settingsRevision } = (await storageSnapshot(popup)) as { settingsRevision?: number };
    const next = (settingsRevision ?? 0) + 1;

    await writeDirectly(next, false);
    await expect(fixture.locator(MARKER_HOST)).toHaveCount(0);
    await expect(popup.getByTestId('master-toggle')).not.toBeChecked();

    await writeDirectly(next + 1, true);
    await expect(fixture.locator(MARKER_HOST)).toHaveAttribute('data-settings-revision', String(next + 1));
    await expect(popup.getByTestId('master-toggle')).toBeChecked();
  });
});
