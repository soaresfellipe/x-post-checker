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
import { extractDraftSnapshot, findComposer, getComposerText } from './extract';
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
  // Immediate user-edit lane (VAL-DRAFT-036). Listeners run synchronously on the real edit event,
  // BEFORE the debounce, so a consumer that must react instantly (the overlay collapsing its
  // expanded panel) is never held back by the ~700ms capture delay.
  const userEditListeners = new Set<() => void>();
  // The composer text as of the last user-edit notification. An edit the user's own events did
  // not report (the real Draft.js select-all + Backspace clear, which fires no input/paste event
  // at all) is detected by the content-mutation lane and reported on the next microtask, unless
  // the text has not actually changed since the last notification. See `notifyUserEdit`.
  let lastNotifiedText: string | null = null;
  // Open between a user-edit notification and the end of the task that produced it: any further
  // lane reporting inside that window is the same edit. See `notifyUserEdit`.
  let editWindowTimer: ReturnType<typeof setTimeout> | undefined;

  const isWatchable = (element: Element): boolean =>
    element.isConnected && element.matches('[role="textbox"][contenteditable="true"]');

  function emitDraft(event: DraftEvent): void {
    for (const listener of draftListeners) listener(event);
  }

  function emitComposer(event: ComposerChangeEvent): void {
    for (const listener of composerListeners) listener(event);
  }

  /** Fans out to every registered user-edit listener, recording the text it was notified for. */
  function emitUserEdit(): void {
    lastNotifiedText = active === null ? null : getComposerText(active);
    openEditWindow();
    for (const listener of userEditListeners) listener();
  }

  /**
   * One real edit is reported by up to three DOM lanes at once: the user's own
   * input/paste/compositionend event AND the content-mutation observer that sees the very same
   * edit's DOM write (a real keystroke writes the composer and then fires `input`; a real paste
   * fires `paste`, then `input`, then writes). Only ONE notification may come out of that.
   *
   * The lanes are separated by TASK, not by order: every one of those events and the editor's
   * write belong to the same task, and the mutation observer's callback runs at that task's end
   * (a microtask checkpoint, before any timer). So the first lane to report opens a window that
   * closes at the end of the task, and every lane after it in that same task is a duplicate of
   * the edit already reported. Being order-independent matters: it keeps the guarantee in real
   * Chrome, where the event lands first, as much as in the engines that deliver the mutation
   * record first.
   *
   * An edit no user event reported at all - real x.com's select-all + Backspace clear, which
   * fires neither input nor paste (verified live, library/x-dom.md) - is caught by the ambient
   * pass, and a text-preserving re-render (the editor's own decorator polish) is never an edit:
   * it carries the text of the last notification and is dropped. The notification reads the
   * composer itself, so "notified" and "captured text" can never disagree.
   */
  function notifyUserEdit(ambient: boolean): void {
    if (editWindowTimer !== undefined) return; // this task's edit is already reported
    if (ambient) {
      if (userEditListeners.size === 0) return; // nobody to notify: never even read the DOM
      const text = active === null ? null : getComposerText(active);
      if (text === lastNotifiedText) return; // a re-render, not an edit
      // Deferred to the microtask checkpoint that delivered these mutations, so the write is
      // complete before the composer is read. This DEFERRED pass is the reporter (the task window
      // is still open for the lanes that fired first), so it emits rather than re-arming.
      queueMicrotask(() => {
        if (editWindowTimer !== undefined) return; // a user-edit event reported it meanwhile
        const current = active === null ? null : getComposerText(active);
        if (current === lastNotifiedText) return; // re-rendered to the same text meanwhile
        emitUserEdit();
      });
      return;
    }
    emitUserEdit();
  }

  /** Closes the duplicate-suppression window once the reporting task is over. */
  function openEditWindow(): void {
    if (editWindowTimer !== undefined) clearTimeout(editWindowTimer);
    editWindowTimer = setTimeout(() => {
      editWindowTimer = undefined;
    }, 0);
  }

  function closeEditWindow(): void {
    if (editWindowTimer === undefined) return;
    clearTimeout(editWindowTimer);
    editWindowTimer = undefined;
    lastNotifiedText = null;
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
    lastNotifiedText = null;
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
      notifyUserEdit(true);
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
    closeEditWindow();
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
  // Each lane also emits the immediate user-edit notification first, so consumers that must react
  // synchronously (the overlay's panel collapse) never wait for the debounce.
  const onInput = (): void => {
    if (composing) return;
    notifyUserEdit(false);
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
    notifyUserEdit(false);
    captureForced = true;
    scheduleCapture();
  };
  const onPaste = (): void => {
    if (composing) return;
    notifyUserEdit(false);
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
    onUserEdit(listener) {
      userEditListeners.add(listener);
      return () => userEditListeners.delete(listener);
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
