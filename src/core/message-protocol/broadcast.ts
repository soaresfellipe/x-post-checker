/**
 * Background -> content-script push channel. Unlike request/response messages these are one-way
 * and fan out to every tab, so a content script can react to a settings change without a reload.
 */
import { PROTOCOL_VERSION } from './index';
import type { Settings } from '@/core/settings-store/types';

export interface SettingsBroadcast {
  v: typeof PROTOCOL_VERSION;
  kind: 'broadcast';
  type: 'settings-changed';
  settings: Settings;
  changedKeys: string[];
}

export function createSettingsBroadcast(settings: Settings, changedKeys: string[]): SettingsBroadcast {
  return { v: PROTOCOL_VERSION, kind: 'broadcast', type: 'settings-changed', settings, changedKeys };
}

export function isSettingsBroadcast(value: unknown): value is SettingsBroadcast {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.v === PROTOCOL_VERSION &&
    candidate.kind === 'broadcast' &&
    candidate.type === 'settings-changed' &&
    typeof candidate.settings === 'object' &&
    candidate.settings !== null &&
    typeof (candidate.settings as Record<string, unknown>).enabled === 'boolean' &&
    Array.isArray(candidate.changedKeys)
  );
}

/** The slice of `browser.tabs` the broadcaster depends on. */
export interface TabsApi {
  query(info: Record<string, never>): Promise<Array<{ id?: number }>>;
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
}

/**
 * Delivers `message` to every tab. Tabs without a listener (browser pages, tabs opened before the
 * content script was injected) reject; that is expected and never aborts delivery to the others.
 * Resolves with the number of tabs that accepted the message.
 */
export async function broadcastToTabs(tabs: TabsApi, message: SettingsBroadcast): Promise<number> {
  const all = await tabs.query({});
  const results = await Promise.allSettled(
    all.flatMap((tab) => (tab.id === undefined ? [] : [tabs.sendMessage(tab.id, message)])),
  );
  return results.filter((result) => result.status === 'fulfilled').length;
}
