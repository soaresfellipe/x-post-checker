/**
 * Versioned request/response contract between content scripts (and extension pages) and the
 * background. Add a new message by extending `MessageMap`; handlers and clients stay type-checked.
 */
import type { ConnectionTestResult } from '@/core/jev-client/connection-test';

export const PROTOCOL_VERSION = 1;

export interface MessageMap {
  ping: {
    request: Record<string, never>;
    response: { pong: true; protocolVersion: number };
  };
  'test-connection': {
    /** Key typed in the Options field; when omitted the saved key is tested. */
    request: { attemptId: string; apiKey?: string };
    /** Echoes `attemptId` so the page can discard results from superseded attempts. */
    response: { attemptId: string; result: ConnectionTestResult };
  };
}

export type MessageType = keyof MessageMap;

export interface Request<T extends MessageType = MessageType> {
  v: typeof PROTOCOL_VERSION;
  type: T;
  payload: MessageMap[T]['request'];
}

export type Response<T extends MessageType = MessageType> =
  | { ok: true; data: MessageMap[T]['response'] }
  | { ok: false; error: string };

export type Handlers = {
  [T in MessageType]: (payload: MessageMap[T]['request']) => MessageMap[T]['response'] | Promise<MessageMap[T]['response']>;
};

const MESSAGE_TYPES: readonly string[] = ['ping', 'test-connection'] satisfies MessageType[];

export function createRequest<T extends MessageType>(type: T, payload: MessageMap[T]['request']): Request<T> {
  return { v: PROTOCOL_VERSION, type, payload };
}

export function isRequest(value: unknown): value is Request {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.v === PROTOCOL_VERSION &&
    typeof candidate.type === 'string' &&
    MESSAGE_TYPES.includes(candidate.type) &&
    'payload' in candidate
  );
}

export async function handleRequest<T extends MessageType>(
  request: Request<T>,
  handlers: Handlers,
): Promise<Response<T>> {
  try {
    const handler = handlers[request.type] as (payload: Request<T>['payload']) => Promise<MessageMap[T]['response']> | MessageMap[T]['response'];
    return { ok: true, data: await handler(request.payload) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
