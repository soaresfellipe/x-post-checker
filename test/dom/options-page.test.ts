import { afterEach, describe, expect, it, vi } from 'vitest';
import { runConnectionTest, type ConnectionTestResult } from '@/core/jev-client';
import {
  API_KEY_STORAGE_KEY,
  DEFAULT_SETTINGS,
  createSettingsStore,
  type PageSettingsStore,
  type Settings,
  type SettingsWriteResult,
} from '@/core/settings-store';
import { COPY, mountOptionsPage, type OptionsPageDeps } from '@/dom/options';
import { createMemoryBackend } from '../helpers/memory-backend';

const KEY = 'test-key-abc123';

function q<T extends HTMLElement>(id: string): T {
  const el = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`missing ${id}`);
  return el;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const teardowns: Array<() => void> = [];

async function setup(options: { failWrites?: boolean; result?: ConnectionTestResult | Error; preset?: Record<string, unknown> } = {}) {
  const memory = createMemoryBackend({ failWrites: options.failWrites });
  Object.assign(memory.data, options.preset);
  const store = createSettingsStore(memory.backend);
  const testConnection = vi.fn<OptionsPageDeps['testConnection']>(async (attemptId) => {
    if (options.result instanceof Error) throw options.result;
    return { attemptId, result: options.result ?? { status: 'ok', model: 'jev-1.13.0', latencyMs: 241 } };
  });
  document.body.innerHTML = '<div id="app"></div>';
  teardowns.push(await mountOptionsPage(document.getElementById('app')!, {
    store,
    // Pages write settings through the background; here the same store stands in for it.
    saveSettings: (update) => store.setSettings(update),
    testConnection,
  }));
  return { memory, store, testConnection };
}

