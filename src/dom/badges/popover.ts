/**
 * The target popover (Design 1b §8): ONE Shadow-DOM host on document.body — a 300px, radius-16,
 * borderless card on the shared --shadow, anchored 6px below its badge CHIP and left-aligned to
 * it (viewport-clamped) — showing the post's 22px headline score, its target-signal chips (with
 * the "N neutral ›" rows toggle), and the per-state footer with the on-demand "Deep analysis" AI
 * judgment. Like the score overlay it captures no pointer input — the host and panel are
 * pointer-events: none, and only the panel's own buttons (close, Deep analysis, Retry, Connect
 * Jev) re-enable hits — and it never mounts inside the React-managed x.com tree.
 *
 * Click isolation (VAL-TARGET-016) is the badge button's job (stopPropagation + preventDefault);
 * this module additionally closes on its own close control and on Escape (VAL-TARGET-015).
 */
import type { PostSnapshot } from '@/core/post-snapshot';
import type { SignalEntry } from '@/core/heuristic-engine';
import { JEVD_BAND_TREATMENT } from '@/dom/overlay/config';
import { neutralCount, signalChips } from '@/dom/overlay/chips';
import { ThemeDetector, applyThemeTokens, setHostTheme } from '@/dom/theme';
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
  /**
   * Points the open popover's anchor at the CURRENT chip (a repaint rebuilt it — the old button
   * is detached and its zero rectangle would drag the card toward the viewport origin on the
   * next geometry refresh; M6-SCRUTINY-008). No-op when closed.
   */
  rebindAnchor(anchor: Element): void;
  close(): void;
  readonly isOpen: boolean;
  destroy(): void;
}

