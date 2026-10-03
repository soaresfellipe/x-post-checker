/**
 * The target popover: ONE Shadow-DOM host on document.body showing a post's local target score,
 * its signal breakdown, and the on-demand "Deep analysis" AI judgment. Like the score overlay it
 * captures no pointer input — the host and panel are pointer-events: none, and only the panel's
 * own buttons (close, Deep analysis, Try again, Connect Jev) re-enable hits — and it never mounts
 * inside the React-managed x.com tree.
 *
 * Click isolation (VAL-TARGET-016) is the badge button's job (stopPropagation + preventDefault);
 * this module additionally closes on its own close control and on Escape (VAL-TARGET-015).
 */
import type { PostSnapshot } from '@/core/post-snapshot';
import type { SignalEntry } from '@/core/heuristic-engine';
import {
  BADGE_COPY,
  POPOVER_HOST_ID,
  POPOVER_PLACEMENT,
  POPOVER_STYLE,
  POPOVER_TESTIDS,
} from './config';
import type { TargetAiSection } from './view-model';

export interface TargetPopoverView {
  readonly post: PostSnapshot;
  readonly score: { readonly headline: number; readonly signals: readonly SignalEntry[] };
  readonly ai: TargetAiSection;
}

export interface TargetPopoverCallbacks {
  /** The "Deep analysis" / "Try again" action for this popover's post. */
  onDeepAnalysis: (post: PostSnapshot) => void;
  /** The "Connect Jev" action (routes through the background to the Options page). */
  onConnectOptions: () => void;
}

export interface TargetPopover {
  /** Opens (or switches) the popover for a post, anchored to its article. */
  open(view: TargetPopoverView, article: Element): void;
  /** Re-renders the open popover (settings changed, analysis settled). No-op when closed. */
  refresh(view: TargetPopoverView): void;
  close(): void;
  readonly isOpen: boolean;
  destroy(): void;
}

