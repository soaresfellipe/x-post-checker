import { describe, expect, it, vi } from 'vitest';
import { API_KEY_STORAGE_KEY, DEFAULT_SETTINGS, createSettingsStore } from '@/core/settings-store';
import { createMemoryBackend } from '../helpers/memory-backend';

describe('settings store', () => {
  it('returns defaults when storage is empty', async () => {
    const { backend } = createMemoryBackend();
    const store = createSettingsStore(backend);
    expect(await store.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await store.hasApiKey()).toBe(false);
  });

  it('defaults match the documented behavior (drafts AI on, targets AI off, threshold 70)', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      enabled: true,
      autoAnalyze: true,
      jevForDrafts: true,
      jevForTargets: false,
      minDraftLength: 10,
      targetThreshold: 70,
    });
  });

  it('persists every named preference and reads it back', async () => {
    const { backend } = createMemoryBackend();
    const store = createSettingsStore(backend);
    const next = {
      enabled: false,
      autoAnalyze: false,
      jevForDrafts: false,
      jevForTargets: true,
      minDraftLength: 25,
      targetThreshold: 55,
    };
    await store.setSettings(next);
    expect(await createSettingsStore(backend).getSettings()).toEqual(next);
  });

  it('merges partial updates and keeps other fields', async () => {
    const { backend } = createMemoryBackend();
    const store = createSettingsStore(backend);
    await store.setSettings({ minDraftLength: 40 });
    expect(await store.getSettings()).toEqual({ ...DEFAULT_SETTINGS, minDraftLength: 40 });
  });

  it('sanitizes malformed stored values back to defaults and clamps numbers', async () => {
    const { backend, data } = createMemoryBackend();
    data.enabled = 'yes';
    data.minDraftLength = -5;
    data.targetThreshold = 900;
    data.jevForDrafts = 0;
    const settings = await createSettingsStore(backend).getSettings();
    expect(settings.enabled).toBe(DEFAULT_SETTINGS.enabled);
    expect(settings.jevForDrafts).toBe(DEFAULT_SETTINGS.jevForDrafts);
    expect(settings.minDraftLength).toBe(1);
    expect(settings.targetThreshold).toBe(100);
  });

  it('stores the API key under its own key and reports presence', async () => {
    const { backend, data } = createMemoryBackend();
    const store = createSettingsStore(backend);
    await store.setApiKey('  test-key-123  ');
    expect(data[API_KEY_STORAGE_KEY]).toBe('test-key-123');
    expect(await store.getApiKey()).toBe('test-key-123');
    expect(await store.hasApiKey()).toBe(true);
    await store.clearApiKey();
    expect(await store.hasApiKey()).toBe(false);
  });

  it('rejects an empty API key without writing', async () => {
    const { backend, data } = createMemoryBackend();
    await expect(createSettingsStore(backend).setApiKey('   ')).rejects.toThrow(/empty/i);
    expect(API_KEY_STORAGE_KEY in data).toBe(false);
  });

  it('propagates a rejected write and never includes the key in the error', async () => {
    const { backend } = createMemoryBackend({ failWrites: true });
    const error = await createSettingsStore(backend)
      .setApiKey('secret-key-abc')
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain('secret-key-abc');
  });

  it('notifies subscribers of setting changes without exposing the key', async () => {
    const { backend } = createMemoryBackend();
    const store = createSettingsStore(backend);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    await store.setSettings({ enabled: false });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      settings: { ...DEFAULT_SETTINGS, enabled: false },
      changedKeys: ['enabled'],
      apiKeyPresent: false,
    });

    await store.setApiKey('secret-key-abc');
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    const payload = listener.mock.calls[1]?.[0];
    expect(payload.changedKeys).toEqual([API_KEY_STORAGE_KEY]);
    expect(payload.apiKeyPresent).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('secret-key-abc');

    unsubscribe();
    await store.setSettings({ enabled: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('ignores changes from other storage areas and unrelated keys', async () => {
    const { backend, emit } = createMemoryBackend();
    const store = createSettingsStore(backend);
    const listener = vi.fn();
    store.subscribe(listener);
    emit({ enabled: { newValue: false } }, 'sync');
    emit({ somethingElse: { newValue: 1 } }, 'local');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(listener).not.toHaveBeenCalled();
  });
});
