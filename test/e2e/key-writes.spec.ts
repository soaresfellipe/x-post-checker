import type { Page } from '@playwright/test';
import { expect, optionsUrl, popupUrl, test } from './extension';

const SYNTHETIC_KEY = 'key-lane-e2e-0001';

// Only evaluated inside the extension page; this just types the page-side calls.
declare const chrome: {
  storage: { local: { get(keys: null): Promise<Record<string, unknown>> } };
};

const storageSnapshot = (page: Page) => page.evaluate(() => chrome.storage.local.get(null));

/**
 * Delays the resolution of every `set-api-key` reply in the page under test while the writes
 * themselves persist immediately in the background — the round-6 defect's window: a newer key
 * change lands in storage, and THEN the page's own save reply resolves carrying the older
 * presence fact. Injected before the page's module scripts, so the transport patch is picked up.
 */
async function delaySetApiKeyReplies(page: Page, delayMs: number): Promise<void> {
  await page.addInitScript(`
    (() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (...args) => {
        const result = original(...args);
        const isKeyWrite = args[0] && args[0].type === 'set-api-key';
        if (!isKeyWrite || !(result instanceof Promise)) return result;
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

test.describe('key writes (background single writer + keyRevision gate)', () => {
  // Key saves and removals are background-routed like settings writes, so the stamped keyRevision
  // is authoritative; both pages follow every write through storage and end where storage is.
  test('a key save and removal stamp an ordered keyRevision and both pages converge', async ({ context }) => {
    const options = await context.newPage();
    await options.goto(await optionsUrl(context));
    await expect(options.getByTestId('key-status')).toHaveAttribute('data-state', 'absent');

    const popup = await context.newPage();
    await popup.goto(await popupUrl(context));
    await expect(popup.getByTestId('key-indicator')).toHaveAttribute('data-state', 'missing');

    await options.getByTestId('api-key-input').fill(SYNTHETIC_KEY);
    await options.getByTestId('save-key').click();

    // The write persisted with keyRevision 1, and both pages followed it through storage.
    await expect.poll(async () => (await storageSnapshot(options)).keyRevision).toBe(1);
    expect((await storageSnapshot(options)).jevApiKey).toBe(SYNTHETIC_KEY);
    await expect(options.getByTestId('key-status')).toHaveAttribute('data-state', 'present');
    await expect(popup.getByTestId('key-indicator')).toHaveAttribute('data-state', 'present');
    await expect(popup.getByTestId('key-indicator')).toHaveText('Saved');

    await options.getByTestId('remove-key').click();

    // The removal persisted with keyRevision 2, and both pages followed it too.
    await expect.poll(async () => (await storageSnapshot(options)).keyRevision).toBe(2);
    expect((await storageSnapshot(options)).jevApiKey).toBe('');
    await expect(options.getByTestId('key-status')).toHaveAttribute('data-state', 'absent');
    await expect(popup.getByTestId('key-indicator')).toHaveAttribute('data-state', 'missing');
  });

  // Regression (scrutiny round 6, E2E flavor of the validator's scenario): the key-save reply is
  // delayed past a removal. The save's storage event already applied present@1; the removal then
  // applies absent@2; the late save reply carries present@1 and must be REJECTED by the
  // keyRevision gate — the page ends absent, matching storage, whatever the completion order.
  test('a delayed key-save reply resolving after a removal repaints nothing stale', async ({ context }) => {
    const options = await context.newPage();
    await delaySetApiKeyReplies(options, REPLY_DELAY);
    await options.goto(await optionsUrl(context));
    await expect(options.getByTestId('key-status')).toHaveAttribute('data-state', 'absent');

    // The save persists immediately (keyRevision 1); its reply is still in flight. The page
    // already followed the write through its storage subscription.
    await options.getByTestId('api-key-input').fill(SYNTHETIC_KEY);
    await options.getByTestId('save-key').click();
    await expect.poll(async () => (await storageSnapshot(options)).keyRevision).toBe(1);
    await expect(options.getByTestId('key-status')).toHaveAttribute('data-state', 'present');

    // A newer key write (the removal, keyRevision 2) lands while the save reply is in flight.
    await options.getByTestId('remove-key').click();
    await expect.poll(async () => (await storageSnapshot(options)).keyRevision).toBe(2);
    await expect(options.getByTestId('key-status')).toHaveAttribute('data-state', 'absent');

    // The stale save reply (present@1) resolves here: it must not repaint presence.
    await options.waitForTimeout(AFTER_REPLY);
    await expect(options.getByTestId('key-status')).toHaveAttribute('data-state', 'absent');
    expect((await storageSnapshot(options)).jevApiKey).toBe('');

    // A popup opened now agrees with storage, not with the late reply.
    const popup = await context.newPage();
    await popup.goto(await popupUrl(context));
    await expect(popup.getByTestId('key-indicator')).toHaveAttribute('data-state', 'missing');
  });
});