function type(el: HTMLInputElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Unused by the tests that pass it; satisfies the deps contract for direct mounts. */
const stubTestConnection: OptionsPageDeps['testConnection'] = async (attemptId) => ({
  attemptId,
  result: { status: 'no-key' },
});

describe('options page', () => {
  afterEach(() => {
    while (teardowns.length) teardowns.pop()?.();
  });

  it('renders the key field masked and the privacy disclosure visibly', async () => {
    await setup();
    expect(q<HTMLInputElement>('api-key-input').type).toBe('password');
    const text = q('privacy-disclosure').textContent ?? '';
    expect(text).toContain('Draft text is sent to api.typesafe.ai when AI analysis runs');
    expect(text).toContain('Timeline scoring is local');
    expect(q('privacy-disclosure').closest('details')).toBeNull();
    expect(q('key-status').textContent).toBe(COPY.keyMissing);
  });

  it('toggles visibility without changing the value', async () => {
    await setup();
    const input = q<HTMLInputElement>('api-key-input');
    const toggle = q<HTMLButtonElement>('toggle-key-visibility');
    type(input, KEY);
    toggle.click();
    expect(input.type).toBe('text');
    expect(input.value).toBe(KEY);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    expect(input.type).toBe('password');
    expect(input.value).toBe(KEY);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  it('reports save success only after the write completes, and clears the field', async () => {
    const { memory } = await setup();
    const release = memory.holdWrites();
    const input = q<HTMLInputElement>('api-key-input');
    type(input, KEY);
    q<HTMLButtonElement>('save-key').click();
    await flush();
    expect(q('save-status').textContent).toBe(COPY.saving);
    expect(memory.data[API_KEY_STORAGE_KEY]).toBeUndefined();
    release();
    await flush();
    expect(memory.data[API_KEY_STORAGE_KEY]).toBe(KEY);
    expect(q('save-status').textContent).toBe(COPY.saved);
    expect(q('save-status').dataset.state).toBe('success');
    expect(input.value).toBe('');
    expect(q('key-status').textContent).toBe(COPY.keyPresent);
    expect(document.body.textContent).not.toContain(KEY);
  });

  it('reports an error and no success when the write is rejected', async () => {
    await setup({ failWrites: true });
    type(q<HTMLInputElement>('api-key-input'), KEY);
    q<HTMLButtonElement>('save-key').click();
    await flush();
    expect(q('save-status').textContent).toBe(COPY.saveFailed);
    expect(q('save-status').dataset.state).toBe('error');
    expect(q('key-status').textContent).toBe(COPY.keyMissing);
    expect(document.body.textContent).not.toContain(KEY);
  });

  it('refuses to save an empty key', async () => {
    const { memory } = await setup();
    q<HTMLButtonElement>('save-key').click();
    await flush();
    expect(q('save-status').textContent).toBe(COPY.emptyKey);
    expect(memory.data[API_KEY_STORAGE_KEY]).toBeUndefined();
  });

  it('shows saved-key presence without exposing the key after a reload', async () => {
    await setup({ preset: { [API_KEY_STORAGE_KEY]: KEY } });
    expect(q('key-status').textContent).toBe(COPY.keyPresent);
    expect(q<HTMLInputElement>('api-key-input').value).toBe('');
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  it('removes the key on request', async () => {
    const { memory } = await setup({ preset: { [API_KEY_STORAGE_KEY]: KEY } });
    q<HTMLButtonElement>('remove-key').click();
    await flush();
    expect(memory.data[API_KEY_STORAGE_KEY]).toBeUndefined();
    expect(q('key-status').textContent).toBe(COPY.keyMissing);
  });

  it('test connection success shows model and latency, tied to the attempt', async () => {
    const { testConnection } = await setup({ preset: { [API_KEY_STORAGE_KEY]: KEY } });
    q<HTMLButtonElement>('test-connection').click();
    expect(q('test-result').textContent).toBe(COPY.testing);
    await flush();
    expect(testConnection).toHaveBeenCalledWith('attempt-1', undefined);
    expect(q('test-result').textContent).toBe('Connected. Model: jev-1.13.0. Latency: 241 ms.');
    expect(q('test-result').dataset.state).toBe('success');
  });

  it('tests the typed key when one is entered', async () => {
    const { testConnection } = await setup();
    type(q<HTMLInputElement>('api-key-input'), KEY);
    q<HTMLButtonElement>('test-connection').click();
    await flush();
    expect(testConnection).toHaveBeenCalledWith('attempt-1', KEY);
  });

  it('shows distinct invalid-key and network failures, keeps the saved key, and clears the prior success', async () => {
    const invalid = await setup({ preset: { [API_KEY_STORAGE_KEY]: KEY }, result: { status: 'invalid-key', httpStatus: 401 } });
    q<HTMLButtonElement>('test-connection').click();
    await flush();
    const invalidText = q('test-result').textContent ?? '';
    expect(q('test-result').dataset.state).toBe('invalid-key');
    expect(invalidText).toMatch(/Invalid API key/);
    expect(invalidText).not.toMatch(/Connected|Latency|Network error/);
    expect(invalid.memory.data[API_KEY_STORAGE_KEY]).toBe(KEY);
    expect(q<HTMLButtonElement>('test-connection').disabled).toBe(false);
    document.body.innerHTML = '';
    teardowns.pop()?.();

    const network = await setup({ preset: { [API_KEY_STORAGE_KEY]: KEY }, result: { status: 'network', reason: 'unreachable' } });
    q<HTMLButtonElement>('test-connection').click();
    await flush();
    const networkText = q('test-result').textContent ?? '';
    expect(q('test-result').dataset.state).toBe('network');
    expect(networkText).toMatch(/Network error/);
    expect(networkText).not.toMatch(/Invalid API key|Connected|Latency/);
    expect(network.memory.data[API_KEY_STORAGE_KEY]).toBe(KEY);
  });

  it('shows an error when the background is unreachable', async () => {
    await setup({ result: new Error('Could not establish connection') });
    q<HTMLButtonElement>('test-connection').click();
    await flush();
    expect(q('test-result').textContent).toBe(COPY.testUnavailable);
    expect(q<HTMLButtonElement>('test-connection').disabled).toBe(false);
  });

  // Regression (VAL-SETUP-006): a 200 whose body never arrives must resolve to the network-timeout
  // failure state and leave the page usable (button re-enabled), not pending forever.
  it('recovers the UI when the connection test stalls after the response headers', async () => {
    const memory = createMemoryBackend();
    memory.data[API_KEY_STORAGE_KEY] = KEY;
    const store = createSettingsStore(memory.backend);
    const stalledFetch = (_url: string, init: RequestInit): Promise<Response> =>
      new Promise<Response>((resolve) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('The operation was aborted.', 'AbortError')),
            );
          },
        });
        resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
      });
    document.body.innerHTML = '<div id="app"></div>';
    teardowns.push(await mountOptionsPage(document.getElementById('app')!, {
      store,
      saveSettings: (update) => store.setSettings(update),
      testConnection: async (attemptId, apiKey) => ({
        attemptId,
        // Mirrors the background handler: a typed key wins, otherwise the saved key is tested.
        result: await runConnectionTest({
          apiKey: apiKey ?? (await store.getApiKey()),
          fetchImpl: stalledFetch,
          timeoutMs: 25,
        }),
      }),
    }));

    const button = q<HTMLButtonElement>('test-connection');
    button.click();
    expect(button.disabled).toBe(true);
    expect(q('test-result').textContent).toBe(COPY.testing);

    await vi.waitFor(() => expect(button.disabled).toBe(false), { timeout: 5_000 });
    expect(q('test-result').dataset.state).toBe('network');
    expect(q('test-result').textContent ?? '').toMatch(/timed out/);
    expect(memory.data[API_KEY_STORAGE_KEY]).toBe(KEY);
    // The page remains usable: a follow-up click starts a fresh attempt.
    button.click();
    expect(q('test-result').textContent).toBe(COPY.testing);
  });

  it('discards the result of a superseded attempt', async () => {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend);
    const resolvers: Array<(r: { attemptId: string; result: ConnectionTestResult }) => void> = [];
    document.body.innerHTML = '<div id="app"></div>';
    teardowns.push(await mountOptionsPage(document.getElementById('app')!, {
      store,
      saveSettings: (update) => store.setSettings(update),
      testConnection: () => new Promise((resolve) => resolvers.push(resolve)),
    }));
    q<HTMLButtonElement>('test-connection').click();
    // Re-enable manually to simulate a second click racing the first.
    q<HTMLButtonElement>('test-connection').disabled = false;
    q<HTMLButtonElement>('test-connection').click();
    resolvers[1]?.({ attemptId: 'attempt-2', result: { status: 'network', reason: 'unreachable' } });
    await flush();
    resolvers[0]?.({ attemptId: 'attempt-1', result: { status: 'ok', model: 'old', latencyMs: 1 } });
    await flush();
    expect(q('test-result').textContent).toMatch(/Network error/);
    expect(q('test-result').textContent).not.toContain('old');
  });

  it('persists each preference change and reflects stored values on load', async () => {
    const { store } = await setup();
    for (const [id, expected] of [
      ['pref-enabled', false],
      ['pref-autoAnalyze', false],
      ['pref-jevForDrafts', false],
      ['pref-jevForTargets', true],
    ] as const) {
      const box = q<HTMLInputElement>(id);
      box.checked = expected;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
    }
    const min = q<HTMLInputElement>('pref-minDraftLength');
    min.value = '25';
    min.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    const threshold = q<HTMLInputElement>('pref-targetThreshold');
    threshold.value = '55';
    threshold.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(await store.getSettings()).toEqual({
      enabled: false,
      autoAnalyze: false,
      jevForDrafts: false,
      jevForTargets: true,
      minDraftLength: 25,
      targetThreshold: 55,
    });
    expect(q('prefs-status').textContent).toBe(COPY.prefsSaved);
  });

  it('rejects an out-of-range number and restores the stored value', async () => {
    const { store } = await setup();
    const min = q<HTMLInputElement>('pref-minDraftLength');
    min.value = '0';
    min.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(q('prefs-status').dataset.state).toBe('error');
    expect(min.value).toBe(String(DEFAULT_SETTINGS.minDraftLength));
    expect((await store.getSettings()).minDraftLength).toBe(DEFAULT_SETTINGS.minDraftLength);
  });

  it('reports a failed preference write and restores the control', async () => {
    await setup({ failWrites: true });
    const box = q<HTMLInputElement>('pref-enabled');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(q('prefs-status').textContent).toBe(COPY.prefsFailed);
    expect(box.checked).toBe(true);
  });

  it('follows changes made elsewhere through store notifications', async () => {
    const { store } = await setup();
    await store.setSettings({ enabled: false });
    await vi.waitFor(() => expect(q<HTMLInputElement>('pref-enabled').checked).toBe(false));
  });

  // Regression (scrutiny round 3): a save reply that resolves AFTER a newer storage change must
  // not repaint its older snapshot. The write itself persists immediately (the background's single
  // writer); only the reply's delivery is delayed, like a slow message round-trip.
  it('ignores a delayed save reply older than a storage change made elsewhere', async () => {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend); // the page's read/subscribe view
    const writer = createSettingsStore(memory.backend); // stands in for the background's writer
    let releaseReply = () => {};
    const replyGate = new Promise<void>((resolve) => (releaseReply = resolve));
    const saveSettings = vi.fn(async (update: Partial<Settings>): Promise<SettingsWriteResult> => {
      const write = await writer.setSettings(update); // persists now, revision stamped
      await replyGate; // the reply's transport delay
      return write;
    });
    document.body.innerHTML = '<div id="app"></div>';
    teardowns.push(await mountOptionsPage(document.getElementById('app')!, { store, saveSettings, testConnection: stubTestConnection }));

    // The user unchecks the master preference; the write persists but the reply is still in flight.
    const box = q<HTMLInputElement>('pref-enabled');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect((await store.getSettings()).enabled).toBe(false);
    expect(box.checked).toBe(false);

    // A newer write from another context lands; the page follows it (revision 2 beats 1).
    await writer.setSettings({ enabled: true, minDraftLength: 40 });
    await flush();
    expect(box.checked).toBe(true);
    expect(q<HTMLInputElement>('pref-minDraftLength').value).toBe('40');

    // The stale reply (revision 1, enabled: false) finally resolves: no repaint of the old state,
    // while the attempt's own success feedback still shows.
    releaseReply();
    await flush();
    expect(box.checked).toBe(true);
    expect(q<HTMLInputElement>('pref-minDraftLength').value).toBe('40');
    expect(q('prefs-status').textContent).toBe(COPY.prefsSaved);
    expect(q('prefs-status').dataset.state).toBe('success');
  });

  // Harness for the scrutiny round-4 resync race: the page's own save reply resolves late (after a
  // newer write from another context), and the resync reread it triggers is held mid-flight so the
  // test can land an even newer write before the reread completes. `pageReads` counts page-driven
  // store reads (initial read + resync rereads) to pin bounded resyncs.
  async function setupResyncRace() {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend); // the page's read/subscribe view
    const writer = createSettingsStore(memory.backend); // stands in for another context's writer
    let releaseReply = () => {};
    const replyGate = new Promise<void>((resolve) => (releaseReply = resolve));
    const saveSettings = vi.fn(async (update: Partial<Settings>): Promise<SettingsWriteResult> => {
      const write = await writer.setSettings(update); // persists now, revision stamped
      await replyGate; // the reply's transport delay
      return write;
    });
    let armRereadHold = false;
    const reread = { release: () => {} };
    let pageReads = 0;
    const storeView: PageSettingsStore = {
      ...store,
      async getSettingsWithRevision() {
        const snapshot = await store.getSettingsWithRevision();
        pageReads += 1;
        if (armRereadHold) {
          armRereadHold = false;
          await new Promise<void>((resolve) => (reread.release = resolve));
        }
        return snapshot;
      },
    };
    document.body.innerHTML = '<div id="app"></div>';
    teardowns.push(
      await mountOptionsPage(document.getElementById('app')!, { store: storeView, saveSettings, testConnection: stubTestConnection }),
    );
    expect(pageReads).toBe(1); // the initial read
    return { writer, releaseReply, armRereadHold: () => (armRereadHold = true), reread, reads: () => pageReads };
  }

  // Regression (scrutiny round 4): the resync reread started by a rejected save reply can itself be
  // overtaken by a newer write while in flight. The stale reread must be rejected by the revision
  // gate at COMPLETION — rendering it would regress the newer state the subscription already
  // applied, and with no later storage event the page would diverge from the store indefinitely.
  it('does not render a resync reread overtaken by a newer write from elsewhere', async () => {
    const { writer, releaseReply, armRereadHold, reread } = await setupResyncRace();

    // The user saves a preference; the write persists (revision 1) but the reply is held in flight.
    const box = q<HTMLInputElement>('pref-autoAnalyze');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    // Write A (another context, revision 2) lands; the page follows it through the subscription.
    await writer.setSettings({ enabled: true, minDraftLength: 40 });
    await flush();
    expect(q<HTMLInputElement>('pref-enabled').checked).toBe(true);
    expect(q<HTMLInputElement>('pref-minDraftLength').value).toBe('40');

    // The stale reply (revision 1) resolves: rejected by the gate, which starts a resync whose
    // reread is held after reading the store (still the revision-2 snapshot).
    armRereadHold();
    releaseReply();
    await flush();

    // Write B (revision 3) lands DURING the reread; the subscription applies it immediately.
    await writer.setSettings({ autoAnalyze: true, minDraftLength: 55 });
    await flush();
    expect(q<HTMLInputElement>('pref-minDraftLength').value).toBe('55');

    // The reread completes carrying the stale revision-2 snapshot (minDraftLength 40,
    // autoAnalyze false): the gate must reject it at completion so revision 3 stays on screen.
    reread.release();
    await flush();
    expect(q<HTMLInputElement>('pref-minDraftLength').value).toBe('55');
    expect(q<HTMLInputElement>('pref-autoAnalyze').checked).toBe(true);
    expect(q<HTMLInputElement>('pref-enabled').checked).toBe(true);
    expect(q('prefs-status').textContent).toBe(COPY.prefsSaved);
  });

  // The rejected reread must not schedule another resync: at most one resync per rejection, with
  // the storage subscription owning convergence to the newest state.
  it('does not loop resyncs when the reread itself is rejected', async () => {
    const { writer, releaseReply, armRereadHold, reread, reads } = await setupResyncRace();

    const box = q<HTMLInputElement>('pref-autoAnalyze');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    await writer.setSettings({ enabled: true, minDraftLength: 40 });
    await flush();

    armRereadHold();
    releaseReply();
    await flush();
    await writer.setSettings({ autoAnalyze: true, minDraftLength: 55 });
    await flush();

    reread.release();
    await flush();
    const readsAfterResync = reads();
    expect(readsAfterResync).toBe(2); // initial read + exactly one resync reread
    for (let i = 0; i < 5; i += 1) await flush();
    expect(reads()).toBe(readsAfterResync); // no further reads: bounded, no loop
    expect(q<HTMLInputElement>('pref-minDraftLength').value).toBe('55');
    expect(q<HTMLInputElement>('pref-autoAnalyze').checked).toBe(true);
  });

  // The key-presence lane is event-first: a key-only storage event re-reads presence fresh at
  // delivery and applies it, whatever the settings revision is doing (key writes carry none).
  it('applies key-only storage events to the key lane fresh at delivery', async () => {
    const { store } = await setup();
    await store.setApiKey(KEY);
    await flush();
    expect(q('key-status').dataset.state).toBe('present');
    expect(q('key-status').textContent).toBe(COPY.keyPresent);
    await store.clearApiKey();
    await flush();
    expect(q('key-status').dataset.state).toBe('absent');
  });

  // Regression (scrutiny round 5): API-key writes carry no settingsRevision, so the settings
  // revision gate cannot order key presence against reads. An initial read that captured `absent`
  // and completes after a key-only storage event already applied `present` must not repaint it —
  // no later event is required, so the page would otherwise disagree with storage indefinitely
  // (VAL-SETUP-015).
  it('does not regress key presence when the initial read finishes after a key-only event', async () => {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend);
    let armKeyReadHold = true; // holds the initial read's key read after it captures
    const keyReadHold = { release: () => {} };
    const storeView: PageSettingsStore = {
      ...store,
      async hasApiKey() {
        const present = await store.hasApiKey();
        if (armKeyReadHold) {
          armKeyReadHold = false;
          await new Promise<void>((resolve) => (keyReadHold.release = resolve));
        }
        return present;
      },
    };
    document.body.innerHTML = '<div id="app"></div>';
    // Not awaited yet: the initial read must still be in flight while the key event lands.
    const mounted = mountOptionsPage(document.getElementById('app')!, {
      store: storeView,
      saveSettings: (update) => store.setSettings(update),
      testConnection: stubTestConnection,
    });
    await flush(); // the initial read captured hasKey === false (no key yet) and is parked

    // A key-only write from another context lands; the subscription applies presence fresh at
    // delivery. Key events carry no revision, so the settings gate is not involved.
    await store.setApiKey(KEY);
    await flush();
    expect(q('key-status').dataset.state).toBe('present');

    // The parked initial read (stale `absent`, unchanged revision 0) completes: it must leave the
    // event-applied key presence alone, ending at storage's truth.
    keyReadHold.release();
    await flush();
    teardowns.push(await mounted);
    expect(q('key-status').dataset.state).toBe('present');
    expect(memory.data[API_KEY_STORAGE_KEY]).toBe(KEY);
  });

  it('keeps the latest save attempt in charge when a superseded attempt then fails', async () => {
    const resolvers: Array<(reply: SettingsWriteResult) => void> = [];
    const rejecters: Array<(error: Error) => void> = [];
    const saveSettings = vi.fn(
      () =>
        new Promise<SettingsWriteResult>((resolve, reject) => {
          resolvers.push(resolve);
          rejecters.push(reject);
        }),
    );
    document.body.innerHTML = '<div id="app"></div>';
    teardowns.push(await mountOptionsPage(document.getElementById('app')!, {
      store: createSettingsStore(createMemoryBackend().backend),
      saveSettings,
      testConnection: stubTestConnection,
    }));

    q<HTMLInputElement>('pref-enabled').click();
    await flush();
    q<HTMLInputElement>('pref-autoAnalyze').click();
    await flush();

    // The newer attempt resolves first and owns the status line; the superseded attempt then
    // FAILS, which must not overwrite the newer attempt's success with an error.
    resolvers[1]?.({ settings: { ...DEFAULT_SETTINGS, autoAnalyze: false }, settingsRevision: 2 });
    await flush();
    expect(q('prefs-status').textContent).toBe(COPY.prefsSaved);
    expect(q('prefs-status').dataset.state).toBe('success');
    rejecters[0]?.(new Error('write failed'));
    await flush();
    expect(q('prefs-status').textContent).toBe(COPY.prefsSaved);
    expect(q('prefs-status').dataset.state).toBe('success');
    expect(q<HTMLInputElement>('pref-autoAnalyze').checked).toBe(false);
  });

  it('keeps the latest save attempt in charge when a superseded attempt then succeeds', async () => {
    const resolvers: Array<(reply: SettingsWriteResult) => void> = [];
    const saveSettings = vi.fn(
      () => new Promise<SettingsWriteResult>((resolve) => void resolvers.push(resolve)),
    );
    document.body.innerHTML = '<div id="app"></div>';
    teardowns.push(await mountOptionsPage(document.getElementById('app')!, {
      store: createSettingsStore(createMemoryBackend().backend),
      saveSettings,
      testConnection: stubTestConnection,
    }));

    q<HTMLInputElement>('pref-enabled').click();
    await flush();
    q<HTMLInputElement>('pref-autoAnalyze').click();
    await flush();

    // The newer attempt (revision 2) resolves first; the older reply (revision 1) arrives later
    // and must neither repaint the controls nor the status line.
    resolvers[1]?.({ settings: { ...DEFAULT_SETTINGS, autoAnalyze: false }, settingsRevision: 2 });
    await flush();
    resolvers[0]?.({ settings: { ...DEFAULT_SETTINGS, enabled: false }, settingsRevision: 1 });
    await flush();
    expect(q('prefs-status').textContent).toBe(COPY.prefsSaved);
    expect(q<HTMLInputElement>('pref-autoAnalyze').checked).toBe(false);
    expect(q<HTMLInputElement>('pref-enabled').checked).toBe(true);
  });

  it('shows the latest attempt failure even when an older attempt succeeded first', async () => {
    const resolvers: Array<(reply: SettingsWriteResult) => void> = [];
    const rejecters: Array<(error: Error) => void> = [];
    const saveSettings = vi.fn(
      () =>
        new Promise<SettingsWriteResult>((resolve, reject) => {
          resolvers.push(resolve);
          rejecters.push(reject);
        }),
    );
    const memory = createMemoryBackend();
    document.body.innerHTML = '<div id="app"></div>';
    teardowns.push(await mountOptionsPage(document.getElementById('app')!, {
      store: createSettingsStore(memory.backend),
      saveSettings,
      testConnection: stubTestConnection,
    }));

    q<HTMLInputElement>('pref-enabled').click();
    await flush();
    // The first save succeeds while it is still the latest attempt.
    resolvers[0]?.({ settings: { ...DEFAULT_SETTINGS, enabled: false }, settingsRevision: 1 });
    await flush();
    expect(q('prefs-status').textContent).toBe(COPY.prefsSaved);

    // The next (latest) attempt then fails: its own error must show and the controls must resync
    // to the store's values, replacing the older attempt's success.
    q<HTMLInputElement>('pref-autoAnalyze').click();
    await flush();
    rejecters[1]?.(new Error('write failed'));
    await flush();
    expect(q('prefs-status').textContent).toBe(COPY.prefsFailed);
    expect(q('prefs-status').dataset.state).toBe('error');
    expect(q<HTMLInputElement>('pref-autoAnalyze').checked).toBe(true);
  });
});
