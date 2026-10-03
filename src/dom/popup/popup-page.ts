import type { LastAnalysis, PageSettingsStore, Settings } from '@/core/settings-store';
import type { SettingsWriteResult } from '@/core/settings-store/types';
import { createRevisionGate } from '@/core/message-protocol/broadcast';
import { POPUP_TEMPLATE } from './template';

export interface PopupPageDeps {
  /** Read-only view of storage; the settings WRITE path is `saveSettings` (background single writer). */
  store: PageSettingsStore;
  /**
   * Persists a settings update through the background and resolves with the persisted settings and
   * the revision of the write, so the snapshot is applied only when strictly newer than what this
   * page already applied (a delayed older reply must never repaint a newer state).
   */
  saveSettings(update: Partial<Settings>): Promise<SettingsWriteResult>;
  /** Opens the extension Options page in a browser tab. */
  openOptions(): Promise<void>;
  now?: () => number;
}

export const COPY = {
  masterOn: 'AmplifyX is on',
  masterOff: 'AmplifyX is off',
  toggleFailed: 'Could not update the setting. Try again.',
  keyPresent: 'Saved',
  keyMissing: 'Not set. Add a key in Options.',
  analysisEmpty: 'No analysis yet.',
  analysisOk: (when: string) => `Completed ${when}`,
  analysisLocalOnly: (when: string) => `Local score only (AI analysis unavailable) ${when}`,
  analysisError: (when: string) => `Failed ${when}`,
  openOptionsFailed: 'Could not open Options. Try again.',
  justNow: 'just now',
} as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const pad = (value: number) => String(value).padStart(2, '0');

/** Fixed English formatting: `toLocaleString` would follow the browser locale and break the English-only UI. */
export function formatAnalysisTime(at: number, now: number): string {
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return COPY.justNow;
  if (elapsed < HOUR) {
    const minutes = Math.floor(elapsed / MINUTE);
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  }
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  }
  const date = new Date(at);
  return `on ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} at ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function describeAnalysis(last: LastAnalysis, now: number): string {
  const when = formatAnalysisTime(last.at, now);
  if (last.outcome === 'ok') return COPY.analysisOk(when);
  if (last.outcome === 'local-only') return COPY.analysisLocalOnly(when);
  return COPY.analysisError(when);
}

function byId<T extends HTMLElement>(root: ParentNode, id: string): T {
  const found = root.querySelector<T>(`#${id}`);
  if (!found) throw new Error(`Popup template is missing #${id}`);
  return found;
}

