import type { LastAnalysis, SettingsStore } from '@/core/settings-store';
import { POPUP_TEMPLATE } from './template';

export interface PopupPageDeps {
  store: SettingsStore;
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

  let latestRefresh = 0;
  async function refresh() {
    const ticket = ++latestRefresh;
    const [settings, hasKey, last] = await Promise.all([store.getSettings(), store.hasApiKey(), store.getLastAnalysis()]);
    if (ticket !== latestRefresh) return;
    renderMaster(settings.enabled);
    renderKey(hasKey);
    renderAnalysis(last);
  }

  // Subscribed before the first read so a change landing during that read is never lost.
  const unsubscribeSettings = store.subscribe(() => void refresh());
  const unsubscribeAnalysis = store.subscribeLastAnalysis(() => void refresh());

  await refresh();

  toggle.addEventListener('change', async () => {
    const requested = toggle.checked;
    toggleError.textContent = '';
    try {
      renderMaster((await store.setSettings({ enabled: requested })).enabled);
    } catch {
      toggleError.textContent = COPY.toggleFailed;
      renderMaster((await store.getSettings()).enabled);
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
