/**
 * TimelineScanner — scans the VISIBLE timeline articles (throttled, scroll-aware, virtualized-
 * feed safe), extracts PostSnapshots field-for-field, and applies the rescoring policy:
 *
 * - same id + unchanged captured metrics → no rescore (no scoring dispatch);
 * - changed captured metrics → rescored once per change;
 * - new id → scored once;
 * - at most ONE badge host per article (created on first sight, reused across re-renders).
 *
 * Virtualized-feed safety: NO node references are ever cached across scans — every pass re-queries
 * the articles fresh and diffs by post id + metrics signature. When x.com recycles an article node
 * for a different post, the diff sees a new id on that node, dispatches it, and the node's single
 * badge host is reused for the new post (a stale badge is impossible: content is only ever painted
 * from the current dispatch).
 */
import { postMetricsSignature, type PostSnapshot } from '@/core/post-snapshot';
import { findAll } from '@/selectors';
import { extractPostSnapshot } from './extract';
import { stampScannerDiagnostics, type ScannerPostDiagnostic } from './diagnostics';
import type { ScanEvent, ScanReason, TimelineScanner, TimelineScannerOptions } from './types';

export type { ScanEvent, ScanReason, TimelineScanner, TimelineScannerOptions } from './types';

/** Minimum interval between scan passes (scroll/mutation bursts coalesce into trailing passes). */
export const SCAN_THROTTLE_MS = 250;

/** The badge host attribute: one host per article, the M3 badge feature's mount point. */
export const BADGE_HOST_ATTRIBUTE = 'data-amplifyx-host';
const BADGE_HOST_VALUE = 'badge';

/** Diff-state bound: evict the oldest ids beyond this many tracked posts (bounded memory). */
const MAX_TRACKED_POSTS = 2000;

/** The default visibility check: the article's box intersects the viewport with real area. */
export function defaultArticleVisible(article: Element): boolean {
  const win = article.ownerDocument?.defaultView;
  if (!win) return false;
  const rect = article.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const innerHeight = win.innerHeight ?? 0;
  const innerWidth = win.innerWidth ?? 0;
  return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
}

/** The article's ONE badge host: found, never duplicated; created inert (pointer-events none). */
function ensureBadgeHost(article: Element, doc: Document): HTMLElement {
  const existing = article.querySelector(`[${BADGE_HOST_ATTRIBUTE}="${BADGE_HOST_VALUE}"]`);
  if (existing instanceof HTMLElement) return existing;
  const host = doc.createElement('div');
  host.setAttribute(BADGE_HOST_ATTRIBUTE, BADGE_HOST_VALUE);
  // Inert until the badge feature renders into it; pointer-events discipline per AGENTS.md (the
  // badge feature re-enables pointer events only on its own buttons).
  host.style.pointerEvents = 'none';
  host.style.height = '0';
  host.style.lineHeight = '0';
  article.append(host);
  return host;
}

function removeAllBadgeHosts(doc: Document): void {
  for (const host of doc.querySelectorAll(`[${BADGE_HOST_ATTRIBUTE}="${BADGE_HOST_VALUE}"]`)) host.remove();
}

function toDiagnostic(post: PostSnapshot): ScannerPostDiagnostic {
  return {
    id: post.id,
    replyCount: post.replyCount ?? null,
    repostCount: post.repostCount ?? null,
    likeCount: post.likeCount ?? null,
  };
}

export function createTimelineScanner(options: TimelineScannerOptions = {}): TimelineScanner {
  const doc = options.doc ?? document;
  const win = doc.defaultView ?? window;
  const throttleMs = options.throttleMs ?? SCAN_THROTTLE_MS;
  const isArticleVisible = options.isArticleVisible ?? defaultArticleVisible;
  const dispatchScoring = options.dispatchScoring;
  const extractNow = options.now;

  let running = false;
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  let lastScanAt = 0;
  let scanCount = 0;
  /** id → metrics signature of the last scored capture (the rescoring diff state). */
  const signatures = new Map<string, string>();
  const scanListeners = new Set<(event: ScanEvent) => void>();

  function emit(event: ScanEvent): void {
    for (const listener of scanListeners) listener(event);
  }

  function trimTracked(): void {
    const excess = signatures.size - MAX_TRACKED_POSTS;
    if (excess <= 0) return;
    let dropped = 0;
    for (const key of signatures.keys()) {
      signatures.delete(key);
      if (++dropped >= excess) break;
    }
  }

  function scan(): void {
    if (!running) return;
    lastScanAt = Date.now();
    scanCount += 1;
    // Fresh refs EVERY pass — the virtualized feed recycles nodes; cached references would go stale.
    const articles = findAll(doc, 'article');
    const scanned: ScannerPostDiagnostic[] = [];
    for (const article of articles) {
      if (!isArticleVisible(article)) continue; // off-screen: not scanned until visible
      const post = extractPostSnapshot(article, { now: extractNow?.() });
      if (!post) continue; // structurally not a post article (no status link / no timestamp)
      const host = ensureBadgeHost(article, doc);
      const signature = postMetricsSignature(post);
      const previous = signatures.get(post.id);
      signatures.set(post.id, signature);
      const reason: ScanReason = previous === undefined ? 'new' : previous === signature ? 'unchanged' : 'changed';
      const event: ScanEvent = { post, article, host, reason };
      emit(event);
      if (reason !== 'unchanged') dispatchScoring?.(event); // rescoring policy: new + changed only
      scanned.push(toDiagnostic(post));
    }
    trimTracked();
    stampScannerDiagnostics(doc, { posts: scanned, scanCount, lastScanAt });
  }

  /**
   * Throttle gate with a trailing pass: a burst of triggers runs one scan immediately (when the
   * interval has elapsed) and coalesces everything else into one trailing timer.
   */
  function scheduleScan(): void {
    if (!running) return;
    if (scanTimer !== undefined) return; // a trailing pass is already scheduled — it covers this
    const elapsed = Date.now() - lastScanAt;
    if (elapsed >= throttleMs) {
      scan();
      return;
    }
    scanTimer = setTimeout(() => {
      scanTimer = undefined;
      scan();
    }, Math.max(1, throttleMs - elapsed));
  }

  const onSignal = (): void => scheduleScan(); // scroll, resize, and route signals all coalesce
  const mutationObserver = new MutationObserver(onSignal);

  return {
    start() {
      if (running) return;
      running = true;
      mutationObserver.observe(doc.body ?? doc, { childList: true, subtree: true });
      win.addEventListener('scroll', onSignal, { passive: true });
      win.addEventListener('resize', onSignal);
      win.addEventListener('popstate', onSignal);
      win.addEventListener('hashchange', onSignal);
      stampScannerDiagnostics(doc, { state: 'scanning' });
      scheduleScan();
    },
    stop() {
      if (!running) return;
      running = false;
      mutationObserver.disconnect();
      win.removeEventListener('scroll', onSignal);
      win.removeEventListener('resize', onSignal);
      win.removeEventListener('popstate', onSignal);
      win.removeEventListener('hashchange', onSignal);
      if (scanTimer !== undefined) {
        clearTimeout(scanTimer);
        scanTimer = undefined;
      }
      removeAllBadgeHosts(doc);
      stampScannerDiagnostics(doc, { state: 'idle', posts: [] });
    },
    rescan: scan,
    onScan(listener) {
      scanListeners.add(listener);
      return () => scanListeners.delete(listener);
    },
    getTrackedCount: () => signatures.size,
  };
}
