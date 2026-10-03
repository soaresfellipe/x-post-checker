import type { ConnectionTestResult } from '@/core/jev-client';
import { createRevisionGate } from '@/core/message-protocol/broadcast';
import {
  DEFAULT_SETTINGS,
  NUMERIC_LIMITS,
  SETTINGS_KEYS,
  type PageSettingsStore,
  type Settings,
  type SettingsWriteResult,
} from '@/core/settings-store';
import { OPTIONS_TEMPLATE } from './template';

export interface OptionsPageDeps {
  /** Read-only view of storage; the settings WRITE path is `saveSettings` (background single writer). */
  store: PageSettingsStore;
  /**
   * Persists a settings update through the background and resolves with the persisted settings and
   * the revision of the write, so the snapshot is applied only when strictly newer than what this
   * page already applied (a delayed older reply must never repaint a newer state).
   */
  saveSettings(update: Partial<Settings>): Promise<SettingsWriteResult>;
  /** Runs the connection test in the background; resolves with the result tagged by `attemptId`. */
  testConnection(attemptId: string, apiKey: string | undefined): Promise<{ attemptId: string; result: ConnectionTestResult }>;
}

const BOOLEAN_PREFS = ['enabled', 'autoAnalyze', 'jevForDrafts', 'jevForTargets'] as const;
const NUMERIC_PREFS = ['minDraftLength', 'targetThreshold'] as const;

export const COPY = {
  keyMissing: 'No API key saved.',
  keyPresent: 'API key saved. It stays hidden here; paste a new key to replace it.',
  keyPlaceholderSaved: 'Saved key hidden. Paste a new key to replace it.',
  keyPlaceholderEmpty: 'Paste your Jev API key',
  emptyKey: 'Enter an API key before saving.',
  saving: 'Saving…',
  saved: 'API key saved.',
  saveFailed: 'Could not save the API key. Nothing was changed. Try again.',
  removed: 'API key removed.',
  removeFailed: 'Could not remove the API key. Try again.',
  testing: 'Testing connection…',
  noKey: 'No API key to test. Enter or save a key first.',
  invalidKey: (status?: number) =>
    `Invalid API key. Jev rejected the key${status ? ` (HTTP ${status})` : ''}. Check the key and try again. Your saved key was not changed.`,
  networkUnreachable: 'Network error. Could not reach api.typesafe.ai. Check your connection and try again. Your saved key was not changed.',
  networkTimeout: 'Network error. The request to api.typesafe.ai timed out. Check your connection and try again. Your saved key was not changed.',
  unexpected: (status: number) => `Jev returned an unexpected response (HTTP ${status}). Try again later. Your saved key was not changed.`,
  testUnavailable: 'The connection test could not run. Reload the extension and try again.',
  connected: (model: string, latencyMs: number) => `Connected. Model: ${model}. Latency: ${latencyMs} ms.`,
  prefsSaved: 'Preferences saved.',
  prefsFailed: 'Could not save preferences. Try again.',
  prefsInvalid: (key: (typeof NUMERIC_PREFS)[number]) =>
    `Enter a whole number from ${NUMERIC_LIMITS[key].min} to ${NUMERIC_LIMITS[key].max}.`,
} as const;

function byId<T extends HTMLElement>(root: ParentNode, id: string): T {
  const found = root.querySelector<T>(`#${id}`);
  if (!found) throw new Error(`Options page template is missing #${id}`);
  return found;
}

