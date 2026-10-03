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
  /**
   * Records a send when capacity remains; false means the send is denied (typed failure, no
   * wait) — the window is full, or durable accounting could not be established (fail closed).
   */
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
 * suspended right after a send rehydrates with that send counted.
 *
 * FAILS CLOSED (VAL-DRAFT-031): the hard maximum is only honest if the window is durable. When
 * the hydration read rejects, or a reservation's write rejects, durable rate accounting cannot be
 * established — so the limiter denies the send (typed rate-limited failure) instead of sending
 * with an unpersisted stamp. Fail-open here would let an MV3 restart rehydrate an empty/old
 * window and admit requests beyond the configured maximum; it would also silently drop to
 * in-memory-only accounting. The denial is the analyzer's honest degraded outcome: the overlay
 * shows its explicit notice while the local score stays usable.
 */
export function createPersistentRateLimiter(
  area: VerdictCacheArea,
  maxRequests: number,
  windowMs: number,
  now: () => number,
): RateLimiter {
  let sends: number[] = [];
  // Durable accounting is a precondition for sending: `durable` flips true only after a
  // successful hydration read, and a rejected read denies every acquire from then on.
  let durable = false;
  const hydrated: Promise<void> = area
    .get(RATE_WINDOW_STORAGE_KEY)
    .then((stored) => {
      sends = parseSends(stored[RATE_WINDOW_STORAGE_KEY], now(), windowMs);
      durable = true;
    })
    .catch(() => undefined); // durable stays false: accounting is unknown, so every send is denied

  // Write-serialized persistence (the verdict-cache pattern): a failed write must not poison
  // later ones, and its own caller still sees the rejection.
  let writeChain: Promise<unknown> = Promise.resolve();

  return {
    async tryAcquire() {
      await hydrated;
      if (!durable) return false; // unreadable store: no honest ceiling, so no send
      const at = now();
      sends = sends.filter((sentAt) => at - sentAt < windowMs);
      if (sends.length >= maxRequests) return false; // full window: typed denial, nothing changed
      sends.push(at);
      const write = writeChain.then(async () => {
        await area.set({ [RATE_WINDOW_STORAGE_KEY]: [...sends] });
      });
      writeChain = write.catch(() => undefined);
      try {
        await write;
      } catch {
        // The stamp was not durably stored: roll THIS acquire's own stamp back (by value —
        // concurrent acquires share the array, so popping the tail could remove someone else's),
        // keeping the in-memory window a mirror of the durable one.
        const pushed = sends.indexOf(at);
        if (pushed !== -1) sends.splice(pushed, 1);
        return false; // unpersistable reservation: deny the send (fail closed)
      }
      return true;
    },
  };
}