/** Renders the popup into `root`. Storage is the single source of truth; every render re-reads it. */
export async function mountPopupPage(root: HTMLElement, deps: PopupPageDeps): Promise<() => void> {
  const parsed = new DOMParser().parseFromString(POPUP_TEMPLATE, 'text/html');
  root.replaceChildren(...Array.from(parsed.body.childNodes, (node) => root.ownerDocument.importNode(node, true)));
  const { store } = deps;
  const now = deps.now ?? Date.now;

  const toggle = byId<HTMLInputElement>(root, 'master-toggle');
  const masterLabel = byId(root, 'master-label');
  const toggleError = byId(root, 'toggle-error');
  const keyIndicator = byId(root, 'key-indicator');
  const lastAnalysis = byId(root, 'last-analysis');
  const optionsButton = byId<HTMLButtonElement>(root, 'open-options');

  function renderMaster(enabled: boolean) {
    toggle.checked = enabled;
    toggle.setAttribute('aria-checked', String(enabled));
    masterLabel.textContent = enabled ? COPY.masterOn : COPY.masterOff;
  }

  function renderKey(present: boolean) {
    keyIndicator.dataset.state = present ? 'present' : 'missing';
    keyIndicator.textContent = present ? COPY.keyPresent : COPY.keyMissing;
  }

  function renderAnalysis(last: LastAnalysis | undefined) {
    if (!last) {
      lastAnalysis.dataset.state = 'empty';
      delete lastAnalysis.dataset.at;
      lastAnalysis.textContent = COPY.analysisEmpty;
      return;
    }
    lastAnalysis.dataset.state = last.outcome;
    lastAnalysis.dataset.at = String(last.at);
    lastAnalysis.textContent = describeAnalysis(last, now());
  }

  // Strictly-newer revision gate over the settings snapshots this page is offered: reads,
  // storage changes made elsewhere, and its own save replies. A delayed older snapshot (e.g. a
  // save reply that resolves after a newer write from another context landed) never repaints the
  // master switch; the page re-reads the store instead, converging on the newest state.
  const revisionGate = createRevisionGate();

  // Key-presence lane (docs/state-ordering.md lane (b)): every key-presence fact this page is
  // offered carries the keyRevision of the state it observed (the write that produced it, or the
  // fresh read that observed it), and passes this strictly-newer gate — separate instance from
  // `revisionGate`, since the two lanes move independently. The refresh ticket orders whole
  // refreshes; the key gate additionally orders the key facts WITHIN the same-revision refresh
  // path, so a fact older than an already-applied one can never repaint presence.
  const keyGate = createRevisionGate();

  let latestRefresh = 0;
  async function refresh() {
    const ticket = ++latestRefresh;
    const [{ settings, revision }, key, last] = await Promise.all([
      store.getSettingsWithRevision(),
      store.getApiKeyWithRevision(),
      store.getLastAnalysis(),
    ]);
    if (ticket !== latestRefresh) return;
    // Application-time ordering for this read (see docs/state-ordering.md): the refresh ticket
    // supersedes any read overtaken by an event (its ticket went stale and the newer refresh
    // applies instead). That is not enough on its own — a save reply renders the master switch
    // DIRECTLY, without starting a refresh, so a parked read can still be the newest ticket while
    // holding an older snapshot. The settings part therefore also passes the revision gate:
    // applied when strictly newer, or when its revision IS the newest applied one (nothing newer
    // has applied — a fresh observation of the current state, e.g. restoring the switch after a
    // failed toggle, or re-rendering after a key-only event, which moves no settings revision).
    // An older snapshot is dropped; convergence is the subscription's next refresh.
    const current = revisionGate.accept(revision) || revision === revisionGate.lastApplied();
    if (!current) return;
    renderMaster(settings.enabled);
    // The key fact is ordered by its own lane: admitted when strictly newer than what the key
    // gate applied (a key-only event always is; an unchanged keyRevision means the indicator is
    // already current and must stay untouched).
    if (keyGate.accept(key.keyRevision)) renderKey(key.apiKeyPresent);
    renderAnalysis(last);
  }

  // Subscribed before the first read so a change landing during that read is never lost.
  const unsubscribeSettings = store.subscribe(() => void refresh());
  const unsubscribeAnalysis = store.subscribeLastAnalysis(() => void refresh());

  await refresh();

  // Save feedback stays tied to its own request attempt (same pattern as the connection test):
  // when replies race, only the latest attempt owns the switch and the error line; superseded
  // attempts are dropped. The switch state itself is revision-gated against the store.
  let latestToggle = 0;
  toggle.addEventListener('change', async () => {
    const attempt = ++latestToggle;
    const requested = toggle.checked;
    toggleError.textContent = '';
    try {
      const reply = await deps.saveSettings({ enabled: requested });
      if (attempt !== latestToggle) return;
      if (revisionGate.accept(reply.settingsRevision)) {
        renderMaster(reply.settings.enabled);
      } else {
        // A newer state was already applied (initial read, subscription, or a newer reply):
        // converge on the store instead of repainting this reply's older snapshot.
        await refresh();
      }
    } catch {
      if (attempt !== latestToggle) return;
      toggleError.textContent = COPY.toggleFailed;
      await refresh();
    }
  });

  optionsButton.addEventListener('click', async () => {
    toggleError.textContent = '';
    try {
      await deps.openOptions();
    } catch {
      toggleError.textContent = COPY.openOptionsFailed;
    }
  });

  return () => {
    unsubscribeSettings();
    unsubscribeAnalysis();
    root.replaceChildren();
  };
}
