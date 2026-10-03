import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, isRequest } from '../../src/core/message-protocol';
import {
  broadcastToTabs,
  createRevisionGate,
  createSettingsBroadcast,
  createSettingsBroadcastReceiver,
  isSettingsBroadcast,
  type TabsApi,
} from '../../src/core/message-protocol/broadcast';
import { createSettingsStore, DEFAULT_SETTINGS, SETTINGS_REVISION_STORAGE_KEY } from '../../src/core/settings-store';
import { createMemoryBackend } from '../helpers/memory-backend';

describe('settings broadcast', () => {
  it('builds a versioned envelope carrying the full settings and the write revision', () => {
    const message = createSettingsBroadcast({ ...DEFAULT_SETTINGS, enabled: false }, ['enabled'], 7);
    expect(message).toEqual({
      v: PROTOCOL_VERSION,
      kind: 'broadcast',
      type: 'settings-changed',
      revision: 7,
      settings: { ...DEFAULT_SETTINGS, enabled: false },
      changedKeys: ['enabled'],
    });
    expect(isSettingsBroadcast(message)).toBe(true);
  });

  it('rejects malformed or unrelated messages and is not mistaken for a request', () => {
    expect(isSettingsBroadcast(null)).toBe(false);
    expect(isSettingsBroadcast({ v: PROTOCOL_VERSION, kind: 'broadcast', type: 'settings-changed' })).toBe(false);
    expect(isSettingsBroadcast({ ...createSettingsBroadcast(DEFAULT_SETTINGS, [], 1), v: PROTOCOL_VERSION + 1 })).toBe(false);
    expect(isSettingsBroadcast({ ...createSettingsBroadcast(DEFAULT_SETTINGS, [], 1), settings: { enabled: 'yes' } })).toBe(false);
    expect(isSettingsBroadcast({ ...createSettingsBroadcast(DEFAULT_SETTINGS, [], 1), revision: 'newer' })).toBe(false);
    expect(isRequest(createSettingsBroadcast(DEFAULT_SETTINGS, [], 1))).toBe(false);
  });

  it('delivers to every tab and tolerates tabs without a listener', async () => {
    const sendMessage = vi.fn(async (tabId: number) => {
      if (tabId === 2) throw new Error('Could not establish connection. Receiving end does not exist.');
      return undefined;
    });
    const tabs: TabsApi = { query: async () => [{ id: 1 }, { id: 2 }, {}, { id: 3 }], sendMessage };
    const message = createSettingsBroadcast({ ...DEFAULT_SETTINGS, enabled: false }, ['enabled'], 1);

    expect(await broadcastToTabs(tabs, message)).toBe(2);
    expect(sendMessage.mock.calls.map(([tabId]) => tabId)).toEqual([1, 2, 3]);
    expect(sendMessage).toHaveBeenCalledWith(1, message);
  });
});

describe('revision gate (shared strictly-newer guard)', () => {
  it('accepts the first revision and then only strictly newer ones, in any order', () => {
    const gate = createRevisionGate();
    expect(gate.accept(5)).toBe(true);
    expect(gate.accept(5)).toBe(false);
    expect(gate.accept(4)).toBe(false);
    expect(gate.accept(6)).toBe(true);
    expect(gate.accept(1)).toBe(false);
  });

  // Pages feed the gate from every snapshot source (initial read, storage subscriptions, save
  // replies); a delayed older source must never repaint over a newer applied state.
  it('gates a delayed save reply after a newer storage change was recorded', () => {
    const gate = createRevisionGate();
    expect(gate.accept(1)).toBe(true); // initial read
    expect(gate.accept(3)).toBe(true); // storage change from another context
    expect(gate.accept(2)).toBe(false); // the page's own save reply, older than what it applied
    expect(gate.accept(4)).toBe(true);
  });
});

describe('settings broadcast receiver (out-of-order delivery)', () => {
  it('ignores a delayed off broadcast arriving after a newer on was applied', () => {
    const receiver = createSettingsBroadcastReceiver();
    const off = createSettingsBroadcast({ ...DEFAULT_SETTINGS, enabled: false }, ['enabled'], 1);
    const on = createSettingsBroadcast({ ...DEFAULT_SETTINGS, enabled: true }, ['enabled'], 2);

    expect(receiver.accept(on)).toBe(true);
    // The stale off must NOT disable the tab: a newer state was already applied.
    expect(receiver.accept(off)).toBe(false);
  });

  it('ignores a delayed on broadcast arriving after a newer off was applied', () => {
    const receiver = createSettingsBroadcastReceiver();
    const off = createSettingsBroadcast({ ...DEFAULT_SETTINGS, enabled: false }, ['enabled'], 2);
    const on = createSettingsBroadcast({ ...DEFAULT_SETTINGS, enabled: true }, ['enabled'], 1);

    expect(receiver.accept(off)).toBe(true);
    expect(receiver.accept(on)).toBe(false);
  });

  it('ignores duplicate deliveries of the same revision', () => {
    const receiver = createSettingsBroadcastReceiver();
    const off = createSettingsBroadcast({ ...DEFAULT_SETTINGS, enabled: false }, ['enabled'], 1);
    expect(receiver.accept(off)).toBe(true);
    expect(receiver.accept(createSettingsBroadcast({ ...DEFAULT_SETTINGS, enabled: false }, ['enabled'], 1))).toBe(false);
  });

  it('applies each newer revision whatever gaps earlier deliveries left', () => {
    const receiver = createSettingsBroadcastReceiver();
    const revision3 = createSettingsBroadcast({ ...DEFAULT_SETTINGS, enabled: false }, ['enabled'], 3);
    expect(receiver.accept(revision3)).toBe(true);
    const revision5 = createSettingsBroadcast({ ...DEFAULT_SETTINGS, enabled: true }, ['enabled'], 5);
    expect(receiver.accept(revision5)).toBe(true);
    expect(receiver.accept(createSettingsBroadcast({ ...DEFAULT_SETTINGS, enabled: false }, ['enabled'], 4))).toBe(false);
  });

  // Regression: on a rapid off/on toggle the writes are ordered by the persisted revision, so even
  // if the transport delivers the envelopes in reverse, every tab converges to the stored state.
  it('converges to the stored settings when envelopes are delivered in reverse', async () => {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend);
    const events: Array<{ revision: number; enabled: boolean }> = [];
    store.subscribe(({ settings, revision }) => {
      events.push({ revision, enabled: settings.enabled });
    });

    await store.setSettings({ enabled: false });
    await store.setSettings({ enabled: true });
    // Subscription deliveries are asynchronous (each re-reads storage); wait for both to land.
    await vi.waitFor(() => expect(events).toHaveLength(2));

    expect(events.map((event) => [event.revision, event.enabled])).toEqual([[1, false], [2, true]]);
    expect(memory.data[SETTINGS_REVISION_STORAGE_KEY]).toBe(2);

    const receiver = createSettingsBroadcastReceiver();
    const applied: boolean[] = [];
    for (const { revision, enabled } of [...events].reverse()) {
      if (receiver.accept(createSettingsBroadcast({ ...DEFAULT_SETTINGS, enabled }, ['enabled'], revision))) {
        applied.push(enabled);
      }
    }
    // Only the newest write survives; the final applied state equals the store.
    expect(applied).toEqual([true]);
    expect(applied.at(-1)).toBe((await store.getSettings()).enabled);
  });
});
