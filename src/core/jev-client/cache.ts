/**
 * Verdict cache adapters. The cache stores typed verdicts keyed by the draft hash — never the
 * draft text or the API key. The default in-memory adapter serves a live session; the storage
 * adapter persists verdicts in `storage.local` so the cache survives service-worker restarts
 * (Chrome suspends MV3 workers after ~30s idle; a retyped identical draft must still be free).
 */
import type { JevVerdict } from '@/core/heuristic-engine';
import { JEV_CACHE_MAX_ENTRIES, type MainWeaknessId, type ReplyAngleId } from './config';

/** One cached verdict: the parsed outcome of an earlier analysis of an identical request. */
export interface JevCachedVerdict {
  readonly verdict: JevVerdict;
  readonly mainWeakness: MainWeaknessId;
  /** Epoch milliseconds of the analysis that produced this verdict. */
  readonly at: number;
}

export interface JevVerdictCache {
  get(key: string): Promise<JevCachedVerdict | undefined>;
  set(key: string, entry: JevCachedVerdict): Promise<void>;
}

/** Structural validation: a corrupt entry is a cache miss, never a fabricated verdict. */
export function isJevCachedVerdict(value: unknown): value is JevCachedVerdict {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const verdict = candidate.verdict as Record<string, unknown> | undefined;
  if (typeof verdict !== 'object' || verdict === null) return false;
  return (
    typeof verdict.ordinal === 'number' &&
    Number.isFinite(verdict.ordinal) &&
    typeof verdict.confidence === 'number' &&
    Number.isFinite(verdict.confidence) &&
    typeof verdict.band === 'string' &&
    Array.isArray(verdict.weaknesses) &&
    typeof candidate.mainWeakness === 'string' &&
    typeof candidate.at === 'number' &&
    Number.isFinite(candidate.at)
  );
}