export function createTargetPopover(callbacks: TargetPopoverCallbacks, doc: Document = document): TargetPopover {
  const win = doc.defaultView ?? window;
  let host: HTMLElement | null = null;
  let view: TargetPopoverView | null = null;
  let anchor: Element | null = null;
  let repositionScheduled = false;

  function ensureHost(): HTMLElement {
    if (host?.shadowRoot) return host;
    host?.remove();
    host = doc.createElement('div');
    host.id = POPOVER_HOST_ID;
    host.style.pointerEvents = 'none';
    host.attachShadow({ mode: 'open' });
    doc.body.append(host);
    return host;
  }

  function el(tag: string, init: { testid?: string; className?: string; text?: string } = {}): HTMLElement {
    const element = doc.createElement(tag);
    if (init.testid !== undefined) element.dataset.testid = init.testid;
    if (init.className !== undefined) element.className = init.className;
    if (init.text !== undefined) element.textContent = init.text;
    return element;
  }

  function formatPoints(points: number): string {
    if (points > 0) return `+${points}`;
    return String(points);
  }

  function signalRow(signal: SignalEntry): HTMLElement {
    const row = el('li');
    row.dataset.signalId = signal.id;
    row.append(
      el('span', { className: 'label', text: signal.label }),
      el('span', { className: 'value', text: signal.value }),
      el('span', { className: 'points', text: formatPoints(signal.points) }),
    );
    row.querySelector('.points')!.setAttribute('data-direction', signal.direction);
    return row;
  }

  function aiSectionContent(section: TargetAiSection, root: HTMLElement): void {
    const state = section.state;
    root.dataset.aiState = state;
    root.append(el('h3', { text: BADGE_COPY.aiHeading }));

    if (state === 'off') {
      root.append(el('p', { className: 'notice', testid: POPOVER_TESTIDS.aiNotice, text: BADGE_COPY.off }));
      return;
    }
    if (state === 'no-key') {
      root.append(el('p', { className: 'notice', testid: POPOVER_TESTIDS.aiNotice, text: BADGE_COPY.noKey }));
      const connect = el('button', { className: 'action', testid: POPOVER_TESTIDS.connectJev, text: BADGE_COPY.connectJev });
      connect.addEventListener('click', () => callbacks.onConnectOptions());
      root.append(connect);
      return;
    }
    if (state === 'idle') {
      root.append(el('p', { className: 'notice', testid: POPOVER_TESTIDS.aiNotice, text: BADGE_COPY.aiIdle }));
      const deep = el('button', { className: 'action', testid: POPOVER_TESTIDS.deepAnalysis, text: BADGE_COPY.deepAnalysis });
      deep.addEventListener('click', () => view && callbacks.onDeepAnalysis(view.post));
      root.append(deep);
      return;
    }
    if (state === 'pending') {
      root.append(el('p', { className: 'pending', testid: POPOVER_TESTIDS.aiNotice, text: BADGE_COPY.pending }));
      return;
    }
    if (state === 'error') {
      root.append(el('p', { className: 'notice', testid: POPOVER_TESTIDS.aiNotice, text: BADGE_COPY.error }));
      root.append(el('p', { className: 'error-reason', testid: POPOVER_TESTIDS.aiErrorReason, text: section.reason ?? BADGE_COPY.errorReasons.network }));
      const retry = el('button', { className: 'action', testid: POPOVER_TESTIDS.retry, text: BADGE_COPY.retry });
      retry.addEventListener('click', () => view && callbacks.onDeepAnalysis(view.post));
      root.append(retry);
      return;
    }
    // verdict
    const verdict = section.verdict!;
    const band = el('p');
    band.append(el('span', { className: 'band', testid: POPOVER_TESTIDS.verdictBand, text: verdictBandLabel(verdict) }));
    root.append(band);
    root.append(
      el('p', {
        className: 'notice',
        testid: POPOVER_TESTIDS.verdictConfidence,
        // The ordinal is NEVER shown as a probability/percentage — only the band + confidence are.
        text: `${BADGE_COPY.confidenceLabel}: ${Math.round(verdict.confidence * 100)}%`,
      }),
    );
    if (section.angle) {
      root.append(
        el('p', {
          className: 'notice',
          testid: POPOVER_TESTIDS.verdictAngle,
          text: `${BADGE_COPY.angleLabel}: ${section.angle.label}`,
        }),
      );
    }
    root.append(el('p', { className: 'verdict-note', text: BADGE_COPY.verdictNote }));
  }

  const BAND_LABELS: Readonly<Record<string, string>> = {
    weak: 'Weak',
    'below-average': 'Below avg',
    moderate: 'Moderate',
    strong: 'Strong',
    exceptional: 'Exceptional',
  };
  function verdictBandLabel(verdict: { band: string }): string {
    return BAND_LABELS[verdict.band] ?? 'Weak';
  }

  function renderPanel(): HTMLElement {
    const current = view!;
    const panel = el('div', { className: 'panel', testid: POPOVER_TESTIDS.panel });
    panel.setAttribute('data-amplifyx-post-id', current.post.id);
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', `${BADGE_COPY.popoverTitle} for @${current.post.authorHandle}`);

    const header = el('header');
    header.append(el('span', { className: 'title', text: BADGE_COPY.popoverTitle }));
    header.append(el('span', { className: 'subtitle', text: `@${current.post.authorHandle} · post ${current.post.id}` }));
    const close = el('button', { testid: POPOVER_TESTIDS.close, text: '×' });
    close.setAttribute('aria-label', BADGE_COPY.close);
    close.addEventListener('click', () => close_());
    header.append(close);
    panel.append(header);

    const scoreRow = el('div', { className: 'score-row' });
    scoreRow.append(el('span', { className: 'number', testid: POPOVER_TESTIDS.localScore, text: String(current.score.headline) }));
    scoreRow.append(el('span', { className: 'label', text: BADGE_COPY.localScoreLabel }));
    panel.append(scoreRow);

    const signals = el('section', { testid: POPOVER_TESTIDS.signals });
    signals.append(el('h3', { text: BADGE_COPY.signalsHeading }));
    const list = el('ul');
    for (const signal of current.score.signals) list.append(signalRow(signal));
    signals.append(list);
    panel.append(signals);

    const ai = el('section', { testid: POPOVER_TESTIDS.aiSection });
    aiSectionContent(current.ai, ai);
    panel.append(ai);
    return panel;
  }

  // ---- placement (document-absolute: viewport rect + scroll offset, like the overlay) ----

  function reposition(): void {
    if (!host || !anchor || !view) return;
    const shadow = host.shadowRoot!;
    const panel = shadow.querySelector<HTMLElement>(`[data-testid="${POPOVER_TESTIDS.panel}"]`);
    if (!panel) return;
    const rect = anchor.getBoundingClientRect();
    const scrollX = win.scrollX ?? 0;
    const scrollY = win.scrollY ?? 0;
    const viewportWidth = win.innerWidth ?? 0;
    const viewportHeight = win.innerHeight ?? 0;
    const margin = POPOVER_PLACEMENT.viewportMargin;
    const gap = POPOVER_PLACEMENT.gap;

    const panelHeight = panel.offsetHeight;
    const spaceBelow = rect.bottom + scrollY + gap;
    const fitsBelow = spaceBelow + Math.min(panelHeight, viewportHeight) <= scrollY + viewportHeight + margin;
    let top: number;
    if (fitsBelow) {
      top = spaceBelow;
    } else {
      const above = rect.top + scrollY - gap - panelHeight;
      top = Math.max(scrollY + margin, above);
    }
    const width = panel.offsetWidth;
    const left = Math.min(Math.max(margin, rect.left + scrollX), Math.max(margin, scrollX + viewportWidth - margin - width));
    host.style.top = `${Math.round(top)}px`;
    host.style.left = `${Math.round(left)}px`;
    const maxViewportHeight = viewportHeight - margin * 2;
    panel.style.maxHeight = `${Math.round(Math.max(120, maxViewportHeight))}px`;
  }

  function scheduleReposition(): void {
    if (repositionScheduled || !view) return;
    repositionScheduled = true;
    win.requestAnimationFrame(() => {
      repositionScheduled = false;
      reposition();
    });
  }

  const onRepositionSignal = (): void => scheduleReposition();
  const onKeyDown = (event: Event): void => {
    if ((event as KeyboardEvent).key === 'Escape') close_();
  };

  function close_(): void {
    if (!view) return;
    view = null;
    anchor = null;
    host?.remove();
    host = null;
    win.removeEventListener('scroll', onRepositionSignal, { capture: true } as EventListenerOptions);
    win.removeEventListener('resize', onRepositionSignal);
    doc.removeEventListener('keydown', onKeyDown, true);
  }

  return {
    open(nextView, article) {
      view = nextView;
      anchor = article;
      ensureHost();
      const shadow = host!.shadowRoot!;
      const style = doc.createElement('style');
      style.textContent = POPOVER_STYLE;
      shadow.replaceChildren(style, renderPanel());
      win.addEventListener('scroll', onRepositionSignal, { capture: true, passive: true } as AddEventListenerOptions);
      win.addEventListener('resize', onRepositionSignal);
      doc.addEventListener('keydown', onKeyDown, true);
      reposition();
    },
    refresh(nextView) {
      if (!view || !host?.shadowRoot) return;
      const samePost = view.post.id === nextView.post.id;
      view = nextView;
      const style = host.shadowRoot.querySelector('style');
      host.shadowRoot.replaceChildren(style!, renderPanel());
      if (!samePost) reposition();
      else scheduleReposition();
    },
    close: close_,
    get isOpen() {
      return view !== null;
    },
    destroy() {
      close_();
    },
  };
}
