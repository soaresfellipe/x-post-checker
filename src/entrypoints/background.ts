import { createLocalSettingsStore } from '@/core/settings-store';
import { broadcastToTabs, createSettingsBroadcast } from '@/core/message-protocol/broadcast';
import { SETTINGS_KEYS } from '@/core/settings-store';
import { handleRequest, isRequest } from '@/core/message-protocol';
import { createBackgroundHandlers } from '@/core/message-protocol/handlers';

export default defineBackground(() => {
  // ONE store instance for the whole background: it is the extension's SINGLE settings writer.
  // Popup and Options no longer write storage directly — they send `set-settings` requests, which
  // this store serializes and stamps with the revision in the same storage write. (Its listeners
  // are registered synchronously below: Chrome's service worker and Firefox's event page are both
  // suspended and restarted, so no listener may depend on module-level state.)
  const store = createLocalSettingsStore();
  const handlers = createBackgroundHandlers({ store });

  browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isRequest(message)) return false;
    void handleRequest(message, handlers).then(sendResponse);
    return true;
  });

  // Fans every persisted settings change out to tabs as a low-latency hint. The envelope carries
  // the write's revision so tabs can reject out-of-order deliveries; the authoritative
  // reconciliation path is storage.onChanged, which fires in each tab regardless of this delivery.
  store.subscribe(({ settings, changedKeys, revision }) => {
    const settingsKeys = changedKeys.filter((key) => (SETTINGS_KEYS as readonly string[]).includes(key));
    if (settingsKeys.length === 0) return;
    void broadcastToTabs(browser.tabs, createSettingsBroadcast(settings, settingsKeys, revision));
  });
});