/** Renders the Options page into `root` and wires it to the store. Returns a teardown function. */
export async function mountOptionsPage(root: HTMLElement, deps: OptionsPageDeps): Promise<() => void> {
  const parsed = new DOMParser().parseFromString(OPTIONS_TEMPLATE, 'text/html');
  root.replaceChildren(...Array.from(parsed.body.childNodes, (node) => root.ownerDocument.importNode(node, true)));
  const { store } = deps;

  const keyInput = byId<HTMLInputElement>(root, 'api-key');
  const toggleButton = byId<HTMLButtonElement>(root, 'toggle-key');
  const saveButton = byId<HTMLButtonElement>(root, 'save-key');
  const testButton = byId<HTMLButtonElement>(root, 'test-connection');
  const removeButton = byId<HTMLButtonElement>(root, 'remove-key');
  const keyStatus = byId<HTMLElement>(root, 'key-status');
  const saveStatus = byId<HTMLElement>(root, 'save-status');
  const testResult = byId<HTMLElement>(root, 'test-result');
  const prefsStatus = byId<HTMLElement>(root, 'prefs-status');
  const booleanInputs = Object.fromEntries(
    BOOLEAN_PREFS.map((key) => [key, byId<HTMLInputElement>(root, `pref-${key}`)]),
  ) as Record<(typeof BOOLEAN_PREFS)[number], HTMLInputElement>;
  const numberInputs = Object.fromEntries(
    NUMERIC_PREFS.map((key) => [key, byId<HTMLInputElement>(root, `pref-${key}`)]),
  ) as Record<(typeof NUMERIC_PREFS)[number], HTMLInputElement>;

  function setMessage(target: HTMLElement, text: string, state: string): void {
    target.textContent = text;
    target.dataset.state = state;
  }

  function renderKeyPresence(present: boolean): void {
    setMessage(keyStatus, present ? COPY.keyPresent : COPY.keyMissing, present ? 'present' : 'absent');
    keyInput.placeholder = present ? COPY.keyPlaceholderSaved : COPY.keyPlaceholderEmpty;
    removeButton.disabled = !present;
  }

  // The settings snapshot currently rendered — every render goes through the revision-gated apply
  // paths below, so this is always the newest gate-accepted state. A failed or invalid save
  // re-renders it to restore the controls its attempt touched: nothing was persisted, so the last
  // applied state is still the store's current state, and no reread is needed.
  let appliedSettings: Settings = { ...DEFAULT_SETTINGS };

  function renderSettings(settings: Settings): void {
    appliedSettings = settings;
    for (const key of BOOLEAN_PREFS) booleanInputs[key].checked = settings[key];
    for (const key of NUMERIC_PREFS) numberInputs[key].value = String(settings[key]);
  }

  function setKeyVisible(visible: boolean): void {
    keyInput.type = visible ? 'text' : 'password';
    toggleButton.textContent = visible ? 'Hide' : 'Show';
    toggleButton.setAttribute('aria-pressed', String(visible));
    toggleButton.setAttribute('aria-label', visible ? 'Hide API key' : 'Show API key');
  }

  // Strictly-newer revision gate over every settings snapshot this page is offered: the initial
  // read, storage changes made elsewhere, and its own save replies. A delayed older snapshot
  // (e.g. a save reply that resolves after a newer write from another context landed) is never
  // rendered; the page re-reads the store instead, converging on the newest state.
  const revisionGate = createRevisionGate();

  /**
   * Initial render from the store, gated at COMPLETION: a storage change whose event already
   * applied during the read must not be regressed by this older snapshot — the subscription owns
   * the newer state, so a rejected read renders nothing.
   */
  async function renderInitialFromStore(): Promise<void> {
    const [{ settings, revision }, hasKey] = await Promise.all([store.getSettingsWithRevision(), store.hasApiKey()]);
    if (!revisionGate.accept(revision)) return;
    renderKeyPresence(hasKey);
    renderSettings(settings);
  }

  /**
   * Resync from the store after a superseded save reply (one whose revision the gate rejected, so
   * the state it persisted may not have been applied here yet). The reread is gated at COMPLETION:
   * a newer write can land while it is in flight (its storage event then applies the newer state
   * through the subscription), which makes this reread stale — when the gate rejects it, this
   * reread renders nothing and does NOT schedule another resync (at most one resync per
   * rejection); convergence to the newest state is the already-registered subscription's job.
   */
  async function resyncFromStore(): Promise<void> {
    const [{ settings, revision }, hasKey] = await Promise.all([store.getSettingsWithRevision(), store.hasApiKey()]);
    if (!revisionGate.accept(revision)) return;
    renderKeyPresence(hasKey);
    renderSettings(settings);
  }

  /** Applies a save-reply snapshot only when strictly newer than everything applied so far. */
  function applySaveReply(reply: SettingsWriteResult): void {
    if (revisionGate.accept(reply.settingsRevision)) {
      renderSettings(reply.settings);
    } else {
      // A newer state was already applied (initial read, subscription, or a newer reply):
      // converge on the store instead of repainting this reply's older snapshot.
      void resyncFromStore();
    }
  }

  // Subscribed before the initial read so a change landing during that read is applied by the
  // event and the (older) read snapshot is then rejected by the revision gate, never repainting
  // stale settings over a newer state.
  const unsubscribe = store.subscribe((change) => {
    const touchesSettings = change.changedKeys.some((key) => (SETTINGS_KEYS as readonly string[]).includes(key));
    if (touchesSettings && !revisionGate.accept(change.revision)) return; // superseded settings state
    renderKeyPresence(change.apiKeyPresent);
    if (touchesSettings) renderSettings(change.settings);
  });
  await renderInitialFromStore();

  toggleButton.addEventListener('click', () => setKeyVisible(keyInput.type === 'password'));

  saveButton.addEventListener('click', async () => {
    const key = keyInput.value.trim();
    if (!key) {
      setMessage(saveStatus, COPY.emptyKey, 'error');
      return;
    }
    saveButton.disabled = true;
    setMessage(saveStatus, COPY.saving, 'pending');
    try {
      await store.setApiKey(key);
      keyInput.value = '';
      setKeyVisible(false);
      renderKeyPresence(true);
      setMessage(saveStatus, COPY.saved, 'success');
    } catch {
      setMessage(saveStatus, COPY.saveFailed, 'error');
    } finally {
      saveButton.disabled = false;
    }
  });

  removeButton.addEventListener('click', async () => {
    try {
      await store.clearApiKey();
      renderKeyPresence(false);
      setMessage(saveStatus, COPY.removed, 'success');
    } catch {
      setMessage(saveStatus, COPY.removeFailed, 'error');
    }
  });

  let latestAttempt = 0;
  testButton.addEventListener('click', async () => {
    const attempt = ++latestAttempt;
    const attemptId = `attempt-${attempt}`;
    testButton.disabled = true;
    setMessage(testResult, COPY.testing, 'pending');
    let message: string;
    let state: string;
    try {
      const typed = keyInput.value.trim();
      const reply = await deps.testConnection(attemptId, typed || undefined);
      if (reply.attemptId !== attemptId || attempt !== latestAttempt) return;
      ({ message, state } = describeResult(reply.result));
    } catch {
      if (attempt !== latestAttempt) return;
      message = COPY.testUnavailable;
      state = 'error';
    } finally {
      if (attempt === latestAttempt) testButton.disabled = false;
    }
    setMessage(testResult, message, state);
  });

  // Save feedback stays tied to its own request attempt (same pattern as the connection test):
  // when replies race, only the latest attempt owns the status line; superseded attempts are
  // dropped without touching the controls. The settings render itself is revision-gated.
  let latestPrefsSave = 0;
  async function savePrefs(update: Partial<Settings>): Promise<void> {
    const attempt = ++latestPrefsSave;
    try {
      const reply = await deps.saveSettings(update);
      if (attempt !== latestPrefsSave) return;
      applySaveReply(reply);
      setMessage(prefsStatus, COPY.prefsSaved, 'success');
    } catch {
      if (attempt !== latestPrefsSave) return;
      renderSettings(appliedSettings); // nothing persisted: the applied state is still the store's
      setMessage(prefsStatus, COPY.prefsFailed, 'error');
    }
  }

  for (const key of BOOLEAN_PREFS) {
    booleanInputs[key].addEventListener('change', () => void savePrefs({ [key]: booleanInputs[key].checked }));
  }
  for (const key of NUMERIC_PREFS) {
    numberInputs[key].addEventListener('change', async () => {
      const raw = numberInputs[key].value.trim();
      const value = Number(raw);
      const { min, max } = NUMERIC_LIMITS[key];
      if (raw === '' || !Number.isInteger(value) || value < min || value > max) {
        renderSettings(appliedSettings); // nothing persisted: restore the controls the edit moved
        setMessage(prefsStatus, COPY.prefsInvalid(key), 'error');
        return;
      }
      await savePrefs({ [key]: value });
    });
  }

  return () => {
    unsubscribe();
    root.replaceChildren();
  };
}

function describeResult(result: ConnectionTestResult): { message: string; state: string } {
  switch (result.status) {
    case 'ok':
      return { message: COPY.connected(result.model, result.latencyMs), state: 'success' };
    case 'invalid-key':
      return { message: COPY.invalidKey(result.httpStatus), state: 'invalid-key' };
    case 'network':
      return {
        message: result.reason === 'timeout' ? COPY.networkTimeout : COPY.networkUnreachable,
        state: 'network',
      };
    case 'error':
      return { message: COPY.unexpected(result.httpStatus), state: 'error' };
    case 'no-key':
      return { message: COPY.noKey, state: 'no-key' };
  }
}
