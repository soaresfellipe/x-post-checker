/**
 * ComposerWatcher — watches the ONE active composer (x.com mounts one per view; reply dialogs
 * rank above the home composer), observes typing IME-safely, and emits debounced DraftSnapshots.
 *
 * Guarantees:
 * - exactly one attachment at a time; re-scans are idempotent (no duplicate events/overlays);
 * - no analysis during IME composition; exactly one capture after compositionend (+debounce);
 * - paste flows through the same debounced path as typing;
 * - editor edits that fire NO input event are still captured through a composer-scoped
 *   content-mutation lane (verified on real x.com: the Draft.js composer performs select-all +
 *   Backspace deletion via its own DOM writes — neither beforeinput nor input fires — so an
 *   input-only watcher left the overlay stuck on the last analyzed panel);
 * - an unchanged draft is never re-emitted (identity dedupe over re-captures);
 * - minDraftLength (raw char count) gates BOTH the automatic path and the explicit request;
 * - autoAnalyze off → typing only captures, never dispatches (manual path stays available);
 * - stop() removes every observer/listener/timer — zero activity while the master switch is off.
 */
import { DRAFT_DEBOUNCE_MS, isDraftEligible, sameDraftSnapshot } from '@/core/draft-snapshot';
import { findAllCandidates } from '@/selectors';
import { extractDraftSnapshot, findComposer } from './extract';
import type {
  ComposerChangeEvent,
  ComposerWatcher,
  ComposerWatcherOptions,
  DraftEvent,
} from './types';

export type { AnalysisDispatch } from './types';

function pickActiveComposer(root: ParentNode): Element | null {
  return findComposer(root);
}

