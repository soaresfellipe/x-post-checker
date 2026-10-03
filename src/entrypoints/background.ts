import { runConnectionTest } from '@/core/jev-client';
import { createLocalSettingsStore } from '@/core/settings-store';
import { broadcastToTabs, createSettingsBroadcast } from '@/core/message-protocol/broadcast';
import { SETTINGS_KEYS } from '@/core/settings-store';
import { PROTOCOL_VERSION, handleRequest, isRequest, type Handlers } from '@/core/message-protocol';

const handlers: Handlers = {
  ping: () => ({ pong: true, protocolVersion: PROTOCOL_VERSION }),
  'test-connection': async ({ attemptId, apiKey }) => {
    const typedKey = apiKey?.trim();
    const key = typedKey ? typedKey : await createLocalSettingsStore().getApiKey();
    return { attemptId, result: await runConnectionTest({ apiKey: key }) };
  },
};

export default defineBackground(() => {
  // Registered synchronously: Chrome's service worker and Firefox's event page are both
  // suspended and restarted, so no listener may depend on module-level state.
  browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isRequest(message)) return false;
    void handleRequest(message, handlers).then(sendResponse);
    return true;
  });

  // Also registered synchronously so a storage change wakes a suspended worker. The popup and
  // Options page only write storage; this is the single place that fans changes out to tabs.
  // The envelope carries the write's revision so tabs can reject out-of-order deliveries.
  createLocalSettingsStore().subscribe(({ settings, changedKeys, revision }) => {
    const settingsKeys = changedKeys.filter((key) => (SETTINGS_KEYS as readonly string[]).includes(key));
    if (settingsKeys.length === 0) return;
    void broadcastToTabs(browser.tabs, createSettingsBroadcast(settings, settingsKeys, revision));
  });
});
