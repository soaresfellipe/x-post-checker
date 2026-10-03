import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_KEY_STORAGE_KEY,
  KEY_REVISION_STORAGE_KEY,
  LAST_ANALYSIS_STORAGE_KEY,
  DEFAULT_SETTINGS,
  createSettingsStore,
} from '@/core/settings-store';
import type { PageSettingsStore, Settings, SettingsWriteResult } from '@/core/settings-store';
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
  teardowns.push(await mountPopupPage(document.getElementById('app')!, {
    store,
    // Pages write settings through the background; here the same store stands in for it.
    saveSettings: (update) => store.setSettings(update),
    openOptions,
    now: () => NOW,
  }));
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

  // Analysis lane (docs/state-ordering.md lane (c)): the last-analysis line never regresses
  // behind storage. A delayed OLDER record (an out-of-order completion's write, or any writer
  // bypassing the background's gated recorder) must not repaint the newer outcome already shown.
  it('keeps the newest analysis when a delayed older record is delivered last', async () => {
    const { memory } = await setup({ preset: { [LAST_ANALYSIS_STORAGE_KEY]: { at: NOW, outcome: 'ok' } } });
    expect(q('last-analysis').dataset.state).toBe('ok');

    memory.data[LAST_ANALYSIS_STORAGE_KEY] = { at: NOW - 5 * 60_000, outcome: 'error' };
    memory.emit({ [LAST_ANALYSIS_STORAGE_KEY]: { newValue: { at: NOW - 5 * 60_000, outcome: 'error' } } });
    await flush();
    expect(q('last-analysis').dataset.state).toBe('ok');
    expect(q('last-analysis').dataset.at).toBe(String(NOW));
  });

  // The paired interleaving: the older record first, then the genuinely newer one — the newer
  // always wins, whatever order the facts are delivered in.
  it('applies the newer analysis over an older record in the reverse interleaving too', async () => {
    const { memory } = await setup({ preset: { [LAST_ANALYSIS_STORAGE_KEY]: { at: NOW - 5 * 60_000, outcome: 'error' } } });
    expect(q('last-analysis').dataset.state).toBe('error');

    memory.data[LAST_ANALYSIS_STORAGE_KEY] = { at: NOW, outcome: 'ok' };
    memory.emit({ [LAST_ANALYSIS_STORAGE_KEY]: { newValue: { at: NOW, outcome: 'ok' } } });
    await flush();
    expect(q('last-analysis').dataset.state).toBe('ok');
    expect(q('last-analysis').dataset.at).toBe(String(NOW));
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

  // Regression (scrutiny round 6, popup pin): the validator's inverted key-event completion,
  // through the popup's refresh path. A key-set event's refresh parks holding present@1; the
  // key-clear event's refresh applies absent@2; the parked refresh then completes. The refresh
  // ticket already drops the stale refresh wholesale; the key lane's own gate would reject its
  // older fact too — the page ends at storage's truth (absent) either way. The hold intercepts
  // the storage read itself, like a slow storage round-trip.
  it('ends absent when the key-set event refresh completes after the key-clear event refresh', async () => {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend);
    let holdArmed = false; // parks the NEXT storage read that touches the key, after it captures
    const keyReadHold = { release: () => {} };
    const originalGet = memory.backend.area.get.bind(memory.backend);
    memory.backend.area.get = async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const snapshot = await originalGet(keys);
      if (holdArmed && list.includes(API_KEY_STORAGE_KEY)) {
        holdArmed = false;
        await new Promise<void>((resolve) => (keyReadHold.release = resolve));
      }
      return snapshot;
    };
    document.body.innerHTML = '<div id="app"></div>';
    teardowns.push(await mountPopupPage(document.getElementById('app')!, {
      store,
      saveSettings: (update) => store.setSettings(update),
      openOptions: async () => undefined,
      now: () => NOW,
    }));
    expect(q('key-indicator').dataset.state).toBe('missing');

    // Event A (key-set): its refresh's key read captures present@1 and parks.
    holdArmed = true;
    await store.setApiKey('abc');
    await flush();
    expect(q('key-indicator').dataset.state).toBe('missing'); // A's refresh is parked

    // Event B (key-clear): its refresh applies fresh absent@2.
    await store.clearApiKey();
    await flush();
    expect(q('key-indicator').dataset.state).toBe('missing');

    // A's parked refresh completes LAST: dropped (stale ticket; its fact is older anyway).
    keyReadHold.release();
    await flush();
    expect(q('key-indicator').dataset.state).toBe('missing');
    expect(memory.data[API_KEY_STORAGE_KEY]).toBe('');
  });

  // Reverse interleaving of the pin above: the key-clear event's refresh parks, a later key-set
  // event's refresh applies present@3, and the parked refresh completes last — it must not
  // regress the indicator behind storage, which holds the key.
  it('ends present when the key-clear event refresh completes after the key-set event refresh', async () => {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend);
    memory.data[API_KEY_STORAGE_KEY] = 'abc';
    memory.data[KEY_REVISION_STORAGE_KEY] = 1; // the preset key was written with keyRevision 1
    let holdArmed = false;
    const keyReadHold = { release: () => {} };
    const originalGet = memory.backend.area.get.bind(memory.backend);
    memory.backend.area.get = async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const snapshot = await originalGet(keys);
      if (holdArmed && list.includes(API_KEY_STORAGE_KEY)) {
        holdArmed = false;
        await new Promise<void>((resolve) => (keyReadHold.release = resolve));
      }
      return snapshot;
    };
    document.body.innerHTML = '<div id="app"></div>';
    teardowns.push(await mountPopupPage(document.getElementById('app')!, {
      store,
      saveSettings: (update) => store.setSettings(update),
      openOptions: async () => undefined,
      now: () => NOW,
    }));
    expect(q('key-indicator').dataset.state).toBe('present');

    // Event B (key-clear, revision 2): its refresh's key read captures absent@2 and parks.
    holdArmed = true;
    await store.clearApiKey();
    await flush();
    expect(q('key-indicator').dataset.state).toBe('present'); // B's refresh is parked

    // Event A (key-set, revision 3): its refresh applies fresh present@3.
    await store.setApiKey('abc');
    await flush();
    expect(q('key-indicator').dataset.state).toBe('present');

    // B's parked refresh completes LAST carrying absent@2: dropped (stale ticket; older fact).
    keyReadHold.release();
    await flush();
    expect(q('key-indicator').dataset.state).toBe('present');
    expect(memory.data[API_KEY_STORAGE_KEY]).toBe('abc');
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
    teardowns.push(await mountPopupPage(document.getElementById('app')!, {
      store,
      saveSettings,
      openOptions: async () => undefined,
      now: () => NOW,
    }));

    // The user toggles the master off; the write persists but the reply is still in flight.
    const toggle = q<HTMLInputElement>('master-toggle');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect((await store.getSettings()).enabled).toBe(false);
    expect(toggle.checked).toBe(false);

    // A newer write from another context lands; the page follows it (revision 2 beats 1).
    await writer.setSettings({ enabled: true });
    await flush();
    expect(toggle.checked).toBe(true);

    // The stale reply (revision 1, enabled: false) finally resolves: no repaint of the old state.
    releaseReply();
    await flush();
    expect(toggle.checked).toBe(true);
    expect(q('master-label').textContent).toBe(COPY.masterOn);
    expect(q('toggle-error').textContent).toBe('');
    expect((await store.getSettings()).enabled).toBe(true);
  });

  it('keeps the latest toggle attempt in charge when a superseded attempt then fails', async () => {
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
    teardowns.push(await mountPopupPage(document.getElementById('app')!, {
      store: createSettingsStore(createMemoryBackend().backend),
      saveSettings,
      openOptions: async () => undefined,
      now: () => NOW,
    }));

    const toggle = q<HTMLInputElement>('master-toggle');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    // The newer attempt resolves first and owns the switch; the superseded attempt then FAILS,
    // which must not overwrite the newer attempt's state with an error.
    resolvers[1]?.({ settings: { ...DEFAULT_SETTINGS, enabled: true }, settingsRevision: 2 });
    await flush();
    expect(toggle.checked).toBe(true);
    expect(q('toggle-error').textContent).toBe('');
    rejecters[0]?.(new Error('write failed'));
    await flush();
    expect(toggle.checked).toBe(true);
    expect(q('toggle-error').textContent).toBe('');
  });

  it('keeps the latest toggle attempt in charge when a superseded attempt then succeeds', async () => {
    const resolvers: Array<(reply: SettingsWriteResult) => void> = [];
    const saveSettings = vi.fn(
      () => new Promise<SettingsWriteResult>((resolve) => void resolvers.push(resolve)),
    );
    document.body.innerHTML = '<div id="app"></div>';
    teardowns.push(await mountPopupPage(document.getElementById('app')!, {
      store: createSettingsStore(createMemoryBackend().backend),
      saveSettings,
      openOptions: async () => undefined,
      now: () => NOW,
    }));

    const toggle = q<HTMLInputElement>('master-toggle');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    // The newer attempt (revision 2) resolves first; the older reply (revision 1) arrives later
    // and must neither repaint the switch nor trigger an error.
    resolvers[1]?.({ settings: { ...DEFAULT_SETTINGS, enabled: true }, settingsRevision: 2 });
    await flush();
    resolvers[0]?.({ settings: { ...DEFAULT_SETTINGS, enabled: false }, settingsRevision: 1 });
    await flush();
    expect(toggle.checked).toBe(true);
    expect(q('master-label').textContent).toBe(COPY.masterOn);
    expect(q('toggle-error').textContent).toBe('');
  });

  // Regression (scrutiny round 5): a subscription-triggered refresh can capture its snapshot
  // BEFORE a newer save reply applies — the reply renders the master switch directly, without
  // starting a new refresh, so the older refresh can still be the newest ticket when it
  // completes. It must not repaint its older snapshot: the gate rejects its revision and it is
  // not a same-revision re-read.
  it('drops a delayed subscription refresh whose snapshot lost to a newer save reply', async () => {
    const memory = createMemoryBackend();
    const store = createSettingsStore(memory.backend); // the page's read/subscribe view
    const writer = createSettingsStore(memory.backend); // stands in for another context's writer
    let armReadHold = false; // arms a hold on the next page read after it captures
    const readHold = { release: () => {} };
    const storeView: PageSettingsStore = {
      ...store,
      async getSettingsWithRevision() {
        const snapshot = await store.getSettingsWithRevision();
        if (armReadHold) {
          armReadHold = false;
          await new Promise<void>((resolve) => (readHold.release = resolve));
        }
        return snapshot;
      },
    };
    // The newer save reply: shaped like the background's answer (revision 2) and rendered
    // directly by the toggle path without starting a refresh or touching storage.
    const saveSettings = vi.fn(async (update: Partial<Settings>): Promise<SettingsWriteResult> => ({
      settings: { ...DEFAULT_SETTINGS, ...update },
      settingsRevision: 2,
    }));
    document.body.innerHTML = '<div id="app"></div>';
    teardowns.push(await mountPopupPage(document.getElementById('app')!, {
      store: storeView,
      saveSettings,
      openOptions: async () => undefined,
      now: () => NOW,
    }));

    // A settings write from another context lands; the subscription starts a refresh whose read
    // captures the revision-1 snapshot and parks (still the newest ticket).
    armReadHold = true;
    await writer.setSettings({ enabled: true, minDraftLength: 40 });
    await flush();

    // A newer save reply (revision 2) applies directly: the switch turns off.
    const toggle = q<HTMLInputElement>('master-toggle');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(toggle.checked).toBe(false);
    expect(q('master-label').textContent).toBe(COPY.masterOff);

    // The parked refresh (revision 1, enabled: true) completes while still the newest ticket:
    // it must not repaint the older state over the applied revision-2 reply.
    readHold.release();
    await flush();
    expect(toggle.checked).toBe(false);
    expect(q('master-label').textContent).toBe(COPY.masterOff);
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
