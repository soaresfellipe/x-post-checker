/**
 * ScoreOverlay controller — the draft-analysis panel near the active composer.
 *
 * Ownership rules (architecture.md): the panel lives in its OWN Shadow-DOM host appended to
 * `document.body`, never inside the React-managed x.com tree; it is positioned below the
 * composer's region so it cannot cover the composer, the media control or the Post button; and it
 * captures no input — the page keeps every native behavior (VAL-DRAFT-022).
 *
 * State machine (see `view-model.ts`): empty/awaiting below the minimum length, ready with the
 * explicit "Analyze" affordance when autoAnalyze is off, and analyzed with the local
 * "Algorithm signals" half rendered immediately at capture time (never waiting for Jev —
 * VAL-DRAFT-006) plus the "AI judgment" half that arrives asynchronously and is clearly
 * distinguished (VAL-DRAFT-008). Replies match drafts by hash, so the newest draft always wins
 * (VAL-DRAFT-011), and every Jev half-state (pending, verdict, no key, off, failure) renders an
 * explicit English notice while the local score stays usable.
 */
import type { DraftSnapshot } from '@/core/draft-snapshot';
import { JEV_BAND_LABELS, type JevVerdict } from '@/core/heuristic-engine';
import { DEFAULT_SETTINGS, type Settings } from '@/core/settings-store';
import type { DraftAnalysis, DraftAnalysisResult } from '@/core/analyzer';
import type { SignalEntry } from '@/core/heuristic-engine';
import { findComposerRegion } from '@/dom/composer-watcher';
import { OVERLAY_COPY, OVERLAY_HEADLINE_TIERS, OVERLAY_HOST_ID, OVERLAY_PLACEMENT, OVERLAY_TESTIDS } from './config';
import { computeAnchorPosition } from './position';
import { deriveOverlayView, draftIdentity } from './view-model';
import type { OverlayView, ScoreOverlay, ScoreOverlayOptions } from './types';

const STYLE = `
  /*
   * Zero interference by construction (VAL-DRAFT-022): the host and panel never capture pointer
   * input — clicks pass through to the page underneath — so no placement can ever block the
   * composer, media control, Post button or any page content. The panel is a read-only surface;
   * its buttons (Analyze, Connect Jev) are the only interactive elements and re-enable hits.
   */
  :host { all: initial; position: absolute; z-index: 2147483000; pointer-events: none; }
  .panel { pointer-events: none; }
  .panel {
    box-sizing: border-box;
    width: min(340px, calc(100vw - 16px));
    max-height: none;
    overflow-y: auto;
    padding: 12px;
    border: 1px solid #cfd9de; border-radius: 12px;
    background: #ffffff; color: #0f1419;
    font: 400 13px/1.45 system-ui, -apple-system, sans-serif;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  }
  .panel header { display: flex; align-items: baseline; gap: 6px; margin-bottom: 8px; }
  .panel .title { font-weight: 700; font-size: 14px; }
  .panel .subtitle { color: #536471; font-size: 12px; }
  .empty { color: #536471; }
  .ready { color: #0f1419; }
  .gauge { display: flex; align-items: baseline; gap: 8px; margin: 4px 0 2px; }
  .gauge .number { font-size: 30px; font-weight: 700; line-height: 1; }
  .gauge .number[data-tier="good"] { color: #00a680; }
  .gauge .number[data-tier="ok"] { color: #b58105; }
  .gauge .number[data-tier="weak"] { color: #d64545; }
  .gauge .gauge-label { color: #536471; font-size: 12px; }
  .gauge-note { color: #536471; font-size: 11px; margin: 0 0 8px; }
  section { border-top: 1px solid #eff3f4; margin-top: 8px; padding-top: 2px; }
  section h3 {
    margin: 8px 0 4px; font-size: 11px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.06em; color: #536471;
  }
  section[data-testid="overlay-signals"] h3 { color: #0f1419; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; gap: 6px; padding: 2px 0; }
  li .label { flex: 0 0 44%; }
  li .value { flex: 1; color: #536471; }
  li .points { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
  li .points[data-direction="positive"] { color: #00a680; }
  li .points[data-direction="negative"] { color: #d64545; }
  .jev-state { margin: 0 0 4px; }
  .jev-state .band { font-weight: 700; }
  .subheading { margin: 6px 0 2px; font-size: 12px; font-weight: 600; color: #536471; }
  .notice { color: #536471; margin: 4px 0; }
  .pending { color: #536471; font-style: italic; }
  .error-reason { color: #d64545; margin: 2px 0; }
  button {
    pointer-events: auto;
    margin-top: 6px; padding: 4px 12px;
    border: 0; border-radius: 999px; cursor: pointer;
    background: #1d9bf0; color: #ffffff; font: 600 12px/1.4 system-ui, sans-serif;
  }
`;

