/**
 * The sliding-window rate limit's window state. The in-memory limiter serves a single client
 * instance; the storage limiter persists the send timestamps in `storage.local` (the verdict
 * cache's pattern: write-serialized read-modify-write) so the hard ceiling survives MV3
 * service-worker suspension — Chrome idles workers out after ~30s, and a restarted background
 * that kept no window would admit requests beyond the configured maximum (VAL-DRAFT-031). The
 * restarted client rehydrates the persisted window at creation instead of starting from zero.
 */
import type { VerdictCacheArea } from './cache';

/** The `storage.local` key holding the persisted window state (send timestamps, epoch ms). */
export const RATE_WINDOW_STORAGE_KEY = 'jevRateWindow';

export interface RateLimiter {
  /** Records a send when capacity remains; false means the window is full (typed failure, no wait). */
  tryAcquire(): Promise<boolean>;
}

/** In-memory sliding window; the default when no storage area is provided (tests, short sessions). */
export function createMemoryRateLimiter(maxRequests: number, windowMs: number, now: () => number): RateLimiter {
  let sends: number[] = [];
  return {
    async tryAcquire() {
      const at = now();
      sends = sends.filter((sentAt) => at - sentAt < windowMs);
      if (sends.length >= maxRequests) return false;
      sends.push(at);
      return true;
    },
  };
}

/** Defensively parses persisted stamps: junk entries and stamps already out of the window drop. */
function parseSends(raw: unknown, at: number, windowMs: number): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (sentAt): sentAt is number =>
      typeof sentAt === 'number' && Number.isFinite(sentAt) && sentAt <= at && at - sentAt < windowMs,
  );
}

/**
 * Persistent sliding window over a storage area. Rehydration starts at creation (a restarted
 * worker's first acquire waits for the persisted window instead of racing ahead with an empty
 * one) and every acquired stamp is persisted before the caller's send starts, so a worker
 * suspended right after a send rehydrates with that send counted. An unreadable store degrades
 * to the in-memory behavior — a storage failure never blocks analysis.
 */
export function createPersistentRateLimiter(
  area: VerdictCacheArea,
  maxRequests: number,
  windowMs: number,
  now: () => number,
): RateLimiter {
  let sends: number[] = [];
  const hydrated: Promise<void> = area
    .get(RATE_WINDOW_STORAGE_KEY)
    .then((stored) => {
      sends = parseSends(stored[RATE_WINDOW_STORAGE_KEY], now(), windowMs);
    })
    .catch(() => undefined); // unreadable storage: start from an empty window

  // Write-serialized persistence (the verdict-cache pattern): a failed write must not poison
  // later ones, and its own caller still sees the rejection.
  let writeChain: Promise<unknown> = Promise.resolve();

  return {
    async tryAcquire() {
      await hydrated;
      const at = now();
      sends = sends.filter((sentAt) => at - sentAt < windowMs);
      if (sends.length >= maxRequests) return false; // full window: typed denial, nothing changed
      sends.push(at);
      const write = writeChain.then(async () => {
        await area.set({ [RATE_WINDOW_STORAGE_KEY]: [...sends] });
      });
      writeChain = write.catch(() => undefined);
      await write.catch(() => undefined); // a failed write degrades to the in-memory window
      return true;
    },
  };
}
