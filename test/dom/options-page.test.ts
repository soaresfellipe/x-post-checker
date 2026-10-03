import { afterEach, describe, expect, it, vi } from 'vitest';
import { runConnectionTest, type ConnectionTestResult } from '@/core/jev-client';
import { API_KEY_STORAGE_KEY, DEFAULT_SETTINGS, createSettingsStore } from '@/core/settings-store';
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
});