function headlineTier(headline: number): 'good' | 'ok' | 'weak' {
  if (headline >= OVERLAY_HEADLINE_TIERS.good) return 'good';
  if (headline >= OVERLAY_HEADLINE_TIERS.ok) return 'ok';
  return 'weak';
}

function formatPoints(points: number): string {
  if (points > 0) return `+${points}`;
  if (points < 0) return String(points);
  return '0';
}

export function createScoreOverlay(options: ScoreOverlayOptions): ScoreOverlay {
  const doc = options.doc ?? document;
  const win = doc.defaultView ?? window;

  let settings: Settings = { ...DEFAULT_SETTINGS };
  let composer: Element | null = null;
  let capture: DraftSnapshot | null = null;
  const pending = new Map<string, number>();
  let reply: { hash: string; result: DraftAnalysis } | null = null;
  // Per-draft terminal-state ownership (VAL-DRAFT-018): each draft hash owns its own transport
  // failure, so a settling dispatch can never displace another draft's terminal state (a single
  // slot let an older failing draft erase the current draft's error and downgrade it to ready).
  const transportFailures = new Set<string>();

  let mounted = false;
  let destroyed = false;
  let repositionScheduled = false;
  let mutationObserver: MutationObserver | null = null;

  // ---- host management (idempotent: exactly one host, keyed by OVERLAY_HOST_ID) ----

  function shouldMount(): boolean {
    return !destroyed && settings.enabled && composer !== null;
  }

  function mountHost(): void {
    if (mounted || !shouldMount()) return;
    let host = doc.getElementById(OVERLAY_HOST_ID);
    if (!host?.shadowRoot) {
      host?.remove();
      host = doc.createElement('div');
      host.id = OVERLAY_HOST_ID;
      host.attachShadow({ mode: 'open' });
      const style = doc.createElement('style');
      style.textContent = STYLE;
      const panelRoot = doc.createElement('div');
      panelRoot.className = 'panel-root';
      host.shadowRoot!.append(style, panelRoot);
    }
    doc.body.append(host);
    mounted = true;
    // Page layout can move the composer after mount (feed hydration, route polish): re-anchor.
    mutationObserver ??= new MutationObserver(() => scheduleReposition());
    mutationObserver.observe(doc.body ?? doc, { childList: true, subtree: true });
  }

  function unmountHost(): void {
    doc.getElementById(OVERLAY_HOST_ID)?.remove();
    mounted = false;
    mutationObserver?.disconnect();
    mutationObserver = null;
  }

  function hostElement(): HTMLElement | null {
    return mounted ? doc.getElementById(OVERLAY_HOST_ID) : null;
  }

  // ---- rendering (createElement only; web-ext lint forbids innerHTML in extension code) ----

  function el(tag: string, init: { testid?: string; className?: string; text?: string } = {}): HTMLElement {
    const element = doc.createElement(tag);
    if (init.testid !== undefined) element.dataset.testid = init.testid;
    if (init.className !== undefined) element.className = init.className;
    if (init.text !== undefined) element.textContent = init.text;
    return element;
  }

  function signalRow(signal: SignalEntry): HTMLElement {
    const row = el('li');
    row.dataset.signalId = signal.id;
    const label = el('span', { className: 'label', text: signal.label });
    const value = el('span', { className: 'value', text: signal.value });
    const points = el('span', { className: 'points', text: formatPoints(signal.points) });
    points.dataset.direction = signal.direction;
    row.append(label, value, points);
    return row;
  }

  function bandLabel(verdict: JevVerdict): string {
    return JEV_BAND_LABELS[verdict.band] ?? JEV_BAND_LABELS.weak!;
  }

  function verdictBlock(verdict: JevVerdict): HTMLElement {
    const box = el('div');
    box.append(el('span', { className: 'band', testid: OVERLAY_TESTIDS.jevBand, text: bandLabel(verdict) }));
    box.append(
      el('p', {
        className: 'jev-state',
        testid: OVERLAY_TESTIDS.jevConfidence,
        text: `${OVERLAY_COPY.confidenceLabel}: ${Math.round(verdict.confidence * 100)}%`,
      }),
    );
    if (verdict.weaknesses.length > 0) {
      const list = el('ul', { testid: OVERLAY_TESTIDS.jevWeaknesses });
      for (const weakness of verdict.weaknesses) list.append(el('li', { text: weakness }));
      box.append(el('h4', { className: 'subheading', text: `${OVERLAY_COPY.weaknessHeading}:` }), list);
    }
    if (verdict.suggestions.length > 0) {
      const list = el('ul', { testid: OVERLAY_TESTIDS.jevSuggestions });
      for (const suggestion of verdict.suggestions) list.append(el('li', { text: suggestion }));
      box.append(el('h4', { className: 'subheading', text: `${OVERLAY_COPY.suggestionsHeading}:` }), list);
    }
    return box;
  }

  function renderViewInto(panel: HTMLElement, view: OverlayView): void {
    panel.dataset.state = view.phase;
    const header = el('header');
    header.append(
      el('span', { className: 'title', text: OVERLAY_COPY.panelTitle }),
      el('span', { className: 'subtitle', text: OVERLAY_COPY.panelSubtitle }),
    );
    panel.append(header);

    if (view.phase === 'empty') {
      const box = el('div', { className: 'empty', testid: OVERLAY_TESTIDS.empty });
      box.append(el('p', { text: OVERLAY_COPY.empty }));
      box.append(el('p', { text: OVERLAY_COPY.emptyMinHint.replace('{n}', String(view.minDraftLength)) }));
      panel.append(box);
      return;
    }

    if (view.phase === 'ready') {
      const box = el('div', { className: 'ready', testid: OVERLAY_TESTIDS.ready });
      box.append(el('p', { text: OVERLAY_COPY.ready }));
      const analyze = el('button', { testid: OVERLAY_TESTIDS.analyze, text: OVERLAY_COPY.analyzeButton });
      analyze.addEventListener('click', () => options.requestAnalysis());
      box.append(analyze);
      panel.append(box);
      return;
    }

    // analyzed: the gauge (hybrid when a verdict is in), then the two clearly separated halves.
    const gauge = el('div', { className: 'gauge', testid: OVERLAY_TESTIDS.gauge });
    gauge.dataset.headlineSource = view.headlineSource;
    const number = el('span', {
      className: 'number',
      testid: OVERLAY_TESTIDS.headline,
      text: String(view.headline),
    });
    number.dataset.tier = headlineTier(view.headline);
    gauge.append(number, el('span', { className: 'gauge-label', text: OVERLAY_COPY.gaugeLabel }));
    panel.append(gauge);
    panel.append(
      el('p', {
        className: 'gauge-note',
        text: view.headlineSource === 'hybrid' ? OVERLAY_COPY.hybridNote : OVERLAY_COPY.localNote,
      }),
    );

    const signals = el('section', { testid: OVERLAY_TESTIDS.signals });
    signals.append(el('h3', { text: OVERLAY_COPY.signalsHeading }));
    const signalList = el('ul');
    for (const signal of view.local.signals) signalList.append(signalRow(signal));
    signals.append(signalList);
    panel.append(signals);

    const jev = el('section', { testid: OVERLAY_TESTIDS.jev });
    jev.dataset.jevState = view.jev.state;
    jev.append(el('h3', { text: OVERLAY_COPY.jevHeading }));
    switch (view.jev.state) {
      case 'pending':
        jev.append(el('p', { className: 'pending', testid: OVERLAY_TESTIDS.jevPending, text: OVERLAY_COPY.pending }));
        break;
      case 'verdict':
        if (view.jev.verdict) jev.append(verdictBlock(view.jev.verdict));
        break;
      case 'no-key': {
        jev.append(el('p', { className: 'notice', testid: OVERLAY_TESTIDS.jevNotice, text: OVERLAY_COPY.noKey }));
        const connect = el('button', { testid: OVERLAY_TESTIDS.connectJev, text: OVERLAY_COPY.connectJev });
        connect.addEventListener('click', () => options.openOptions());
        jev.append(connect);
        break;
      }
      case 'off':
        jev.append(el('p', { className: 'notice', testid: OVERLAY_TESTIDS.jevNotice, text: OVERLAY_COPY.off }));
        break;
      case 'error':
        jev.append(el('p', { className: 'notice', testid: OVERLAY_TESTIDS.jevNotice, text: OVERLAY_COPY.error }));
        jev.append(el('p', { className: 'error-reason', text: view.jev.reason ?? OVERLAY_COPY.errorReasons.network }));
        break;
    }
    panel.append(jev);
  }

  function render(): void {
    if (!shouldMount()) return;
    mountHost();
    const host = hostElement();
    if (!host) return;
    const panelRoot = host.shadowRoot!.querySelector<HTMLElement>('.panel-root')!;
    const view = deriveOverlayView({
      settings,
      keyPresent: options.getKeyPresence(),
      capture,
      pending,
      reply,
      transportFailures,
    });
    const panel = el('div', { className: 'panel', testid: OVERLAY_TESTIDS.panel });
    renderViewInto(panel, view);
    panelRoot.replaceChildren(panel);
    reposition();
  }

  // ---- placement ----

  function panelElement(): HTMLElement | null {
    return hostElement()?.shadowRoot?.querySelector<HTMLElement>('.panel') ?? null;
  }

  function reposition(): void {
    const host = hostElement();
    if (!host || !composer) return;
    const region = findComposerRegion(composer);
    const regionBox =
      region instanceof Element
        ? region.getBoundingClientRect()
        : { top: 0, bottom: 0, left: 0, width: 0, height: 0 };
    const panel = panelElement();
    // Measure the panel's NATURAL height: measuring a stale cap would shrink the decision input
    // and let the cap oscillate off on the next reposition (VAL-DRAFT-023).
    panel?.style.removeProperty('max-height');
    const hostBox = host.getBoundingClientRect();
    const position = computeAnchorPosition({
      regionRect: { top: regionBox.top, bottom: regionBox.bottom, left: regionBox.left },
      overlaySize: {
        width: hostBox.width || OVERLAY_PLACEMENT.fallbackWidth,
        height: hostBox.height || OVERLAY_PLACEMENT.fallbackHeight,
      },
      viewport: { width: win.innerWidth, height: win.innerHeight },
      scroll: { x: win.scrollX, y: win.scrollY },
    });
    host.style.position = 'absolute';
    host.style.top = `${position.top}px`;
    host.style.left = `${position.left}px`;
    // The height cap (null = natural size): the panel scrolls internally while capped, so the
    // overlay stays inside the viewport at short-window geometry.
    if (position.maxHeight === null) panel?.style.removeProperty('max-height');
    else panel?.style.setProperty('max-height', `${position.maxHeight}px`);
  }

  /** Coalesces mutation/resize-driven repositions into one rAF callback (idempotent placement). */
  function scheduleReposition(): void {
    if (repositionScheduled || !mounted) return;
    repositionScheduled = true;
    const run = (): void => {
      repositionScheduled = false;
      reposition();
    };
    if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(run);
    else run();
  }

  const onResize = (): void => scheduleReposition();
  win.addEventListener('resize', onResize);

  /**
   * Internal scrolling for a capped panel (VAL-DRAFT-023) without breaking the zero-interference
   * rule: the host and panel stay pointer-events:none, so a wheel over the panel targets the PAGE
   * underneath. This listener redirects a wheel over a SCROLLABLE capped panel into the panel
   * itself and leaves every other wheel (and every click) with the page's default behavior.
   */
  const onWheel = (event: WheelEvent): void => {
    const panel = panelElement();
    if (!panel || panel.scrollHeight <= panel.clientHeight) return; // nothing to scroll (common case)
    const box = panel.getBoundingClientRect();
    const withinPanel =
      event.clientX >= box.left && event.clientX <= box.right &&
      event.clientY >= box.top && event.clientY <= box.bottom;
    if (!withinPanel) return;
    // Firefox emits line-mode deltas; scrollTop is px (the line height lives in the config).
    const delta =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * OVERLAY_PLACEMENT.wheelLineHeight
        : event.deltaY;
    const atTop = panel.scrollTop <= 0;
    const atBottom = panel.scrollTop + panel.clientHeight >= panel.scrollHeight;
    if (delta < 0 ? atTop : atBottom) return; // at the edge: the page keeps the scroll
    panel.scrollTop += delta;
    event.preventDefault();
  };
  doc.addEventListener('wheel', onWheel, { passive: false });

  // ---- state updates ----

  function clearAnalysisState(): void {
    capture = null;
    pending.clear();
    reply = null;
    transportFailures.clear();
  }

  function pendingCount(hash: string): number {
    return pending.get(hash) ?? 0;
  }

  function oldestPendingHash(): string | null {
    for (const [hash, count] of pending) if (count > 0) return hash;
    return null;
  }

  function settlePending(hash: string): void {
    const count = pending.get(hash) ?? 0;
    if (count <= 1) pending.delete(hash);
    else pending.set(hash, count - 1);
  }

  function settleOldestPending(): void {
    const oldest = oldestPendingHash();
    if (oldest !== null) settlePending(oldest);
  }

  return {
    onSettings(next, revision) {
      settings = next;
      if (revision !== undefined) {
        const host = hostElement();
        if (host) host.dataset.settingsRevision = String(revision);
      }
      if (!next.enabled) {
        clearAnalysisState();
        unmountHost();
        return;
      }
      render();
    },
    onDraftCaptured(event) {
      const hash = draftIdentity(event.snapshot);
      if (reply !== null && reply.hash !== hash) reply = null;
      // Failures are owned per draft: only the captured draft's own failure survives the capture
      // (a different draft's stale entry is pruned to keep the set bounded).
      for (const failedHash of transportFailures) {
        if (failedHash !== hash) transportFailures.delete(failedHash);
      }
      capture = event.snapshot;
      render();
    },
    onComposerChange(event) {
      if (event.type === 'detached') {
        if (composer !== event.composer) return; // a stale detach for a composer we moved off of
        composer = null;
        clearAnalysisState();
        unmountHost();
        return;
      }
      composer = event.composer;
      clearAnalysisState();
      render();
    },
    onAnalysisDispatched(snapshot) {
      const hash = draftIdentity(snapshot);
      pending.set(hash, (pending.get(hash) ?? 0) + 1);
      render();
    },
    onAnalysisResult(result: DraftAnalysisResult, dispatched?: DraftSnapshot) {
      if (result.kind !== 'analyzed') {
        // Honest refusals settle the dispatch they BELONG to when the caller carries its identity
        // (VAL-DRAFT-018: never the oldest one — an unrelated in-flight dispatch must stay
        // pending); the identity-less fallback keeps the pre-identity contract working.
        if (dispatched) {
          const dispatchedHash = draftIdentity(dispatched);
          if (pendingCount(dispatchedHash) > 0) settlePending(dispatchedHash);
        } else {
          settleOldestPending();
        }
        if (result.kind === 'below-min-length') render();
        return;
      }
      const hash = result.meta.draftHash;
      settlePending(hash);
      transportFailures.delete(hash); // the draft's own success retires its failure
      // Stale-response discard (VAL-DRAFT-011): only the newest draft's result may render.
      if (capture !== null && draftIdentity(capture) === hash) {
        reply = { hash, result };
        render();
      }
    },
    onAnalysisFailed(snapshot: DraftSnapshot) {
      // The transport failure carries the failing draft's identity — the same identity successes
      // use — so ONLY that dispatch settles (VAL-DRAFT-018): an older in-flight analysis stays
      // pending, and the failing draft's local score shows with an explicit transport error
      // instead of spinning forever. The failure is recorded under ITS OWN hash, so a later
      // failure for another draft can never displace this draft's terminal state.
      const hash = draftIdentity(snapshot);
      if (pendingCount(hash) <= 0) return; // unknown or already-settled dispatch: nothing to settle
      settlePending(hash);
      transportFailures.add(hash);
      render();
    },
    destroy() {
      destroyed = true;
      win.removeEventListener('resize', onResize);
      doc.removeEventListener('wheel', onWheel);
      unmountHost();
      clearAnalysisState();
    },
  };
}
