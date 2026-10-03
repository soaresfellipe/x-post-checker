import { browser } from 'wxt/browser';
import { isSettingsBroadcast, type SettingsBroadcast } from './broadcast';
import { createRequest, type MessageMap, type MessageType, type Response } from './index';

/** Sends a typed request to the background and resolves with its typed response. */
export async function sendMessage<T extends MessageType>(
  type: T,
  payload: MessageMap[T]['request'],
): Promise<Response<T>> {
  return (await browser.runtime.sendMessage(createRequest(type, payload))) as Response<T>;
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
