import { describe, expect, it, vi } from 'vitest';
import {
  API_KEY_STORAGE_KEY,
  DEFAULT_SETTINGS,
  SETTINGS_REVISION_STORAGE_KEY,
  createSettingsStore,
} from '@/core/settings-store';
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

  // Regression: rapid off/on writes must stamp a strictly increasing persisted revision so
  // broadcast receivers can reject a delayed older state (out-of-order delivery).
  it('stamps each settings write with a strictly increasing persisted revision', async () => {
    const { backend, data } = createMemoryBackend();
    const store = createSettingsStore(backend);

    await store.setSettings({ enabled: false });
    expect(data[SETTINGS_REVISION_STORAGE_KEY]).toBe(1);
    await store.setSettings({ enabled: true });
    expect(data[SETTINGS_REVISION_STORAGE_KEY]).toBe(2);
    expect(await store.getSettings()).toEqual({ ...DEFAULT_SETTINGS, enabled: true });
  });

  it('orders concurrent setSettings calls so every write sees the previous revision', async () => {
    const { backend, data } = createMemoryBackend();
    const store = createSettingsStore(backend);

    const [first, second, third] = await Promise.all([
      store.setSettings({ enabled: false }),
      store.setSettings({ minDraftLength: 40 }),
      store.setSettings({ enabled: true }),
    ]);
    // Each write reads what the previous one persisted, so the returned snapshots chain up.
    expect([first, second, third].map((write) => write.settings.enabled)).toEqual([false, false, true]);
    expect([first, second, third].map((write) => write.settingsRevision)).toEqual([1, 2, 3]);
    expect(await store.getSettings()).toEqual({ ...DEFAULT_SETTINGS, enabled: true, minDraftLength: 40 });
    expect(data[SETTINGS_REVISION_STORAGE_KEY]).toBe(3);
  });

  // The set-settings reply carries the write's revision so pages can gate repaints on strictly
  // newer revisions (a delayed older reply must never overwrite a newer applied state).
  it('returns the persisted settings and the stamped revision from each write', async () => {
    const { backend } = createMemoryBackend();
    const store = createSettingsStore(backend);

    const first = await store.setSettings({ enabled: false });
    expect(first).toEqual({ settings: { ...DEFAULT_SETTINGS, enabled: false }, settingsRevision: 1 });
    const second = await store.setSettings({ minDraftLength: 40 });
    expect(second).toEqual({
      settings: { ...DEFAULT_SETTINGS, enabled: false, minDraftLength: 40 },
      settingsRevision: 2,
    });
  });

  it('reads the settings and their revision in one snapshot via getSettingsWithRevision', async () => {
    const { backend } = createMemoryBackend();
    const store = createSettingsStore(backend);

    // Empty storage: defaults with revision 0 (no order information).
    expect(await store.getSettingsWithRevision()).toEqual({ settings: DEFAULT_SETTINGS, revision: 0 });

    await store.setSettings({ enabled: false });
    expect(await store.getSettingsWithRevision()).toEqual({
      settings: { ...DEFAULT_SETTINGS, enabled: false },
      revision: 1,
    });
  });

  it('surfaces the revision of the triggering write to subscribers', async () => {
    const { backend } = createMemoryBackend();
    const store = createSettingsStore(backend);
    const listener = vi.fn();
    store.subscribe(listener);

    await store.setSettings({ enabled: false });
    await store.setSettings({ minDraftLength: 40 });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    expect(listener.mock.calls.map((call) => call[0].revision)).toEqual([1, 2]);
  });
});
