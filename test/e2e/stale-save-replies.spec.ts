import type { Page } from '@playwright/test';
import { expect, optionsUrl, popupUrl, test } from './extension';

// Only evaluated inside the extension pages; this just types the page-side calls.
declare const chrome: {
  runtime: { sendMessage: (...args: unknown[]) => unknown };
  storage: { local: { get(keys: null): Promise<Record<string, unknown>> } };
};

const storageSnapshot = (page: Page) => page.evaluate(() => chrome.storage.local.get(null));

/**
 * Delays the resolution of every `set-settings` reply in the page under test while the writes
 * themselves persist immediately — exactly the defect's window: a newer settings change lands in
 * storage (from another context), and THEN the page's own save reply resolves carrying the older
 * snapshot. Injected before the page's module scripts, so the transport patch is picked up.
 */
async function delaySetSettingsReplies(page: Page, delayMs: number): Promise<void> {
  await page.addInitScript(`
    (() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (...args) => {
        const result = original(...args);
        const isSettingsWrite = args[0] && args[0].type === 'set-settings';
        if (!isSettingsWrite || !(result instanceof Promise)) return result;
        return new Promise((resolve, reject) => {
          setTimeout(() => result.then(resolve, reject), ${delayMs});
        });
      };
    })();
  `);
}

const REPLY_DELAY = 700;
/** Longer than the reply delay, so the delayed reply has certainly resolved afterwards. */
const AFTER_REPLY = REPLY_DELAY + 400;

test.describe('stale save replies (strictly-newer revision gate on page apply paths)', () => {
  // Regression for the scrutiny round-3 blocker: a page used to repaint the snapshot carried by
  // its own save reply even when a newer write (another context) had already been applied through
  // storage.onChanged — the page then diverged from the store until the next unrelated change.
  test('a popup save reply resolving late after Options advanced the store repaints nothing stale', async ({ context }) => {
    const options = await context.newPage();
    await options.goto(await optionsUrl(context));
    await expect(options.getByTestId('key-status')).not.toBeEmpty();

    const popup = await context.newPage();
    await delaySetSettingsReplies(popup, REPLY_DELAY);
    await popup.goto(await popupUrl(context));
    await expect(popup.getByTestId('key-indicator')).not.toBeEmpty();

    // The popup writes enabled=false (revision N); its reply is still in flight.
    await popup.getByTestId('master-toggle').click();
    await expect.poll(async () => (await storageSnapshot(popup)).enabled).toBe(false);

    // Options (another context) advances the store while that reply is in flight: enabled=true.
    await options.getByTestId('pref-enabled').check();
    await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');
    // The popup already followed the newer state through its storage subscription.
    await expect(popup.getByTestId('master-toggle')).toBeChecked();

    // The stale reply (revision N, enabled=false) resolves here: it must not repaint the switch.
    await popup.waitForTimeout(AFTER_REPLY);
    await expect(popup.getByTestId('master-toggle')).toBeChecked();
    await expect(popup.getByTestId('master-label')).toHaveText('AmplifyX is on');

    // The popup and the Options page agree with the store.
    const stored = (await storageSnapshot(popup)) as { enabled?: boolean };
    expect(stored.enabled).toBe(true);
    await expect(options.getByTestId('pref-enabled')).toBeChecked();
  });

  test('an Options save reply resolving late after the popup advanced the store repaints nothing stale', async ({ context }) => {
    const options = await context.newPage();
    await delaySetSettingsReplies(options, REPLY_DELAY);
    await options.goto(await optionsUrl(context));
    await expect(options.getByTestId('key-status')).not.toBeEmpty();

    const popup = await context.newPage();
    await popup.goto(await popupUrl(context));
    await expect(popup.getByTestId('key-indicator')).not.toBeEmpty();

    // Options writes minDraftLength=40 (revision N, enabled stays true); its reply is in flight.
    await options.getByTestId('pref-minDraftLength').fill('40');
    await options.getByTestId('pref-minDraftLength').blur();
    await expect.poll(async () => (await storageSnapshot(options)).minDraftLength).toBe(40);

    // The popup (another context) advances the store while that reply is in flight: enabled=false.
    await popup.getByTestId('master-toggle').uncheck();
    await expect(popup.getByTestId('master-label')).toHaveText('AmplifyX is off');
    // The Options page already followed the newer state through its storage subscription.
    await expect(options.getByTestId('pref-enabled')).not.toBeChecked();

    // The stale reply (revision N, enabled=true) resolves here: it must not repaint the checkbox.
    await options.waitForTimeout(AFTER_REPLY);
    await expect(options.getByTestId('pref-enabled')).not.toBeChecked();
    await expect(options.getByTestId('pref-minDraftLength')).toHaveValue('40');
    // The save feedback still belongs to the page's own (successful) attempt.
    await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');

    // The Options page and the popup agree with the store.
    const stored = (await storageSnapshot(options)) as { enabled?: boolean; minDraftLength?: number };
    expect(stored.enabled).toBe(false);
    expect(stored.minDraftLength).toBe(40);
    await expect(popup.getByTestId('master-toggle')).not.toBeChecked();
  });
});
