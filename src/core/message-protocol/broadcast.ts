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
  /**
   * Monotonic counter of the settings write this envelope reflects (persisted beside the settings
   * by the store). Delivery order between two `sendMessage` calls is not guaranteed, so receivers
   * must gate application through a `SettingsBroadcastReceiver` and drop older revisions.
   */
  revision: number;
  settings: Settings;
  changedKeys: string[];
}

export function createSettingsBroadcast(settings: Settings, changedKeys: string[], revision: number): SettingsBroadcast {
  return { v: PROTOCOL_VERSION, kind: 'broadcast', type: 'settings-changed', revision, settings, changedKeys };
}

export function isSettingsBroadcast(value: unknown): value is SettingsBroadcast {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.v === PROTOCOL_VERSION &&
    candidate.kind === 'broadcast' &&
    candidate.type === 'settings-changed' &&
    typeof candidate.revision === 'number' &&
    Number.isFinite(candidate.revision) &&
    typeof candidate.settings === 'object' &&
    candidate.settings !== null &&
    typeof (candidate.settings as Record<string, unknown>).enabled === 'boolean' &&
    Array.isArray(candidate.changedKeys)
  );
}

/**
 * The strictly-newer revision gate shared by every settings receiver: tracks the highest revision
 * applied so far and accepts only strictly newer ones, whatever order the transport delivers in.
 * The broadcast receiver gates tab envelopes with it, and the popup/Options pages gate every
 * settings snapshot they are offered (initial read, storage subscriptions, save replies).
 */
export function createRevisionGate() {
  let lastAppliedRevision: number | undefined;
  return {
    /** True when `revision` is strictly newer than everything applied so far (and records it). */
    accept(revision: number): boolean {
      if (lastAppliedRevision !== undefined && revision <= lastAppliedRevision) return false;
      lastAppliedRevision = revision;
      return true;
    },
  };
}

/**
 * Receiver-side guard against out-of-order delivery: a delayed "off" broadcast (from a rapid off/on
 * toggle) must never overwrite the newer "on" a tab already applied. Tracks the highest applied
 * revision and accepts only strictly newer envelopes, whatever order the transport delivers in.
 */
export function createSettingsBroadcastReceiver() {
  const gate = createRevisionGate();
  return {
    /** True when `broadcast` is newer than everything applied so far (and records it). */
    accept(broadcast: SettingsBroadcast): boolean {
      return gate.accept(broadcast.revision);
    },
  };
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
