/**
 * Watcher observability on the marker host (the M1 Shadow-DOM anchor): inert data-* attributes
 * for E2E and debugging. The marker is the only page surface the extension owns, so its dataset
 * is the natural place for "is a composer being watched" diagnostics. Never renders anything.
 */
import { MARKER_HOST_ID } from '@/dom/marker';

export interface WatcherDiagnostics {
  /** 'watching' while a composer is attached, 'idle' otherwise. */
  state?: 'watching' | 'idle';
  /** Watched composer testid, 'structural' for the fallback match, '(none)' when unattached. */
  composer?: string;
  /** Total analysis dispatches (automatic + explicit) since the tab's watcher was created. */
  dispatches?: number;
}

export function stampWatcherDiagnostics(doc: Document, patch: WatcherDiagnostics): void {
  const host = doc.getElementById(MARKER_HOST_ID);
  if (!host) return;
  if (patch.state !== undefined) host.dataset.watcherState = patch.state;
  if (patch.composer !== undefined) host.dataset.watcherComposer = patch.composer;
  if (patch.dispatches !== undefined) host.dataset.watcherDispatches = String(patch.dispatches);
}
