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
});
