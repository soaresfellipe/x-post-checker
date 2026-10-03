import { createLocalSettingsStore } from '@/core/settings-store';
import { sendMessage, sendClearApiKey, sendSetApiKey, sendSettingsUpdate } from '@/core/message-protocol/client';
import { mountOptionsPage } from '@/dom/options';
import { isE2EBuild } from '@/core/test-hooks';

const root = document.getElementById('app');
if (!root) throw new Error('Options root element is missing');

void mountOptionsPage(root, {
  store: createLocalSettingsStore(),
  // ALL writes are background-only (single writer); the page requests them by message.
  saveSettings: sendSettingsUpdate,
  saveApiKey: sendSetApiKey,
  removeApiKey: sendClearApiKey,
  testConnection: async (attemptId, apiKey) => {
    const response = await sendMessage('test-connection', { attemptId, ...(apiKey ? { apiKey } : {}) });
    if (!response.ok) throw new Error(response.error);
    return response.data;
  },
}).then(() => {
  // E2E builds only: announce a successful Options mount to the fixture harness (the Firefox
  // smoke harness cannot open extension pages itself — Marionette is barred from moz-extension).
  if (isE2EBuild()) {
    void fetch('http://localhost:3177/__e2e/beacon?surface=options').catch(() => {});
  }
});
