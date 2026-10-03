import { browser } from 'wxt/browser';
import { createLocalSettingsStore } from '@/core/settings-store';
import { sendSettingsUpdate } from '@/core/message-protocol/client';
import { mountPopupPage } from '@/dom/popup';

const root = document.getElementById('app');
if (!root) throw new Error('Popup root element is missing');

void mountPopupPage(root, {
  store: createLocalSettingsStore(),
  // Settings writes are background-only (single writer); the popup requests them by message.
  saveSettings: sendSettingsUpdate,
  openOptions: async () => {
    await browser.runtime.openOptionsPage();
  },
});
