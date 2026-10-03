export interface Settings {
  /** Master switch: when off, the content script injects nothing. */
  enabled: boolean;
  /** Analyze drafts automatically while typing; when off, analysis runs on demand only. */
  autoAnalyze: boolean;
  jevForDrafts: boolean;
  jevForTargets: boolean;
  /** Raw character count below which a draft is never analyzed. */
  minDraftLength: number;
  /** Minimum target score (0-100) for a timeline post to get a badge. */
  targetThreshold: number;
}

export type SettingsKey = keyof Settings;

export const SETTINGS_KEYS = [
  'enabled',
  'autoAnalyze',
  'jevForDrafts',
  'jevForTargets',
  'minDraftLength',
  'targetThreshold',
] as const satisfies readonly SettingsKey[];

/** Stored flat in `storage.local` beside the preferences; never in `storage.sync`. */
export const API_KEY_STORAGE_KEY = 'jevApiKey';

/** Outcome record of the most recent draft analysis; written by the analyzer, read by the popup. */
export const LAST_ANALYSIS_STORAGE_KEY = 'lastAnalysis';

/**
 * Monotonic counter stamped into every settings write (same `area.set` call, so it can never drift
 * from the settings it belongs to). It is bookkeeping, not a preference: broadcasts carry it so
 * receivers can reject a delayed older state. 0 means "no order information" (unset storage).
 */
export const SETTINGS_REVISION_STORAGE_KEY = 'settingsRevision';

export type AnalysisOutcome = 'ok' | 'local-only' | 'error';

export interface LastAnalysis {
  /** Epoch milliseconds when the analysis finished. */
  at: number;
  outcome: AnalysisOutcome;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  enabled: true,
  autoAnalyze: true,
  jevForDrafts: true,
  jevForTargets: false,
  minDraftLength: 10,
  targetThreshold: 70,
};

export const NUMERIC_LIMITS = {
  minDraftLength: { min: 1, max: 280 },
  targetThreshold: { min: 0, max: 100 },
} as const;

export interface SettingsChange {
  settings: Settings;
  changedKeys: string[];
  /** Presence only: the key itself is never broadcast. */
  apiKeyPresent: boolean;
  /** Revision stamped by the write that fired this change; 0 when the event carries none. */
  revision: number;
}

export type SettingsListener = (change: SettingsChange) => void;

/**
 * Result of a settings write: the persisted settings plus the revision the write stamped. Replies
 * carry the revision so requesting pages can order the snapshot against storage-driven updates and
 * never repaint a state older than what they already applied.
 */
export interface SettingsWriteResult {
  settings: Settings;
  settingsRevision: number;
}

export interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

/** The slice of `browser.storage.local` + `browser.storage.onChanged` the store depends on. */
export interface SettingsBackend {
  area: {
    get(keys: string | string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(keys: string | string[]): Promise<void>;
  };
  onChanged: {
    addListener(listener: (changes: Record<string, StorageChange>, areaName: string) => void): void;
    removeListener(listener: (changes: Record<string, StorageChange>, areaName: string) => void): void;
  };
}
