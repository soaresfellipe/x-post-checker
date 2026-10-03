import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, isRequest } from '../../src/core/message-protocol';
import {
  broadcastToTabs,
  createSettingsBroadcast,
  isSettingsBroadcast,
  type TabsApi,
} from '../../src/core/message-protocol/broadcast';
import { DEFAULT_SETTINGS } from '../../src/core/settings-store';

describe('settings broadcast', () => {
  it('builds a versioned envelope carrying the full settings', () => {
    const message = createSettingsBroadcast({ ...DEFAULT_SETTINGS, enabled: false }, ['enabled']);
    expect(message).toEqual({
      v: PROTOCOL_VERSION,
      kind: 'broadcast',
      type: 'settings-changed',
      settings: { ...DEFAULT_SETTINGS, enabled: false },
      changedKeys: ['enabled'],
    });
    expect(isSettingsBroadcast(message)).toBe(true);
  });

  it('rejects malformed or unrelated messages and is not mistaken for a request', () => {
    expect(isSettingsBroadcast(null)).toBe(false);
    expect(isSettingsBroadcast({ v: PROTOCOL_VERSION, kind: 'broadcast', type: 'settings-changed' })).toBe(false);
    expect(isSettingsBroadcast({ ...createSettingsBroadcast(DEFAULT_SETTINGS, []), v: PROTOCOL_VERSION + 1 })).toBe(false);
    expect(isSettingsBroadcast({ ...createSettingsBroadcast(DEFAULT_SETTINGS, []), settings: { enabled: 'yes' } })).toBe(false);
    expect(isRequest(createSettingsBroadcast(DEFAULT_SETTINGS, []))).toBe(false);
  });

  it('delivers to every tab and tolerates tabs without a listener', async () => {
    const sendMessage = vi.fn(async (tabId: number) => {
      if (tabId === 2) throw new Error('Could not establish connection. Receiving end does not exist.');
      return undefined;
    });
    const tabs: TabsApi = { query: async () => [{ id: 1 }, { id: 2 }, {}, { id: 3 }], sendMessage };
    const message = createSettingsBroadcast({ ...DEFAULT_SETTINGS, enabled: false }, ['enabled']);

    expect(await broadcastToTabs(tabs, message)).toBe(2);
    expect(sendMessage.mock.calls.map(([tabId]) => tabId)).toEqual([1, 2, 3]);
    expect(sendMessage).toHaveBeenCalledWith(1, message);
  });
});
