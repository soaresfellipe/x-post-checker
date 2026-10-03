import { describe, expect, it, vi } from 'vitest';
import { LAST_ANALYSIS_STORAGE_KEY, createSettingsStore } from '../../src/core/settings-store';
import { createMemoryBackend } from '../helpers/memory-backend';

describe('last analysis record', () => {
  it('is undefined until an analysis is recorded', async () => {
    const store = createSettingsStore(createMemoryBackend().backend);
    expect(await store.getLastAnalysis()).toBeUndefined();
  });

  it('round-trips the recorded outcome and time', async () => {
    const store = createSettingsStore(createMemoryBackend().backend);
    await store.recordAnalysis({ at: 1_700_000_000_000, outcome: 'local-only' });
    expect(await store.getLastAnalysis()).toEqual({ at: 1_700_000_000_000, outcome: 'local-only' });
  });

  it('treats corrupt stored values as no analysis', async () => {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend);
    for (const bad of ['x', { at: 'now', outcome: 'ok' }, { at: 5, outcome: 'weird' }, { at: -1, outcome: 'ok' }, null]) {
      memory.data[LAST_ANALYSIS_STORAGE_KEY] = bad;
      expect(await store.getLastAnalysis()).toBeUndefined();
    }
  });

  it('notifies only analysis subscribers, and settings subscribers ignore analysis writes', async () => {
    const store = createSettingsStore(createMemoryBackend().backend);
    const onAnalysis = vi.fn();
    const onSettings = vi.fn();
    store.subscribeLastAnalysis(onAnalysis);
    store.subscribe(onSettings);

    await store.recordAnalysis({ at: 10, outcome: 'ok' });
    await store.setSettings({ enabled: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onAnalysis).toHaveBeenCalledTimes(1);
    expect(onAnalysis).toHaveBeenCalledWith({ at: 10, outcome: 'ok' });
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  // Recency gate (VAL-SETUP-015): a delayed OLDER completion must never overwrite a newer
  // completion's record, or the popup would show the older outcome as the latest.
  it('keeps the newer record when a delayed older completion lands after it', async () => {
    const store = createSettingsStore(createMemoryBackend().backend);
    await store.recordAnalysis({ at: 200, outcome: 'ok' }); // the newer completion commits first
    await store.recordAnalysis({ at: 100, outcome: 'error' }); // the older write lands late
    expect(await store.getLastAnalysis()).toEqual({ at: 200, outcome: 'ok' });
  });

  it('admits a genuinely newer completion over an older record (the convergent direction)', async () => {
    const store = createSettingsStore(createMemoryBackend().backend);
    await store.recordAnalysis({ at: 100, outcome: 'error' });
    await store.recordAnalysis({ at: 200, outcome: 'ok' });
    expect(await store.getLastAnalysis()).toEqual({ at: 200, outcome: 'ok' });
  });

  it('is strictly newer: a record stamped at the same time never displaces the stored one', async () => {
    const store = createSettingsStore(createMemoryBackend().backend);
    await store.recordAnalysis({ at: 200, outcome: 'error' });
    await store.recordAnalysis({ at: 200, outcome: 'ok' });
    expect(await store.getLastAnalysis()).toEqual({ at: 200, outcome: 'error' });
  });

  // Both held-write interleavings (the memory backend parks `area.set`): whatever order the two
  // writes are handed to storage in, the newest completion's record must end up stored.
  it('ends at the newest completion when the older write is the one that stalls', async () => {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend);
    const release = memory.holdWrites();
    const older = store.recordAnalysis({ at: 100, outcome: 'error' }); // stamps first, write stalls
    const newer = store.recordAnalysis({ at: 200, outcome: 'ok' }); // queues behind it
    release();
    await Promise.all([older, newer]);
    expect(await store.getLastAnalysis()).toEqual({ at: 200, outcome: 'ok' });
  });

  it('ends at the newest completion when the newer write is the one that stalls', async () => {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend);
    const release = memory.holdWrites();
    const newer = store.recordAnalysis({ at: 200, outcome: 'ok' }); // write stalls
    const older = store.recordAnalysis({ at: 100, outcome: 'error' }); // queues behind it
    release();
    await Promise.all([newer, older]);
    expect(await store.getLastAnalysis()).toEqual({ at: 200, outcome: 'ok' });
  });

  it('keeps recording after a failed write (the chain never poisons)', async () => {
    const memory = createMemoryBackend();
    let failNextWrite = true;
    const originalSet = memory.backend.area.set.bind(memory.backend.area);
    memory.backend.area.set = async (items) => {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error('QUOTA_BYTES quota exceeded');
      }
      await originalSet(items);
    };
    const store = createSettingsStore(memory.backend);
    await expect(store.recordAnalysis({ at: 100, outcome: 'ok' })).rejects.toThrow();
    await store.recordAnalysis({ at: 200, outcome: 'ok' }); // the next record still persists
    expect(await store.getLastAnalysis()).toEqual({ at: 200, outcome: 'ok' });
  });
});