/** In-memory LRU cache; the default for tests and short-lived sessions. */
export function createMemoryVerdictCache(maxEntries: number = JEV_CACHE_MAX_ENTRIES): JevVerdictCache {
  const entries = new Map<string, JevCachedVerdict>();
  return {
    async get(key) {
      return entries.get(key);
    },
    async set(key, entry) {
      if (!isJevCachedVerdict(entry)) return; // never store garbage
      // Re-inserting refreshens recency; over capacity, the least recently used entry goes first.
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}

/** The `storage.local` key holding the persisted verdict cache (a plain map, no draft content). */
export const VERDICT_CACHE_STORAGE_KEY = 'jevVerdictCache';

/** The `storage.local` key holding the persisted TARGET verdict cache (per post id, no post text). */
export const TARGET_VERDICT_CACHE_STORAGE_KEY = 'jevTargetVerdictCache';

/** The storage.area slice the adapter needs: exactly what `browser.storage.local` provides. */
export interface VerdictCacheArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/**
 * Persistent verdict cache over a storage area. Reads are defensive (corrupt data -> miss) and
 * writes are serialized through a promise chain so two verdicts landing concurrently can never
 * lose each other's read-modify-write.
 */
export function createStorageVerdictCache(
  area: VerdictCacheArea,
  maxEntries: number = JEV_CACHE_MAX_ENTRIES,
): JevVerdictCache {
  // Serialized read-modify-write, like the settings store's write chain: a failed write must not
  // poison later ones; its own caller still sees the rejection (the client swallows it).
  let writeChain: Promise<unknown> = Promise.resolve();

  async function readMap(): Promise<Record<string, JevCachedVerdict>> {
    try {
      const stored = (await area.get(VERDICT_CACHE_STORAGE_KEY))[VERDICT_CACHE_STORAGE_KEY];
      if (typeof stored !== 'object' || stored === null) return {};
      const map: Record<string, JevCachedVerdict> = {};
      for (const [key, value] of Object.entries(stored)) {
        if (isJevCachedVerdict(value)) map[key] = value;
      }
      return map;
    } catch {
      return {}; // an unreadable store is a miss, never a failure for the analysis
    }
  }

  return {
    async get(key) {
      const map = await readMap();
      return map[key];
    },
    set(key, entry) {
      if (!isJevCachedVerdict(entry)) return Promise.resolve(); // never store garbage
      const write = writeChain.then(async () => {
        const map = await readMap();
        map[key] = entry;
        // Capacity by age: keep the newest `maxEntries` verdicts.
        const kept = Object.entries(map)
          .sort(([, a], [, b]) => a.at - b.at)
          .slice(-maxEntries);
        await area.set({ [VERDICT_CACHE_STORAGE_KEY]: Object.fromEntries(kept) });
      });
      writeChain = write.catch(() => undefined);
      return write;
    },
  };
}

/**
 * One cached TARGET verdict (VAL-TARGET-020): the parsed outcome of an earlier deep analysis of
 * this post. `angle` is optional because it renders as a suggestion, never as a verdict input.
 */
export interface TargetCachedVerdict {
  readonly verdict: JevVerdict;
  readonly angle?: { readonly choice: ReplyAngleId; readonly confidence: number };
  /** Epoch milliseconds of the analysis that produced this verdict. */
  readonly at: number;
}

/** Structural validation: a corrupt entry is a cache miss, never a fabricated verdict. */
export function isTargetCachedVerdict(value: unknown): value is TargetCachedVerdict {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const verdict = candidate.verdict as Record<string, unknown> | undefined;
  if (typeof verdict !== 'object' || verdict === null) return false;
  if (typeof verdict.ordinal !== 'number' || !Number.isFinite(verdict.ordinal)) return false;
  if (typeof verdict.confidence !== 'number' || !Number.isFinite(verdict.confidence)) return false;
  if (typeof verdict.band !== 'string') return false;
  if (candidate.at !== undefined && (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at))) return false;
  if (candidate.angle === undefined) return true;
  if (typeof candidate.angle !== 'object' || candidate.angle === null) return false;
  const angle = candidate.angle as Record<string, unknown>;
  return typeof angle.choice === 'string' && typeof angle.confidence === 'number' && Number.isFinite(angle.confidence);
}

export interface TargetVerdictCache {
  get(key: string): Promise<TargetCachedVerdict | undefined>;
  set(key: string, entry: TargetCachedVerdict): Promise<void>;
}

/** In-memory LRU cache; the default for tests and short-lived sessions. */
export function createMemoryTargetVerdictCache(maxEntries: number = JEV_CACHE_MAX_ENTRIES): TargetVerdictCache {
  const entries = new Map<string, TargetCachedVerdict>();
  return {
    async get(key) {
      return entries.get(key);
    },
    async set(key, entry) {
      if (!isTargetCachedVerdict(entry)) return; // never store garbage
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}

/** Shared storage read-modify-write over one namespaced map (the draft adapter's exact pattern). */
function createStorageCacheStore<T>(
  area: VerdictCacheArea,
  storageKey: string,
  maxEntries: number,
  validate: (value: unknown) => value is T,
) {
  let writeChain: Promise<unknown> = Promise.resolve();

  async function readMap(): Promise<Record<string, T>> {
    try {
      const stored = (await area.get(storageKey))[storageKey];
      if (typeof stored !== 'object' || stored === null) return {};
      const map: Record<string, T> = {};
      for (const [key, value] of Object.entries(stored)) {
        if (validate(value)) map[key] = value;
      }
      return map;
    } catch {
      return {}; // an unreadable store is a miss, never a failure for the analysis
    }
  }

  return {
    async get(key: string) {
      const map = await readMap();
      return map[key];
    },
    set(key: string, entry: T) {
      if (!validate(entry)) return Promise.resolve(); // never store garbage
      const write = writeChain.then(async () => {
        const map = await readMap();
        map[key] = entry;
        // Capacity by age: keep the newest `maxEntries` verdicts.
        const kept = Object.entries(map)
          .sort(([, a], [, b]) => (a as { at: number }).at - (b as { at: number }).at)
          .slice(-maxEntries);
        await area.set({ [storageKey]: Object.fromEntries(kept) });
      });
      writeChain = write.catch(() => undefined);
      return write;
    },
  };
}

/**
 * Persistent TARGET verdict cache over a storage area. Same semantics as the draft adapter:
 * defensive reads (corrupt data -> miss), serialized writes, capacity by age. Survives MV3
 * service-worker suspension, so a popover reopened after a background restart still needs zero
 * API calls (VAL-TARGET-020).
 */
export function createStorageTargetVerdictCache(
  area: VerdictCacheArea,
  maxEntries: number = JEV_CACHE_MAX_ENTRIES,
): TargetVerdictCache {
  return createStorageCacheStore<TargetCachedVerdict>(
    area,
    TARGET_VERDICT_CACHE_STORAGE_KEY,
    maxEntries,
    isTargetCachedVerdict,
  );
}
