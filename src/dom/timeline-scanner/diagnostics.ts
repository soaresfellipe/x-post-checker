/**
 * Scanner observability on the marker host (the M1 Shadow-DOM anchor): inert data-* attributes
 * for E2E and debugging, mirroring the watcher's diagnostics. Never renders anything; post
 * diagnostics carry ids and counts only (no text, no handles).
 */
import { MARKER_HOST_ID } from '@/dom/marker';

/** One scanned post's identity + engagement counts, for E2E evidence. */
export interface ScannerPostDiagnostic {
  id: string;
  replyCount: number | null;
  repostCount: number | null;
  likeCount: number | null;
}

export interface ScannerDiagnostics {
  /** 'scanning' while running, 'idle' after stop(). */
  state?: 'scanning' | 'idle';
  /** The LAST scan pass's visible posts (order = article order), or [] when none/idle. */
  posts?: ScannerPostDiagnostic[];
  /** Total scan passes since the scanner was created. */
  scanCount?: number;
  /** Epoch ms of the last scan pass. */
  lastScanAt?: number;
  /** Total scoring dispatches (new + changed); stamped by the content-script wiring. */
  dispatches?: number;
}

export function stampScannerDiagnostics(doc: Document, patch: ScannerDiagnostics): void {
  const host = doc.getElementById(MARKER_HOST_ID);
  if (!host) return;
  if (patch.state !== undefined) host.dataset.scannerState = patch.state;
  if (patch.posts !== undefined) host.dataset.scannerPosts = JSON.stringify(patch.posts);
  if (patch.scanCount !== undefined) host.dataset.scannerScanCount = String(patch.scanCount);
  if (patch.lastScanAt !== undefined) host.dataset.scannerLastScan = String(patch.lastScanAt);
  if (patch.dispatches !== undefined) host.dataset.scannerDispatches = String(patch.dispatches);
}
