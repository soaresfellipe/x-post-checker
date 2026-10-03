import { browser } from 'wxt/browser';
import { isSettingsBroadcast, type SettingsBroadcast } from './broadcast';
import { createRequest, type MessageMap, type MessageType, type Response } from './index';
import type { Settings } from '@/core/settings-store/types';

/** Sends a typed request to the background and resolves with its typed response. */
export async function sendMessage<T extends MessageType>(
  type: T,
  payload: MessageMap[T]['request'],
): Promise<Response<T>> {
  return (await browser.runtime.sendMessage(createRequest(type, payload))) as Response<T>;
}

/**
 * Writes settings through the background — the extension's single writer, which serializes writes
 * and stamps the revision atomically. Resolves with the persisted settings; rejects when the
 * write failed (nothing was changed).
 */
export async function sendSettingsUpdate(update: Partial<Settings>): Promise<Settings> {
  const response = await sendMessage('set-settings', { update });
  if (!response.ok) throw new Error(response.error);
  return response.data.settings;
}

/** Subscribes to background settings broadcasts. Returns an unsubscribe. */
export function onSettingsBroadcast(listener: (broadcast: SettingsBroadcast) => void): () => void {
  const handler = (message: unknown) => {
    if (isSettingsBroadcast(message)) listener(message);
    return false;
  };
  browser.runtime.onMessage.addListener(handler);
  return () => browser.runtime.onMessage.removeListener(handler);
}
