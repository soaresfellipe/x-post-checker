import {
  API_KEY_STORAGE_KEY,
  DEFAULT_SETTINGS,
  KEY_REVISION_STORAGE_KEY,
  LAST_ANALYSIS_STORAGE_KEY,
  NUMERIC_LIMITS,
  SETTINGS_KEYS,
  SETTINGS_REVISION_STORAGE_KEY,
  type ApiKeyWriteResult,
  type LastAnalysis,
  type Settings,
  type SettingsBackend,
  type SettingsListener,
  type SettingsWriteResult,
  type StorageChange,
} from './types';

const ANALYSIS_OUTCOMES: readonly string[] = ['ok', 'local-only', 'error'] satisfies LastAnalysis['outcome'][];

/** Reads the persisted counter; 0 (unordered) when absent or malformed. */
function toRevision(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

// All store writes (settings and API-key) in one context are serialized so every write reads what
// the previous one persisted, even when callers race (rapid toggles, save+remove in flight). In
// the background — the extension's single writer — this makes both persisted counters a total
// order over writes, which the pages' revision gates rely on to reject stale states.
let writeChain: Promise<unknown> = Promise.resolve();

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
  /** One storage read returns the settings and their revision together (a consistent snapshot). */
  async function getSettingsWithRevision(): Promise<{ settings: Settings; revision: number }> {
    const stored = await backend.area.get([...SETTINGS_KEYS, SETTINGS_REVISION_STORAGE_KEY]);
    return { settings: sanitize(stored), revision: toRevision(stored[SETTINGS_REVISION_STORAGE_KEY]) };
  }

  async function getSettings(): Promise<Settings> {
    return (await getSettingsWithRevision()).settings;
  }

  async function getApiKey(): Promise<string | undefined> {
    const stored = (await backend.area.get(API_KEY_STORAGE_KEY))[API_KEY_STORAGE_KEY];
    return typeof stored === 'string' && stored.length > 0 ? stored : undefined;
  }

  /**
   * One storage read returns the key-presence fact and its revision together (a consistent
   * snapshot): the presence belongs to the revision, so pages can gate the fact on it.
   */
  async function getApiKeyWithRevision(): Promise<{ apiKeyPresent: boolean; keyRevision: number }> {
    const stored = await backend.area.get([API_KEY_STORAGE_KEY, KEY_REVISION_STORAGE_KEY]);
    const apiKey = stored[API_KEY_STORAGE_KEY];
    return {
      apiKeyPresent: typeof apiKey === 'string' && apiKey.length > 0,
      keyRevision: toRevision(stored[KEY_REVISION_STORAGE_KEY]),
    };
  }

  return {
    getSettings,
    getSettingsWithRevision,
    getApiKey,
    getApiKeyWithRevision,

    async hasApiKey(): Promise<boolean> {
      return (await getApiKey()) !== undefined;
    },

    setSettings(update: Partial<Settings>): Promise<SettingsWriteResult> {
      const write = writeChain.then(async () => {
        const stored = await backend.area.get([...SETTINGS_KEYS, SETTINGS_REVISION_STORAGE_KEY]);
        const next = sanitize({ ...stored, ...update });
        const settingsRevision = toRevision(stored[SETTINGS_REVISION_STORAGE_KEY]) + 1;
        const written = Object.fromEntries(
          SETTINGS_KEYS.filter((key) => key in update).map((key) => [key, next[key]]),
        );
        await backend.area.set({ ...written, [SETTINGS_REVISION_STORAGE_KEY]: settingsRevision });
        return { settings: next, settingsRevision };
      });
      // A failed write must not poison later ones; its own caller still sees the rejection.
      writeChain = write.catch(() => undefined);
      return write;
    },

    async getLastAnalysis(): Promise<LastAnalysis | undefined> {
      return parseLastAnalysis((await backend.area.get(LAST_ANALYSIS_STORAGE_KEY))[LAST_ANALYSIS_STORAGE_KEY]);
    },

    async recordAnalysis(entry: LastAnalysis): Promise<void> {
      await backend.area.set({ [LAST_ANALYSIS_STORAGE_KEY]: { at: entry.at, outcome: entry.outcome } });
    },

    /**
     * Stamps the new key and its keyRevision in ONE storage write (the lane's ordering token,
     * docs/state-ordering.md lane (b)). Called only in the background: pages request key writes
     * through `set-api-key`, so the counter is a total order over all key writes.
     */
    async setApiKey(key: string): Promise<ApiKeyWriteResult> {
      const trimmed = key.trim();
      if (!trimmed) throw new Error('API key is empty.');
      const write = writeChain.then(async () => {
        const stored = await backend.area.get([KEY_REVISION_STORAGE_KEY]);
        const keyRevision = toRevision(stored[KEY_REVISION_STORAGE_KEY]) + 1;
        await backend.area.set({ [API_KEY_STORAGE_KEY]: trimmed, [KEY_REVISION_STORAGE_KEY]: keyRevision });
        return { apiKeyPresent: true, keyRevision };
      });
      writeChain = write.catch(() => undefined);
      return write;
    },

    /**
     * Clears the key by persisting the empty string — absent to every reader (`getApiKey` maps ''
     * to undefined) — in the SAME write as the revision bump. A `remove` + revision `set` pair
     * would let a fresh read capture `present` under the NEW revision, which a strictly-newer
     * gate could then never supersede.
     */
    async clearApiKey(): Promise<ApiKeyWriteResult> {
      const write = writeChain.then(async () => {
        const stored = await backend.area.get([KEY_REVISION_STORAGE_KEY]);
        const keyRevision = toRevision(stored[KEY_REVISION_STORAGE_KEY]) + 1;
        await backend.area.set({ [API_KEY_STORAGE_KEY]: '', [KEY_REVISION_STORAGE_KEY]: keyRevision });
        return { apiKeyPresent: false, keyRevision };
      });
      writeChain = write.catch(() => undefined);
      return write;
    },

    /** Calls `listener` after any local-area change to a setting or the key. Returns an unsubscribe. */
    subscribe(listener: SettingsListener): () => void {
      const relevant = new Set<string>([...SETTINGS_KEYS, API_KEY_STORAGE_KEY]);
      const onChanged = (changes: Record<string, StorageChange>, areaName: string) => {
        if (areaName !== 'local') return;
        const changedKeys = Object.keys(changes).filter((key) => relevant.has(key));
        if (changedKeys.length === 0) return;
        const revision = toRevision(changes[SETTINGS_REVISION_STORAGE_KEY]?.newValue);
        // Presence and keyRevision come from ONE fresh read (a consistent snapshot), so the fact
        // is at least as new as the write that fired the event and self-consistent with its
        // revision, whatever later writes landed while this read was in flight.
        void Promise.all([getSettings(), getApiKeyWithRevision()]).then(([settings, key]) =>
          listener({
            settings,
            changedKeys,
            apiKeyPresent: key.apiKeyPresent,
            revision,
            keyRevision: key.keyRevision,
          }),
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

/**
 * The slice popup and Options contexts may use: read and observe everything, and write NOTHING —
 * neither settings nor the API key. Both kinds of writes travel through the background's single
 * writer by message (`set-settings`, `set-api-key`, `clear-api-key`), which serializes them and
 * stamps their revisions atomically, making those tokens authoritative.
 */
export type PageSettingsStore = Omit<SettingsStore, 'setSettings' | 'setApiKey' | 'clearApiKey'>;
