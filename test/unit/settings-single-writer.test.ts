import { describe, expect, it, vi } from 'vitest';
import { createRequest, handleRequest, type Handlers } from '@/core/message-protocol';
import { createBackgroundHandlers } from '@/core/message-protocol/handlers';
import {
  API_KEY_STORAGE_KEY,
  DEFAULT_SETTINGS,
  KEY_REVISION_STORAGE_KEY,
  SETTINGS_REVISION_STORAGE_KEY,
  createSettingsStore,
  type ApiKeyWriteResult,
  type Settings,
} from '@/core/settings-store';
import type { ConnectionTestResult } from '@/core/jev-client';
import type { AnalyzerService } from '@/core/analyzer';
import { createMemoryBackend } from '../helpers/memory-backend';

const test = {
  /** Unused by these tests; the handler set requires the deep-analysis pipeline to exist. */
  targetAnalyzer: { analyzeTarget: async () => ({ kind: 'unavailable' as const }) },
};


/** Stub analyzer: these tests exercise the settings/key write lanes, not the analysis pipeline. */
const analyzer: AnalyzerService = {
  async analyzeDraft() {
    return { kind: 'disabled' };
  },
};

/**
 * Mimics an extension page context (popup / Options): its own store instance for reads over the
 * shared storage backend, plus a writer that travels through the real protocol layer
 * (createRequest -> handleRequest) to the background, never touching storage directly. Resolves
 * with the full write reply (settings + the write's revision), as the pages now receive it.
 */
function makePageContext(handlers: Handlers) {
  return {
    async saveSettings(update: Partial<Settings>) {
      const response = await handleRequest(createRequest('set-settings', { update }), handlers);
      if (!response.ok) throw new Error(response.error);
      return response.data;
    },
  };
}

/**
 * Same shape for API-key writes: they travel through the background's single writer too, so the
 * stamped keyRevision is authoritative (docs/state-ordering.md lane (b)).
 */
function makeKeyPageContext(handlers: Handlers) {
  return {
    async saveApiKey(key: string): Promise<ApiKeyWriteResult> {
      const response = await handleRequest(createRequest('set-api-key', { key }), handlers);
      if (!response.ok) throw new Error(response.error);
      return response.data;
    },
    async removeApiKey(): Promise<ApiKeyWriteResult> {
      const response = await handleRequest(createRequest('clear-api-key', {}), handlers);
      if (!response.ok) throw new Error(response.error);
      return response.data;
    },
  };
}

