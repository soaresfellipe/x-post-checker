import { runConnectionTest } from '@/core/jev-client';
import { createLocalSettingsStore } from '@/core/settings-store';
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
});