export function createTargetPopover(callbacks: TargetPopoverCallbacks, doc: Document = document): TargetPopover {
  const win = doc.defaultView ?? window;
  // M6 theme foundation: the popover's host carries the shared token block + the live data-theme.
  // A live theme switch while the popover is OPEN re-stamps the host in place (no remount, no
  // state loss — VAL-THEME-002's "all extension surfaces" clause).
  const themeDetector = new ThemeDetector({ doc });
  let host: HTMLElement | null = null;
  let view: TargetPopoverView | null = null;
  let anchor: Element | null = null;
  let repositionScheduled = false;
  themeDetector.subscribe((theme) => {
    if (host !== null) setHostTheme(host, theme);
  });

  function ensureHost(): HTMLElement {
    if (host?.shadowRoot) return host;
    host?.remove();
    host = doc.createElement('div');
    host.id = POPOVER_HOST_ID;
    host.style.pointerEvents = 'none';
    host.attachShadow({ mode: 'open' });
    applyThemeTokens(host.shadowRoot!);
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

  /** Design-1b §4.1: explicit sign, U+2212 minus for negatives (never a bare hyphen). */
  function formatPoints(points: number): string {
    if (points > 0) return `+${points}`;
    if (points < 0) return `\u2212${Math.abs(points)}`;
    return '0';
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

  /**
   * The footer per AI state (design-1b §8): idle → "AI judgment, once, cached" + "Deep analysis";
   * pending → pulsing dot + "Analyzing with AI…"; verdict → "AI · {band}" chip + "Suggested
   * angle" + the confidence disclaimer; no-key / off / error → the §6 phrases, "Retry" on error.
   */
  function footerContent(section: TargetAiSection, headline: number, root: HTMLElement): void {
    const state = section.state;
    root.dataset.aiState = state;

    if (state === 'idle') {
      root.append(el('p', { className: 'notice', testid: POPOVER_TESTIDS.aiNotice, text: BADGE_COPY.footerIdle }));
      const deep = el('button', { className: 'link', testid: POPOVER_TESTIDS.deepAnalysis, text: BADGE_COPY.deepAnalysis });
      deep.addEventListener('click', () => view && callbacks.onDeepAnalysis(view.post));
      root.append(deep);
      return;
    }
    if (state === 'pending') {
      const line = el('p', { className: 'pending' });
      line.append(el('span', { className: 'dot' }));
      line.append(el('span', { testid: POPOVER_TESTIDS.aiNotice, text: BADGE_COPY.pending }));
      root.append(line);
      return;
    }
    if (state === 'error') {
      root.append(
        el('p', {
          className: 'notice',
          testid: POPOVER_TESTIDS.aiNotice,
          text: BADGE_COPY.errorLine(headline, section.reason ?? BADGE_COPY.errorReasons.network),
        }),
      );
      const retry = el('button', { className: 'link', testid: POPOVER_TESTIDS.retry, text: BADGE_COPY.retry });
      retry.addEventListener('click', () => view && callbacks.onDeepAnalysis(view.post));
      root.append(retry);
      return;
    }
    if (state === 'no-key') {
      const line = el('p', { className: 'notice', testid: POPOVER_TESTIDS.aiNotice });
      line.append(el('span', { text: BADGE_COPY.noKeyBefore }));
      const connect = el('button', { className: 'link', testid: POPOVER_TESTIDS.connectJev, text: BADGE_COPY.noKeyLink });
      connect.addEventListener('click', () => callbacks.onConnectOptions());
      line.append(connect);
      line.append(el('span', { text: BADGE_COPY.noKeyAfter }));
      root.append(line);
      return;
    }
    if (state === 'off') {
      root.append(el('p', { className: 'notice', testid: POPOVER_TESTIDS.aiNotice, text: BADGE_COPY.off }));
      return;
    }
    // verdict
    const verdict = section.verdict!;
    const band = el('span', {
      className: 'band',
      testid: POPOVER_TESTIDS.verdictBand,
      text: `${BADGE_COPY.verdictChipPrefix}${verdictBandLabel(verdict)}`,
    });
    band.dataset.treatment = JEVD_BAND_TREATMENT[verdict.band] ?? 'weak';
    root.append(band);
    if (section.angle) {
      root.append(el('p', { className: 'angle-line', testid: POPOVER_TESTIDS.verdictAngle, text: BADGE_COPY.angleLine(section.angle.label) }));
    }
    root.append(
      el('p', {
        className: 'confidence-line',
        testid: POPOVER_TESTIDS.verdictConfidence,
        // The ordinal is NEVER shown as a probability/percentage — only the band + confidence are.
        text: BADGE_COPY.verdictConfidence(Math.round(verdict.confidence * 100)),
      }),
    );
  }

  function renderPanel(): HTMLElement {
    const current = view!;
    const panel = el('div', { className: 'panel', testid: POPOVER_TESTIDS.panel });
    panel.setAttribute('data-amplifyx-post-id', current.post.id);
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', `${BADGE_COPY.popoverTitle} for @${current.post.authorHandle}`);

    // Header: 22px/800 headline + "Reply target" + round 28px close; caption line below.
    const header = el('header');
    header.append(el('span', { className: 'headline', testid: POPOVER_TESTIDS.localScore, text: String(current.score.headline) }));
    header.append(el('span', { className: 'title', testid: POPOVER_TESTIDS.title, text: BADGE_COPY.popoverTitle }));
    const close = el('button', { className: 'close', testid: POPOVER_TESTIDS.close, text: '×' });
    close.setAttribute('type', 'button');
    close.setAttribute('aria-label', BADGE_COPY.close);
    close.addEventListener('click', () => close_());
    header.append(close);
    panel.append(header);

    panel.append(
      el('span', {
        className: 'caption',
        testid: POPOVER_TESTIDS.caption,
        text: BADGE_COPY.caption(current.ai.state === 'verdict', current.post.authorHandle),
      }),
    );

    // Target-signal chips (verbatim short phrases, |points| desc, cap 4) + the "N neutral ›"
    // rows toggle — the same Design 1b chip model as the overlay's expanded block.
    const signals = el('section', { testid: POPOVER_TESTIDS.signals });
    const chips = el('div', { className: 'chips' });
    for (const chip of signalChips(current.score.signals)) {
      const chipEl = el('span', { className: 'chip', testid: POPOVER_TESTIDS.chip });
      chipEl.dataset.signalId = chip.id;
      chipEl.dataset.direction = chip.direction;
      chipEl.append(el('span', { className: 'phrase', text: chip.phrase }));
      chipEl.append(el('span', { className: 'points', text: formatPoints(chip.points) }));
      chips.append(chipEl);
    }
    signals.append(chips);
    const rows = el('ul', { className: 'rows', testid: POPOVER_TESTIDS.signalRows });
    for (const signal of current.score.signals) rows.append(signalRow(signal));
    rows.setAttribute('hidden', '');
    signals.append(rows);
    const neutral = neutralCount(current.score.signals);
    if (neutral > 0) {
      const toggle = el('button', { className: 'neutral-toggle', testid: POPOVER_TESTIDS.neutralToggle, text: BADGE_COPY.neutralToggle(neutral) });
      toggle.setAttribute('type', 'button');
      // Local toggle only: revealing/hiding the rows list never re-renders the rest of the panel.
      toggle.addEventListener('click', () => {
        if (rows.hasAttribute('hidden')) rows.removeAttribute('hidden');
        else rows.setAttribute('hidden', '');
      });
      signals.append(toggle);
    }
    panel.append(signals);

    // Footer (hairline-separated): the per-AI-state copy + actions.
    const footer = el('footer', { className: 'footer', testid: POPOVER_TESTIDS.aiSection });
    footerContent(current.ai, current.score.headline, footer);
    panel.append(footer);
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
      const themedHost = ensureHost();
      const shadow = themedHost.shadowRoot!;
      const style = doc.createElement('style');
      style.textContent = POPOVER_STYLE;
      shadow.replaceChildren(applyThemeTokens(shadow), style, renderPanel());
      setHostTheme(themedHost, themeDetector.getTheme());
      win.addEventListener('scroll', onRepositionSignal, { capture: true, passive: true } as AddEventListenerOptions);
      win.addEventListener('resize', onRepositionSignal);
      doc.addEventListener('keydown', onKeyDown, true);
      reposition();
    },
    refresh(nextView) {
      if (!view || !host?.shadowRoot) return;
      const samePost = view.post.id === nextView.post.id;
      view = nextView;
      const style = host.shadowRoot.querySelector('style:not([data-amplifyx-theme-tokens])');
      host.shadowRoot.replaceChildren(applyThemeTokens(host.shadowRoot), style!, renderPanel());
      if (!samePost) reposition();
      else scheduleReposition();
    },
    close: close_,
    rebindAnchor(next) {
      if (!view) return;
      anchor = next;
      scheduleReposition();
    },
    get isOpen() {
      return view !== null;
    },
    destroy() {
      close_();
      themeDetector.destroy();
    },
  };
}
