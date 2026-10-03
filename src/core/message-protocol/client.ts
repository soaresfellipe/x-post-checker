import { browser } from 'wxt/browser';
import { createRequest, type MessageMap, type MessageType, type Response } from './index';

/** Sends a typed request to the background and resolves with its typed response. */
export async function sendMessage<T extends MessageType>(
  type: T,
  payload: MessageMap[T]['request'],
): Promise<Response<T>> {
  return (await browser.runtime.sendMessage(createRequest(type, payload))) as Response<T>;
}
