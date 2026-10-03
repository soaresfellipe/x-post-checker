import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_KEY_STORAGE_KEY, LAST_ANALYSIS_STORAGE_KEY, createSettingsStore } from '@/core/settings-store';
import { COPY, formatAnalysisTime, mountPopupPage } from '@/dom/popup';
import { createMemoryBackend } from '../helpers/memory-backend';

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);

function q<T extends HTMLElement>(id: string): T {
  const el = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`missing ${id}`);
  return el;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const teardowns: Array<() => void> = [];

async function setup(options: { preset?: Record<string, unknown>; failWrites?: boolean; openOptions?: () => Promise<void> } = {}) {
  const memory = createMemoryBackend({ failWrites: options.failWrites });
  Object.assign(memory.data, options.preset);
  const store = createSettingsStore(memory.backend);
  const openOptions = vi.fn(options.openOptions ?? (async () => undefined));
  document.body.innerHTML = '<div id="app"></div>';
  teardowns.push(await mountPopupPage(document.getElementById('app')!, { store, openOptions, now: () => NOW }));
  return { memory, store, openOptions };
}

afterEach(() => {
  while (teardowns.length) teardowns.pop()!();
});

describe('popup page', () => {
  it('shows defaults: enabled, no key, explicit empty analysis state', async () => {
    await setup();
    expect(q<HTMLInputElement>('master-toggle').checked).toBe(true);
    expect(q('master-label').textContent).toBe(COPY.masterOn);
    expect(q('key-indicator').dataset.state).toBe('missing');
    expect(q('key-indicator').textContent).toBe(COPY.keyMissing);
    expect(q('last-analysis').dataset.state).toBe('empty');
    expect(q('last-analysis').textContent).toBe(COPY.analysisEmpty);
  });

  it('reflects stored master, key presence and last analysis', async () => {
    await setup({
      preset: { enabled: false, [API_KEY_STORAGE_KEY]: 'k-123', [LAST_ANALYSIS_STORAGE_KEY]: { at: NOW - 5 * 60_000, outcome: 'ok' } },
    });
    expect(q<HTMLInputElement>('master-toggle').checked).toBe(false);
    expect(q('master-label').textContent).toBe(COPY.masterOff);
    expect(q('key-indicator').dataset.state).toBe('present');
    expect(q('last-analysis').dataset.state).toBe('ok');
    expect(q('last-analysis').textContent).toBe('Completed 5 minutes ago');
    expect(document.body.textContent).not.toContain('k-123');
  });

  it('describes local-only and failed analyses distinctly', async () => {
    const { memory } = await setup({ preset: { [LAST_ANALYSIS_STORAGE_KEY]: { at: NOW, outcome: 'local-only' } } });
    expect(q('last-analysis').dataset.state).toBe('local-only');
    expect(q('last-analysis').textContent).toContain('Local score only');
    memory.data[LAST_ANALYSIS_STORAGE_KEY] = { at: NOW, outcome: 'error' };
    memory.emit({ [LAST_ANALYSIS_STORAGE_KEY]: { newValue: { at: NOW, outcome: 'error' } } });
    await flush();
    expect(q('last-analysis').dataset.state).toBe('error');
    expect(q('last-analysis').textContent).toBe('Failed just now');
  });

  it('writes the master switch to the store', async () => {
    const { store } = await setup();
    const toggle = q<HTMLInputElement>('master-toggle');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect((await store.getSettings()).enabled).toBe(false);
    expect(q('master-label').textContent).toBe(COPY.masterOff);

    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect((await store.getSettings()).enabled).toBe(true);
  });

  it('follows changes made elsewhere (Options) while open', async () => {
    const { store } = await setup();
    await store.setSettings({ enabled: false });
    await store.setApiKey('abc');
    await store.recordAnalysis({ at: NOW, outcome: 'ok' });
    await flush();
    expect(q<HTMLInputElement>('master-toggle').checked).toBe(false);
    expect(q('key-indicator').dataset.state).toBe('present');
    expect(q('last-analysis').dataset.state).toBe('ok');
    await store.clearApiKey();
    await flush();
    expect(q('key-indicator').dataset.state).toBe('missing');
  });

  it('reverts the switch and reports an error when the write fails', async () => {
    const { store } = await setup({ failWrites: true });
    const toggle = q<HTMLInputElement>('master-toggle');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(toggle.checked).toBe(true);
    expect(q('master-label').textContent).toBe(COPY.masterOn);
    expect(q('toggle-error').textContent).toBe(COPY.toggleFailed);
    expect((await store.getSettings()).enabled).toBe(true);
  });

  it('opens the Options page from the button and reports failure', async () => {
    const { openOptions } = await setup();
    q('open-options').click();
    await flush();
    expect(openOptions).toHaveBeenCalledTimes(1);

    await setup({ openOptions: async () => Promise.reject(new Error('nope')) });
    q('open-options').click();
    await flush();
    expect(q('toggle-error').textContent).toBe(COPY.openOptionsFailed);
  });

  it('contains only ASCII English copy in every state', async () => {
    const { memory } = await setup();
    const seen = [document.body.textContent ?? ''];
    for (const outcome of ['ok', 'local-only', 'error'] as const) {
      memory.data[LAST_ANALYSIS_STORAGE_KEY] = { at: NOW - 3 * 86_400_000, outcome };
      memory.emit({ [LAST_ANALYSIS_STORAGE_KEY]: { newValue: memory.data[LAST_ANALYSIS_STORAGE_KEY] } });
      await flush();
      seen.push(document.body.textContent ?? '');
    }
    for (const text of seen) expect(text).toMatch(/^[\s!-~]*$/);
  });
});

describe('formatAnalysisTime', () => {
  it('uses fixed English relative phrases and an absolute date after a day', () => {
    expect(formatAnalysisTime(NOW - 10_000, NOW)).toBe('just now');
    expect(formatAnalysisTime(NOW + 10_000, NOW)).toBe('just now');
    expect(formatAnalysisTime(NOW - 60_000, NOW)).toBe('1 minute ago');
    expect(formatAnalysisTime(NOW - 59 * 60_000, NOW)).toBe('59 minutes ago');
    expect(formatAnalysisTime(NOW - 3_600_000, NOW)).toBe('1 hour ago');
    expect(formatAnalysisTime(NOW - 5 * 3_600_000, NOW)).toBe('5 hours ago');
    expect(formatAnalysisTime(NOW - 2 * 86_400_000, NOW)).toMatch(/^on \d{4}-\d{2}-\d{2} at \d{2}:\d{2}$/);
  });
});
