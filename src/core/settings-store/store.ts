import {
  API_KEY_STORAGE_KEY,
  DEFAULT_SETTINGS,
  LAST_ANALYSIS_STORAGE_KEY,
  NUMERIC_LIMITS,
  SETTINGS_KEYS,
  type LastAnalysis,
  type Settings,
  type SettingsBackend,
  type SettingsListener,
  type StorageChange,
} from './types';

const ANALYSIS_OUTCOMES: readonly string[] = ['ok', 'local-only', 'error'] satisfies LastAnalysis['outcome'][];

function parseLastAnalysis(raw: unknown): LastAnalysis | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { at, outcome } = raw as Record<string, unknown>;
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) return undefined;
  if (typeof outcome !== 'string' || !ANALYSIS_OUTCOMES.includes(outcome)) return undefined;
  return { at, outcome: outcome as LastAnalysis['outcome'] };
}

function sanitize(raw: Record<string, unknown>): Settings {
  const settings: Settings = { ...DEFAULT_SETTINGS };
  for (const key of ['enabled', 'autoAnalyze', 'jevForDrafts', 'jevForTargets'] as const) {
    const value = raw[key];
    if (typeof value === 'boolean') settings[key] = value;
  }
  for (const key of ['minDraftLength', 'targetThreshold'] as const) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      const { min, max } = NUMERIC_LIMITS[key];
      settings[key] = Math.min(max, Math.max(min, Math.round(value)));
    }
  }
  return settings;
}

export function createSettingsStore(backend: SettingsBackend) {
  async function getSettings(): Promise<Settings> {
    return sanitize(await backend.area.get([...SETTINGS_KEYS]));
  }

  async function getApiKey(): Promise<string | undefined> {
    const stored = (await backend.area.get(API_KEY_STORAGE_KEY))[API_KEY_STORAGE_KEY];
    return typeof stored === 'string' && stored.length > 0 ? stored : undefined;
  }

  return {
    getSettings,
    getApiKey,

    async hasApiKey(): Promise<boolean> {
      return (await getApiKey()) !== undefined;
    },

    async setSettings(update: Partial<Settings>): Promise<Settings> {
      const next = sanitize({ ...(await backend.area.get([...SETTINGS_KEYS])), ...update });
      const written = Object.fromEntries(SETTINGS_KEYS.filter((key) => key in update).map((key) => [key, next[key]]));
      await backend.area.set(written);
      return next;
    },

    async getLastAnalysis(): Promise<LastAnalysis | undefined> {
      return parseLastAnalysis((await backend.area.get(LAST_ANALYSIS_STORAGE_KEY))[LAST_ANALYSIS_STORAGE_KEY]);
    },

    async recordAnalysis(entry: LastAnalysis): Promise<void> {
      await backend.area.set({ [LAST_ANALYSIS_STORAGE_KEY]: { at: entry.at, outcome: entry.outcome } });
    },

    async setApiKey(key: string): Promise<void> {
      const trimmed = key.trim();
      if (!trimmed) throw new Error('API key is empty.');
      await backend.area.set({ [API_KEY_STORAGE_KEY]: trimmed });
    },

    async clearApiKey(): Promise<void> {
      await backend.area.remove(API_KEY_STORAGE_KEY);
    },

    /** Calls `listener` after any local-area change to a setting or the key. Returns an unsubscribe. */
    subscribe(listener: SettingsListener): () => void {
      const relevant = new Set<string>([...SETTINGS_KEYS, API_KEY_STORAGE_KEY]);
      const onChanged = (changes: Record<string, StorageChange>, areaName: string) => {
        if (areaName !== 'local') return;
        const changedKeys = Object.keys(changes).filter((key) => relevant.has(key));
        if (changedKeys.length === 0) return;
        void Promise.all([getSettings(), getApiKey()]).then(([settings, apiKey]) =>
          listener({ settings, changedKeys, apiKeyPresent: apiKey !== undefined }),
        );
      };
      backend.onChanged.addListener(onChanged);
      return () => backend.onChanged.removeListener(onChanged);
    },

    /** Calls `listener` whenever a new analysis outcome is recorded (or the record is removed). */
    subscribeLastAnalysis(listener: (lastAnalysis: LastAnalysis | undefined) => void): () => void {
      const onChanged = (changes: Record<string, StorageChange>, areaName: string) => {
        if (areaName !== 'local' || !(LAST_ANALYSIS_STORAGE_KEY in changes)) return;
        listener(parseLastAnalysis(changes[LAST_ANALYSIS_STORAGE_KEY]?.newValue));
      };
      backend.onChanged.addListener(onChanged);
      return () => backend.onChanged.removeListener(onChanged);
    },
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
