import { describe, expect, it } from 'vitest';
import { createSettingsBroadcast, type SettingsBroadcast } from '@/core/message-protocol/broadcast';
import { createSettingsSync } from '@/core/message-protocol/settings-sync';
import { DEFAULT_SETTINGS, type Settings } from '@/core/settings-store';

const SETTINGS = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

function broadcast(over: Partial<Settings>, changedKeys: string[], revision: number): SettingsBroadcast {
  return createSettingsBroadcast(SETTINGS(over), changedKeys, revision);
}

function storageEvent(over: Partial<Settings>, changedKeys: string[], revision: number) {
  return { settings: SETTINGS(over), changedKeys, revision };
}

/** Collects the (revision, enabled) pairs the sync applied, in order. */
function harness() {
  const applied: Array<{ revision: number; enabled: boolean }> = [];
  const sync = createSettingsSync((settings, revision) => {
    applied.push({ revision, enabled: settings.enabled });
  });
  return { sync, applied };
}

describe('settings sync (broadcast + storage reconciliation)', () => {
  it('applies broadcast envelopes through the strictly-newer gate', () => {
    const { sync, applied } = harness();
    expect(sync.accept(broadcast({ enabled: false }, ['enabled'], 1))).toBe(true);
    expect(sync.accept(broadcast({ enabled: true }, ['enabled'], 2))).toBe(true);
    expect(applied).toEqual([
      { revision: 1, enabled: false },
      { revision: 2, enabled: true },
    ]);
  });

  it('drops delayed and duplicate broadcasts', () => {
    const { sync, applied } = harness();
    expect(sync.accept(broadcast({ enabled: true }, ['enabled'], 2))).toBe(true);
    expect(sync.accept(broadcast({ enabled: false }, ['enabled'], 1))).toBe(false);
    expect(sync.accept(broadcast({ enabled: true }, ['enabled'], 2))).toBe(false);
    expect(applied).toEqual([{ revision: 2, enabled: true }]);
  });

  // Belt-and-braces: the storage event is the authoritative path. When a broadcast is lost or
  // rejected, the storage change for the same write must still be applied.
  it('applies a storage-only change even though no broadcast ever delivered it', () => {
    const { sync, applied } = harness();
    expect(sync.accept(storageEvent({ enabled: false }, ['enabled'], 3))).toBe(true);
    expect(applied).toEqual([{ revision: 3, enabled: false }]);
  });

  it('gates storage changes through the same revision gate as broadcasts', () => {
    const { sync, applied } = harness();
    // A newer broadcast lands first; the older storage event must not regress the tab.
    expect(sync.accept(broadcast({ enabled: true }, ['enabled'], 5))).toBe(true);
    expect(sync.accept(storageEvent({ enabled: false }, ['enabled'], 4))).toBe(false);
    // And a newer storage event still applies after it.
    expect(sync.accept(storageEvent({ enabled: false }, ['enabled'], 6))).toBe(true);
    expect(applied).toEqual([
      { revision: 5, enabled: true },
      { revision: 6, enabled: false },
    ]);
  });

  it('converges interleaved broadcast and storage deliveries of the same writes', () => {
    const { sync, applied } = harness();
    // Both paths deliver every write, in arbitrary relative order; the gate keeps exactly the
    // newest state, so the final application equals the stored one.
    expect(sync.accept(storageEvent({ enabled: false }, ['enabled'], 1))).toBe(true);
    expect(sync.accept(broadcast({ enabled: true }, ['enabled'], 2))).toBe(true);
    expect(sync.accept(storageEvent({ enabled: true }, ['enabled'], 2))).toBe(false);
    expect(sync.accept(broadcast({ enabled: false }, ['enabled'], 1))).toBe(false);
    expect(applied).toEqual([
      { revision: 1, enabled: false },
      { revision: 2, enabled: true },
    ]);
  });

  it('ignores events that changed no settings key (API-key-only writes)', () => {
    const { sync, applied } = harness();
    expect(sync.accept({ settings: SETTINGS(), changedKeys: ['jevApiKey'], revision: 0 })).toBe(false);
    expect(applied).toEqual([]);
    expect(sync.hasAppliedAny()).toBe(false);
  });

  it('reports whether anything was applied, gating the initial read', () => {
    const { sync } = harness();
    expect(sync.hasAppliedAny()).toBe(false);
    sync.accept(broadcast({ enabled: false }, ['enabled'], 1));
    expect(sync.hasAppliedAny()).toBe(true);
  });
});
