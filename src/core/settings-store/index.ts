import { browser } from 'wxt/browser';
import { createSettingsStore } from './store';
import type { SettingsBackend } from './types';

export * from './types';
export { createSettingsStore, type SettingsStore, type PageSettingsStore } from './store';

/** Store bound to `storage.local`. Never use `storage.sync`: the API key must not leave the device. */
export function createLocalSettingsStore() {
  const backend: SettingsBackend = {
    area: browser.storage.local as unknown as SettingsBackend['area'],
    onChanged: browser.storage.onChanged as unknown as SettingsBackend['onChanged'],
  };
  return createSettingsStore(backend);
}