export function createComposerWatcher(options: ComposerWatcherOptions): ComposerWatcher {
  const doc = options.doc ?? document;
  const win = doc.defaultView ?? window;
  const debounceMs = options.debounceMs ?? DRAFT_DEBOUNCE_MS;

  let running = false;
  let active: Element | null = null;
  let composing = false;
  let captureTimer: ReturnType<typeof setTimeout> | undefined;
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSnapshot: DraftEvent['snapshot'] | null = null;
  let contentObserver: MutationObserver | null = null;
  // A user-edit event (input/paste/compositionend) scheduled the pending capture. Such a capture
  // always emits — the user re-editing an identical draft is a fresh analysis request — while
  // AMBIENT content mutations (no user-edit event) may only emit when the draft actually changed.
  let captureForced = false;
  const draftListeners = new Set<(event: DraftEvent) => void>();
  const composerListeners = new Set<(event: ComposerChangeEvent) => void>();

  const isWatchable = (element: Element): boolean =>
    element.isConnected && element.matches('[role="textbox"][contenteditable="true"]');

  function emitDraft(event: DraftEvent): void {
    for (const listener of draftListeners) listener(event);
  }

  function emitComposer(event: ComposerChangeEvent): void {
    for (const listener of composerListeners) listener(event);
  }

  function clearCaptureTimer(): void {
    if (captureTimer !== undefined) {
      clearTimeout(captureTimer);
      captureTimer = undefined;
    }
  }

  function scheduleCapture(): void {
    clearCaptureTimer();
    captureTimer = setTimeout(() => {
      captureTimer = undefined;
      captureNow();
    }, debounceMs);
  }

  function captureNow(): void {
    if (!active) return;
    const snapshot = extractDraftSnapshot(active);
    const forced = captureForced;
    captureForced = false;
    // Identity dedupe: the ambient content-mutation lane re-captures on every editor DOM write,
    // including text-preserving re-renders (decorator polish) — an identical re-capture must not
    // re-emit or re-dispatch. A user-edit event's capture always emits (the retype-retry contract:
    // retyping an identical draft re-dispatches so its own failure can settle with success).
    // `capturedAt` is excluded from the identity on purpose.
    if (!forced && lastSnapshot !== null && sameDraftSnapshot(lastSnapshot, snapshot)) return;
    lastSnapshot = snapshot;
    const eligible = isDraftEligible(snapshot, options.getMinDraftLength());
    emitDraft({ kind: 'captured', snapshot, eligible });
    if (eligible && options.getAutoAnalyze()) options.dispatchAnalysis({ snapshot, trigger: 'auto' });
  }

  function attach(element: Element): void {
    active = element;
    composing = false;
    captureForced = false;
    element.addEventListener('input', onInput);
    element.addEventListener('compositionstart', onCompositionStart);
    element.addEventListener('compositionupdate', onCompositionUpdate);
    element.addEventListener('compositionend', onCompositionEnd);
    element.addEventListener('paste', onPaste);
    // Content-mutation lane: editors can apply edits WITHOUT firing input events (real x.com's
    // Draft.js performs selection deletion entirely through its own DOM writes), so the watcher
    // observes the watched composer's own subtree and runs every content change through the SAME
    // debounced capture. Extension-owned UI never renders inside the composer, so these
    // mutations are always the page's; text-preserving re-renders are dropped by the dedupe.
    contentObserver = new MutationObserver(() => {
      if (composing) return; // composition updates mutate the DOM; compositionend schedules the capture
      scheduleCapture();
    });
    contentObserver.observe(element, { subtree: true, childList: true, characterData: true });
    emitComposer({ type: 'attached', composer: element });
  }

  function detach(): void {
    const element = active;
    if (!element) return;
    active = null;
    composing = false;
    captureForced = false;
    clearCaptureTimer();
    contentObserver?.disconnect();
    contentObserver = null;
    element.removeEventListener('input', onInput);
    element.removeEventListener('compositionstart', onCompositionStart);
    element.removeEventListener('compositionupdate', onCompositionUpdate);
    element.removeEventListener('compositionend', onCompositionEnd);
    element.removeEventListener('paste', onPaste);
    emitComposer({ type: 'detached', composer: element });
  }

  function scan(): void {
    if (!running) return;
    // The composer may have died (route change, React re-render, editing locked): tear down
    // BEFORE looking for a replacement, so a dead composer never keeps the watch.
    if (active && !isWatchable(active)) detach();
    const next = pickActiveComposer(doc);
    if (next === active) return; // idempotent: same composer, nothing to do
    if (active) detach(); // switching surfaces: cancel pending work on the old one
    if (next) attach(next);
  }

  function scheduleScan(): void {
    if (!running || scanTimer !== undefined) return;
    scanTimer = setTimeout(() => {
      scanTimer = undefined;
      scan();
    }, 0);
  }

  // IME-safe input lane: composition events gate the input lane; nothing schedules while
  // composing, and compositionend schedules exactly one debounced capture. Every user-edit lane
  // marks its capture FORCED: it must emit even when the snapshot reads identical to the last one.
  const onInput = (): void => {
    if (composing) return;
    captureForced = true;
    scheduleCapture();
  };
  const onCompositionStart = (): void => {
    composing = true;
    captureForced = false;
    clearCaptureTimer(); // a capture scheduled before the composition began must not run
  };
  const onCompositionUpdate = (): void => {
    composing = true;
  };
  const onCompositionEnd = (): void => {
    composing = false;
    captureForced = true;
    scheduleCapture();
  };
  const onPaste = (): void => {
    if (composing) return;
    captureForced = true;
    scheduleCapture();
  };

  const mutationObserver = new MutationObserver(() => scheduleScan());
  const onRouteSignal = (): void => scheduleScan();

  return {
    start() {
      if (running) return;
      running = true;
      mutationObserver.observe(doc.body ?? doc, { childList: true, subtree: true });
      win.addEventListener('popstate', onRouteSignal);
      win.addEventListener('hashchange', onRouteSignal);
      scheduleScan();
    },
    stop() {
      if (!running) return;
      running = false;
      mutationObserver.disconnect();
      win.removeEventListener('popstate', onRouteSignal);
      win.removeEventListener('hashchange', onRouteSignal);
      if (scanTimer !== undefined) {
        clearTimeout(scanTimer);
        scanTimer = undefined;
      }
      detach();
    },
    requestAnalysis(): boolean {
      if (!active) return false;
      const snapshot = extractDraftSnapshot(active);
      lastSnapshot = snapshot;
      const eligible = isDraftEligible(snapshot, options.getMinDraftLength());
      emitDraft({ kind: 'captured', snapshot, eligible });
      if (!eligible) return false;
      options.dispatchAnalysis({ snapshot, trigger: 'manual' });
      return true;
    },
    getActiveComposer: () => active,
    getSnapshot: () => lastSnapshot,
    onDraft(listener) {
      draftListeners.add(listener);
      return () => draftListeners.delete(listener);
    },
    onComposerChange(listener) {
      composerListeners.add(listener);
      return () => composerListeners.delete(listener);
    },
  };
}

/** Diagnostic label for a watched composer: its testid, 'structural', or '(none)'. */
export function describeComposer(element: Element | null): string {
  if (!element) return '(none)';
  return element.getAttribute('data-testid') ?? 'structural';
}

// findAllCandidates re-export keeps consumers to the registry for candidate listing.
export { findAllCandidates };
