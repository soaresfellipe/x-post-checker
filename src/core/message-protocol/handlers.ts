/**
 * The background's request handlers. Kept out of the entrypoint so they are unit-testable with an
 * injected store/transport while the entrypoint only wires them to the real browser APIs.
 */
import { runConnectionTest } from '@/core/jev-client';
import type { SettingsStore } from '@/core/settings-store';
import { PROTOCOL_VERSION, type Handlers } from './index';

/** The slice of the connection-test runner the handler depends on (injectable for tests). */
export type ConnectionTester = typeof runConnectionTest;

export interface BackgroundHandlerDeps {
  /**
   * Must be the background's own store instance: the background is the extension's SINGLE settings
   * writer, so every `set-settings` request is serialized (and its revision stamped) through it.
   */
  store: SettingsStore;
  runConnectionTest?: ConnectionTester;
}

export function createBackgroundHandlers(deps: BackgroundHandlerDeps): Handlers {
  const { store } = deps;
  const testConnection = deps.runConnectionTest ?? runConnectionTest;
  return {
    ping: () => ({ pong: true, protocolVersion: PROTOCOL_VERSION }),
    'test-connection': async ({ attemptId, apiKey }) => {
      const typedKey = apiKey?.trim();
      const key = typedKey ? typedKey : await store.getApiKey();
      return { attemptId, result: await testConnection({ apiKey: key }) };
    },
    'set-settings': async ({ update }) => {
      // Reject non-object payloads outright; the store sanitizes everything else (unknown keys and
      // malformed values are dropped, numbers clamped) so a page can never persist garbage. The
      // reply carries the write's revision so the requesting page can order it against
      // storage-driven updates (strictly-newer gate) instead of repainting stale state.
      if (typeof update !== 'object' || update === null) throw new Error('Invalid settings update.');
      return store.setSettings(update);
    },
  };
}