const okResult: ConnectionTestResult = { status: 'ok', model: 'jev-1.13.0', latencyMs: 5 };
describe('background single-writer for settings', () => {
  it('serializes concurrent writes from two independent contexts with unique revisions', async () => {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend);
    const handlers = createBackgroundHandlers({ store, analyzer, targetAnalyzer: test.targetAnalyzer });
    const contextA = makePageContext(handlers);
    const contextB = makePageContext(handlers);
    const revisions: number[] = [];
    store.subscribe(({ revision }) => void revisions.push(revision));

    // Hold the storage write so both contexts' requests are genuinely in flight at once.
    const release = memory.holdWrites();
    const writeA = contextA.saveSettings({ enabled: false });
    const writeB = contextB.saveSettings({ minDraftLength: 40 });
    release();
    const [replyA, replyB] = await Promise.all([writeA, writeB]);

    // Exactly one revision per write: no two writes ever shared one. Each reply carries its
    // write's revision so the requesting page can order it against storage-driven updates.
    expect(revisions).toEqual([1, 2]);
    expect([replyA.settingsRevision, replyB.settingsRevision]).toEqual([1, 2]);
    expect(memory.data[SETTINGS_REVISION_STORAGE_KEY]).toBe(2);
  });

  it('makes each write read what the previous one persisted, so no update is lost', async () => {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend);
    const handlers = createBackgroundHandlers({ store, analyzer, targetAnalyzer: test.targetAnalyzer });
    const contextA = makePageContext(handlers);
    const contextB = makePageContext(handlers);

    const release = memory.holdWrites();
    const writeA = contextA.saveSettings({ enabled: false });
    const writeB = contextB.saveSettings({ minDraftLength: 40 });
    release();
    const [replyA, replyB] = await Promise.all([writeA, writeB]);

    // Writer B observed writer A's persisted state instead of the stale pre-A snapshot.
    expect(replyA.settings).toEqual({ ...DEFAULT_SETTINGS, enabled: false });
    expect(replyB.settings).toEqual({ ...DEFAULT_SETTINGS, enabled: false, minDraftLength: 40 });
    expect(await store.getSettings()).toEqual({ ...DEFAULT_SETTINGS, enabled: false, minDraftLength: 40 });
  });

  it('converges every context to the store final state through storage notifications', async () => {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend);
    const handlers = createBackgroundHandlers({ store, analyzer, targetAnalyzer: test.targetAnalyzer });

    // Each context observes the shared storage through its own store instance.
    const storeA = createSettingsStore(memory.backend);
    const storeB = createSettingsStore(memory.backend);
    const seenA: Array<{ revision: number; settings: Settings }> = [];
    const seenB: Array<{ revision: number; settings: Settings }> = [];
    storeA.subscribe(({ settings, revision }) => void seenA.push({ revision, settings }));
    storeB.subscribe(({ settings, revision }) => void seenB.push({ revision, settings }));

    const contextA = makePageContext(handlers);
    const contextB = makePageContext(handlers);
    await Promise.all([
      contextA.saveSettings({ enabled: false }),
      contextB.saveSettings({ enabled: true, targetThreshold: 55 }),
      contextA.saveSettings({ minDraftLength: 40 }),
    ]);

    const final = await store.getSettings();
    expect(final).toEqual({ ...DEFAULT_SETTINGS, enabled: true, targetThreshold: 55, minDraftLength: 40 });
    // Both contexts end on the store's final revision and state, whatever interleaving happened.
    expect(await storeA.getSettings()).toEqual(final);
    expect(await storeB.getSettings()).toEqual(final);
    expect(seenA.at(-1)).toMatchObject({ revision: 3, settings: final });
    expect(seenB.at(-1)).toMatchObject({ revision: 3, settings: final });
  });

  it('rejects a malformed update without touching storage or the revision', async () => {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend);
    const handlers = createBackgroundHandlers({ store, analyzer, targetAnalyzer: test.targetAnalyzer });
    const context = makePageContext(handlers);
    await context.saveSettings({ enabled: false });

    const response = await handleRequest(
      createRequest('set-settings', { update: null as unknown as Partial<Settings> }),
      handlers,
    );
    expect(response.ok).toBe(false);
    expect(memory.data[SETTINGS_REVISION_STORAGE_KEY]).toBe(1);
    expect(await store.getSettings()).toEqual({ ...DEFAULT_SETTINGS, enabled: false });
  });

  it('ignores unknown keys in an update instead of persisting them', async () => {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend);
    const handlers = createBackgroundHandlers({ store, analyzer, targetAnalyzer: test.targetAnalyzer });
    const context = makePageContext(handlers);

    await context.saveSettings({ enabled: false, jevApiKey: 'injected' } as Partial<Settings>);
    expect(memory.data.jevApiKey).toBeUndefined();
    expect(await store.getSettings()).toEqual({ ...DEFAULT_SETTINGS, enabled: false });
  });

  it('tests the saved key when the request carries no typed key', async () => {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend);
    await store.setApiKey('saved-key');
    const probe = vi.fn(async () => okResult);
    const handlers = createBackgroundHandlers({ store, analyzer,
        targetAnalyzer: { analyzeTarget: async () => ({ kind: 'unavailable' as const }) }, runConnectionTest: probe });

    const response = await handleRequest(createRequest('test-connection', { attemptId: 'a1' }), handlers);
    expect(response).toEqual({ ok: true, data: { attemptId: 'a1', result: okResult } });
    expect(probe).toHaveBeenCalledWith({ apiKey: 'saved-key' });
  });

  it('tests the typed key in the request before the saved one', async () => {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend);
    await store.setApiKey('saved-key');
    const probe = vi.fn(async () => okResult);
    const handlers = createBackgroundHandlers({ store, analyzer,
        targetAnalyzer: { analyzeTarget: async () => ({ kind: 'unavailable' as const }) }, runConnectionTest: probe });

    await handleRequest(createRequest('test-connection', { attemptId: 'a2', apiKey: ' typed-key ' }), handlers);
    expect(probe).toHaveBeenCalledWith({ apiKey: 'typed-key' });
  });
});

describe('background single-writer for API keys', () => {
  it('serializes concurrent key writes from two contexts with unique keyRevisions', async () => {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend);
    const handlers = createBackgroundHandlers({ store, analyzer, targetAnalyzer: test.targetAnalyzer });
    const contextA = makeKeyPageContext(handlers);
    const contextB = makeKeyPageContext(handlers);
    const revisions: number[] = [];
    store.subscribe(({ keyRevision }) => void revisions.push(keyRevision));

    const release = memory.holdWrites();
    const writeA = contextA.saveApiKey('key-a');
    const writeB = contextB.saveApiKey('key-b');
    release();
    const [replyA, replyB] = await Promise.all([writeA, writeB]);

    // Exactly one keyRevision per write, so receiving pages can order the facts they produce.
    expect(revisions).toEqual([1, 2]);
    expect([replyA.keyRevision, replyB.keyRevision]).toEqual([1, 2]);
    expect(memory.data[KEY_REVISION_STORAGE_KEY]).toBe(2);
  });

  it('stamps set and clear writes on one order, ending at the last write\'s presence', async () => {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend);
    const handlers = createBackgroundHandlers({ store, analyzer, targetAnalyzer: test.targetAnalyzer });
    const contextA = makeKeyPageContext(handlers);
    const contextB = makeKeyPageContext(handlers);

    const setReply = await contextA.saveApiKey('key-a');
    const clearReply = await contextB.removeApiKey();

    expect(setReply).toEqual({ apiKeyPresent: true, keyRevision: 1 });
    expect(clearReply).toEqual({ apiKeyPresent: false, keyRevision: 2 });
    expect(await store.hasApiKey()).toBe(false);
    expect(memory.data[KEY_REVISION_STORAGE_KEY]).toBe(2);
  });

  it('rejects an empty key without touching storage or the counter', async () => {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend);
    const handlers = createBackgroundHandlers({ store, analyzer, targetAnalyzer: test.targetAnalyzer });
    const context = makeKeyPageContext(handlers);

    const response = await handleRequest(createRequest('set-api-key', { key: '   ' }), handlers);
    expect(response.ok).toBe(false);
    expect(API_KEY_STORAGE_KEY in memory.data).toBe(false);
    expect(KEY_REVISION_STORAGE_KEY in memory.data).toBe(false);

    const next = await context.saveApiKey('key-1');
    expect(next.keyRevision).toBe(1);
  });
});
