/**
 * Ordering diagnostics for the settings-broadcast/storage path (VAL-CROSS-002 escalation).
 *
 * Records the ORDER of state facts as they cross the pipeline Options -> background single-writer
 * -> open tab (broadcast + storage.onChanged) -> key-presence gate -> settings sync -> overlay
 * render. The e2e/smoke builds expose the ring buffer on `window.__amplifyxOrderingLog` so a spec
 * can dump the interleaving when a row/block disagreement is observed. Release builds compile to
 * no-ops (every call site gates on `isE2EBuild()`), so the shipped extension is untouched.
 */
import { isE2EBuild } from './test-hooks';

const LOG_KEY = '__amplifyxOrderingLog';
const LOG_LIMIT = 600;

/** One ordered pipeline event; fields are free-form per call site. */
export type OrderingEntry = Record<string, unknown> & { t: number; at: string };

type LogWindow = Record<string, unknown> & { [LOG_KEY]?: OrderingEntry[] };

/** Appends one event to the e2e-only ordering log (no-op in release builds). */
export function logOrdering(event: Record<string, unknown>): void {
  if (!isE2EBuild()) return;
  const win = window as unknown as LogWindow;
  const log = win[LOG_KEY] ?? [];
  const entry: OrderingEntry = { t: Date.now(), at: new Date().toISOString().slice(11, 23), ...event };
  log.push(entry);
  if (log.length > LOG_LIMIT) log.shift();
  win[LOG_KEY] = log;
}

/** Reads the ordering log (empty in release builds; absent window → empty). */
export function readOrderingLog(): OrderingEntry[] {
  const win = window as unknown as LogWindow;
  return win[LOG_KEY] ?? [];
}
