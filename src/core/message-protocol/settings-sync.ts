/**
 * Receiving-side reconciliation of settings changes. Two delivery paths reach a tab or page:
 * background broadcasts (the low-latency hint; delivery order between two sendMessage calls is
 * not guaranteed) and `storage.onChanged` events (the authoritative path; fired for every
 * persisted write, so a lost or rejected broadcast still converges). Both funnel through the same
 * strictly-newer revision gate and the same apply path, so the receiver ends up at the stored
 * state whatever order the events arrive in.
 */
import { SETTINGS_KEYS, type Settings } from '@/core/settings-store/types';
import { createSettingsBroadcast, createSettingsBroadcastReceiver } from './broadcast';

/** Everything a receiver needs to know about one settings change, from either path. */
export interface SettingsSyncEvent {
  settings: Settings;
  changedKeys: string[];
  revision: number;
}

export function createSettingsSync(apply: (settings: Settings, revision: number) => void) {
  const receiver = createSettingsBroadcastReceiver();
  let appliedAny = false;

  return {
    /**
     * Feeds one change event — a broadcast envelope or a `storage.onChanged`-derived change (e.g.
     * the settings store's subscribe payload, which is structurally compatible). Returns true
     * when the event was applied. Events that changed no settings key (API-key-only writes) are
     * ignored, and every event is gated on being strictly newer than what was already applied.
     */
    accept(event: SettingsSyncEvent): boolean {
      if (!event.changedKeys.some((key) => (SETTINGS_KEYS as readonly string[]).includes(key))) return false;
      // Normalize storage changes into the broadcast envelope so both paths share one gate.
      if (!receiver.accept(createSettingsBroadcast(event.settings, event.changedKeys, event.revision))) return false;
      appliedAny = true;
      apply(event.settings, event.revision);
      return true;
    },

    /** True once any change has been applied; gates the initial read in receiving contexts. */
    hasAppliedAny(): boolean {
      return appliedAny;
    },
  };
}

export type SettingsSync = ReturnType<typeof createSettingsSync>;
