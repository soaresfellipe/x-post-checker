import { browser } from 'wxt/browser';
import { createLocalSettingsStore } from '@/core/settings-store';
import { mountPopupPage } from '@/dom/popup';

const root = document.getElementById('app');
if (!root) throw new Error('Popup root element is missing');

void mountPopupPage(root, {
  store: createLocalSettingsStore(),
  openOptions: async () => {
    await browser.runtime.openOptionsPage();
  },
});
