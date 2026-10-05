/**
 * ScoreOverlay controller — the draft-analysis surface near the active composer.
 *
 * DESIGN 1b (M6, user-approved 2026-10-05): nothing floats over the composer. The collapsed
 * surface is a fixed 36px STATUS ROW inserted IN DOCUMENT FLOW as the immediate preceding sibling
 * of X's `[data-testid="toolBar"]` inside the composer block (probe-verified on real x.com,
 * `library/x-dom.md`: React does not disturb a sibling inserted there, and X's own @mention
 * dropdown draws OVER an in-flow element — no yield mechanism exists or is needed). Clicking the
 * row expands the analysis INLINE, below the row inside the same host, pushing the toolbar down;
 * the expanded block has a MAX HEIGHT with internal wheel/trackpad scroll. Collapse triggers:
 * outside click (which collapses AND reaches the page — there is NO capture lane), Escape, and
 * any new user edit in the composer. Absolute placement survives ONLY as the fallback when the
 * toolbar is not found, with the same row anatomy. No qualifying draft means NO UI at all.
 *
 * Ownership rules (architecture.md): the surface lives in its OWN Shadow-DOM host the extension
 * owns; the host is `pointer-events: none` always, and only the extension's own controls (the
 * row button, the expanded block's buttons/scrollable content) take hits — page clicks, typing,
 * scrolling and posting are never intercepted. Inserting the host before the toolbar is a NEW
 * DOM insertion into X's tree: it is idempotent, the mutation observer re-attaches the host
 * whenever a React re-render detaches it, and X's own nodes are never moved or modified.
 *
 * State machine (see `view-model.ts`): `empty` below the minimum length renders nothing at all;
 * `analyzed` renders the local half immediately at capture time (never waiting for Jev —
 * VAL-DRAFT-006) plus the AI half that arrives asynchronously and is clearly distinguished
 * (VAL-DRAFT-008). Replies match drafts by hash, so the newest draft always wins (VAL-DRAFT-011),
 * and every Jev state renders its verbatim copy from `config.ts` (design-1b §6).
 */
import type { DraftSnapshot } from '@/core/draft-snapshot';
import { JEV_BAND_LABELS, type JevVerdict, type SignalEntry } from '@/core/heuristic-engine';
import { DEFAULT_SETTINGS, type Settings } from '@/core/settings-store';
import type { DraftAnalysis, DraftAnalysisResult } from '@/core/analyzer';
import { VARIANT_LABELS, type HookVariant, type OptimizationResult } from '@/core/optimizer';
import { findComposerAnchorRegion } from '@/dom/composer-watcher';
import { ThemeDetector, applyThemeTokens, setHostTheme } from '@/dom/theme';
import { findFirst } from '@/selectors';
import {
  JEVD_BAND_TREATMENT,
  OPTIMIZER_COPY_RESET_MS,
  OVERLAY_COPY,
  OVERLAY_HEADLINE_TIERS,
  OVERLAY_HOST_ID,
  OVERLAY_PLACEMENT,
  OVERLAY_TESTIDS,
} from './config';
import { computeAnchorPosition } from './position';
import { deriveOverlayView, draftIdentity } from './view-model';
import type { OptimizerSlot, OverlayView, ScoreOverlay, ScoreOverlayOptions } from './types';

/** The `analyzed` view — every render surface exists only for a qualifying draft. */
type AnalyzedView = Extract<OverlayView, { phase: 'analyzed' }>;

const STYLE = `
  /*
   * Pointer discipline (AGENTS.md, no exceptions since M6): the HOST is always
   * pointer-events: none, so it can never intercept a page click; only the extension's OWN
   * controls (the row button, the expanded block's buttons/scrollable content) re-enable hits.
   * There is NO capture lane: an outside click while expanded collapses the block AND reaches
   * the page behind it (VAL-DRAFT-037, the M5 swallow exception was removed).
   */
  :host { all: initial; display: block; pointer-events: none; }
  :host([data-placement='fallback']) { position: absolute; z-index: 2147483000; width: min(340px, calc(100vw - 16px)); }
  .panel-root { display: block; }

  /* ---- the collapsed 36px status row (design-1b §3) ---- */
  .row {
    pointer-events: auto;
    box-sizing: border-box;
    display: flex; align-items: center; gap: 8px;
    width: 100%; height: 36px;
    margin: 0; padding: 10px 0;
    border: 0; border-top: 1px solid var(--line);
    background: var(--bg); color: var(--fg);
    font: 400 13px/16px system-ui, -apple-system, sans-serif;
    text-align: left; cursor: pointer;
  }
  .row .dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; }
  .row .dot[data-tier='good'] { background: var(--good); }
  .row .dot[data-tier='ok'] { background: var(--ok); }
  .row .dot[data-tier='weak'] { background: var(--weak); }
  .row .score { flex: 0 0 auto; font-weight: 700; font-variant-numeric: tabular-nums; }
  .row .viral-label { flex: 0 0 auto; font-weight: 500; white-space: nowrap; }
  .row .summary { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg2); }
  .row .ai { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; color: var(--fg2); }
  .row .ai-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg2); }
  .row .ai-dot[data-state='pending'] { background: var(--accent); animation: amplifyx-pulse 1.2s ease-in-out infinite; }
  .row .ai-dot[data-state='verdict'] { background: var(--good); }
  .row .ai-dot[data-state='error'] { background: var(--weak); }
  .row .chevron { flex: 0 0 auto; transition: transform 0.15s ease; color: var(--fg2); }
  :host([data-expanded='true']) .row .chevron { transform: rotate(180deg); }
  @keyframes amplifyx-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  @media (prefers-reduced-motion: reduce) {
    .row .ai-dot[data-state='pending'] { animation: none; opacity: 0.6; }
  }

  /* ---- the expanded inline analysis (design-1b §4; D2: max height + internal scroll) ---- */
  .expanded {
    pointer-events: auto;
    box-sizing: border-box;
    display: flex; flex-direction: column; gap: 14px;
    padding: 0 0 12px;
    background: var(--bg); color: var(--fg);
    font: 400 13px/16px system-ui, -apple-system, sans-serif;
    max-height: ${String(OVERLAY_PLACEMENT.expandedMaxHeight)}px;
    overflow-y: auto;
  }

  /* ---- signal chips + the "N neutral ›" toggle (§4.1) ---- */
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; font-weight: 500; font-size: 13px; }
  .chip .points { font-weight: 700; font-variant-numeric: tabular-nums; }
  /* Text on tinted/hover surfaces uses the a11y text tokens (VAL-THEME-003) — see tokens.ts. */
  .chip[data-direction='positive'] { color: var(--good-text); background: var(--good-bg); }
  .chip[data-direction='negative'] { color: var(--weak-text); background: var(--weak-bg); }
  .neutral-toggle {
    min-height: 28px; padding: 6px 10px;
    border: 0; border-radius: 999px; background: var(--hover); color: var(--fg2-hover);
    font: 500 13px/16px system-ui, -apple-system, sans-serif; cursor: pointer;
  }
  .rows { list-style: none; margin: 0; padding: 0; }
  .rows li { display: flex; gap: 6px; padding: 2px 0; }
  .rows .label { flex: 0 0 44%; }
  .rows .value { flex: 1; color: var(--fg2); }
  .rows .points { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
  .rows .points[data-direction='positive'] { color: var(--good-text); }
  .rows .points[data-direction='negative'] { color: var(--weak-text); }

  /* ---- the condensed AI block (§4.2 / §6) ---- */
  .ai-block { display: flex; flex-direction: column; gap: 6px; }
  .ai-block .notice { margin: 0; color: var(--fg2); }
  .ai-block .notice button { pointer-events: auto; background: none; border: 0; padding: 0; color: var(--accent); font: inherit; font-weight: 500; text-decoration: none; cursor: pointer; }
  .ai-block .notice button:hover { text-decoration: underline; }
  .ai-head { display: flex; align-items: center; gap: 8px; }
  .ai-chip { display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 999px; font-weight: 500; font-size: 13px; white-space: nowrap; }
  .ai-chip[data-treatment='good'] { color: var(--good-text); background: var(--good-bg); }
  .ai-chip[data-treatment='ok'] { color: var(--fg2-hover); background: var(--hover); }
  .ai-chip[data-treatment='weak'] { color: var(--weak-text); background: var(--weak-bg); }
  .ai-head .weakness { color: var(--fg); font-size: 14px; }
  .try-line { margin: 0; color: var(--fg2); }

  /* ---- the optimizer section (§4.3) ---- */
  .optimizer { display: flex; flex-direction: column; gap: 8px; }
  .optimizer .opt-header { display: flex; align-items: baseline; gap: 8px; }
  .optimizer .opt-title { font-weight: 700; font-size: 14px; }
  .optimizer .opt-caption { color: var(--fg2); font-size: 12px; }
  .btn-outline {
    pointer-events: auto;
    box-sizing: border-box;
    display: inline-flex; align-items: center; justify-content: center;
    min-height: 28px; padding: 0 12px;
    border: 1px solid var(--outline); border-radius: 999px;
    background: transparent; color: var(--fg);
    font: 700 13px/16px system-ui, -apple-system, sans-serif; cursor: pointer;
  }
  .btn-outline:hover { background: var(--hover); }
  .btn-outline:disabled { cursor: default; background: transparent; }
  .btn-outline[data-size='32'] { height: 32px; font-size: 14px; }
  .optimizer .pending-line { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--fg2); }
  .optimizer .pending-line .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); animation: amplifyx-pulse 1.2s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) {
    .optimizer .pending-line .dot { animation: none; opacity: 0.6; }
  }
  .hooks { display: flex; gap: 8px; overflow: auto hidden; }
  .hook-card { flex: 0 0 232px; box-sizing: border-box; width: 232px; border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
  .hook-card .hook-kind { margin: 0 0 4px; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--fg2); }
  .hook-card .hook-text {
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4;
    overflow: hidden; margin: 0 0 6px; font-size: 14px; line-height: 19px;
  }
  .hook-card .hook-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .hook-card .hook-chars { color: var(--fg2); font-size: 12px; font-variant-numeric: tabular-nums; }
  .hook-card .hook-chars[data-over-limit='true'] { color: var(--weak-text); font-weight: 700; }
  .hashtags { margin: 0; color: var(--fg2); }
  .hashtag-line { margin: 0; }
  .hashtag-link {
    pointer-events: auto;
    background: none; border: 0; padding: 0;
    color: var(--accent); font: inherit; font-weight: 500; text-decoration: none; cursor: pointer;
  }
  .hashtag-link:hover { text-decoration: underline; }
  .error-line { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--fg); }
  .error-line .dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: var(--weak); }
  .error-line button { pointer-events: auto; background: none; border: 0; padding: 0; color: var(--accent); font: inherit; font-weight: 500; text-decoration: none; cursor: pointer; }
  .error-line button:hover { text-decoration: underline; }
`;

type HeadlineTier = 'good' | 'ok' | 'weak';

function headlineTier(headline: number): HeadlineTier {
  if (headline >= OVERLAY_HEADLINE_TIERS.good) return 'good';
  if (headline >= OVERLAY_HEADLINE_TIERS.ok) return 'ok';
  return 'weak';
}

/** Design-1b §4.1: explicit sign, U+2212 minus for negatives (never a bare hyphen). */
function formatPoints(points: number): string {
  if (points > 0) return `+${points}`;
  if (points < 0) return `\u2212${Math.abs(points)}`;
  return '0';
}

export function createScoreOverlay(options: ScoreOverlayOptions): ScoreOverlay {
  const doc = options.doc ?? document;
  const win = doc.defaultView ?? window;
  // VAL-OPT-004: the clipboard transfer for variant copy actions (user-gesture driven). Tests
  // inject a spy; the default uses the page clipboard the button's user activation licenses.
  const copyVariant = options.copyVariant ?? ((text: string) => {
    if (!navigator.clipboard) return Promise.reject(new Error('Clipboard unavailable.'));
    return navigator.clipboard.writeText(text);
  });
  const requestOptimize = options.requestOptimize;

  let settings: Settings = { ...DEFAULT_SETTINGS };
  let composer: Element | null = null;
  let capture: DraftSnapshot | null = null;
  const pending = new Map<string, number>();
  let reply: { hash: string; result: DraftAnalysis } | null = null;
  // Per-draft terminal-state ownership (VAL-DRAFT-018): each draft hash owns its own transport
  // failure, so a settling dispatch can never displace another draft's terminal state.
  const transportFailures = new Set<string>();
  // The Optimize lifecycle slot (m4-optimizer): per-draft, matched by identity, reset on every
  // draft change — re-running the optimizer on an identical draft is served by the background's
  // optimizer cache with zero API calls (VAL-OPT-009).
  let optimizerSlot: OptimizerSlot | null = null;

  let mounted = false;
  let destroyed = false;
  // M6: expansion is EXPLICIT (a row click) and never happens on its own. `expanded` is
  // per-composer-attach state, so navigating away and back always starts collapsed again.
  let expanded = false;
  /**
   * True only while the expanded block's OWN "Analyze with AI" action is re-capturing the draft.
   * That re-capture is not a user edit, so it must not collapse the block the user just opened.
   */
  let manualCapture = false;
  // The "N neutral ›" toggle: a LOCAL expansion of the full rows list — no re-render of the rest
  // of the overlay (VAL-DRAFT-044).
  let neutralRowsVisible = false;
  let repositionScheduled = false;
  let mutationObserver: MutationObserver | null = null;
  // Clicks observed INSIDE the host's shadow root (see createHostElement): the outside-click
  // collapse lane must never treat the extension's own controls as "outside".
  const insideClicks = new WeakSet<Event>();
  /** The newest applied settings revision, restamped on every host the overlay mounts. */
  let settingsRevision: number | undefined;
  // M6 theme foundation: live X-theme detection drives every surface's `data-theme` (the token
  // custom properties on each shadow `:host` resolve from it; unknown background falls back to
  // light inside the detector).
  const themeDetector = new ThemeDetector({ doc });
  themeDetector.subscribe(() => {
    const host = hostElement();
    if (host) setHostTheme(host, themeDetector.getTheme());
  });

  // ---- host management (idempotent: exactly one host, keyed by OVERLAY_HOST_ID) ----

  function shouldMount(): boolean {
    return !destroyed && settings.enabled && composer !== null;
  }

  function createHostElement(): HTMLElement {
    const host = doc.createElement('div');
    host.id = OVERLAY_HOST_ID;
    host.attachShadow({ mode: 'open' });
    const shadowRoot = host.shadowRoot!;
    const style = doc.createElement('style');
    style.textContent = STYLE;
    const panelRoot = doc.createElement('div');
    panelRoot.className = 'panel-root';
    shadowRoot.append(style, panelRoot);
    applyThemeTokens(shadowRoot);
    setHostTheme(host, themeDetector.getTheme());
    if (settingsRevision !== undefined) host.dataset.settingsRevision = String(settingsRevision);
    // Observe (never swallow) clicks that happen inside this shadow root: the outside-click lane
    // must not collapse on the extension's own controls. A per-event mark is ordering-proof —
    // the row's own click handler re-renders synchronously, detaching the clicked node before
    // the document-level listener runs (a composed-path check alone would then miss).
    shadowRoot.addEventListener(
      'click',
      (event) => {
        if (event instanceof Event) insideClicks.add(event);
      },
      true,
    );
    return host;
  }

  /** X's toolBar inside the composer's anchor region, or null (then the fallback applies). */
  function anchorToolBar(): Element | null {
    if (composer === null) return null;
    const region = findComposerAnchorRegion(composer);
    return findFirst(region, 'composerToolBar');
  }

  /**
   * IN-FLOW insertion (Design 1b, probe-verified on real x.com): the host becomes the immediate
   * preceding sibling of X's `[data-testid="toolBar"]`. This is a NEW node in X's React tree —
   * idempotent, re-attached by the observer when a re-render detaches it, and it NEVER moves or
   * modifies X's own nodes. Fallback (toolbar not found): appended to document.body for absolute
   * placement below the composer region, same row anatomy.
   */
  function insertHost(host: HTMLElement): 'flow' | 'fallback' {
    const toolBar = anchorToolBar();
    const parent = toolBar?.parentElement ?? null;
    if (toolBar && parent) {
      parent.insertBefore(host, toolBar);
      host.dataset.placement = 'flow';
      return 'flow';
    }
    doc.body.append(host);
    host.dataset.placement = 'fallback';
    return 'fallback';
  }

  function mountHost(): void {
    if (mounted || !shouldMount()) return;
    // Idempotency: an existing attached host node (e.g. left over from a settings toggle in the
    // same document) is reused only when it is still attached AND still carries its shadow root.
    const existing = doc.getElementById(OVERLAY_HOST_ID);
    const host = existing && existing.isConnected && existing.shadowRoot ? existing : createHostElement();
    if (host !== existing) existing?.remove();
    if (!host.isConnected) insertHost(host);
    mounted = true;
    // React re-renders can detach our host (and page layout can move the composer): the observer
    // re-attaches the host and keeps the fallback placement honest.
    mutationObserver ??= new MutationObserver(() => onDocMutated());
    mutationObserver.observe(doc.body ?? doc, { childList: true, subtree: true });
  }

  function onDocMutated(): void {
    if (mounted && shouldMount() && hostElement() === null) {
      // A React re-render detached the host: re-insert it as if freshly mounted (same anchor
      // rules, same idempotency — X's own nodes are never touched). The fresh host starts empty;
      // render() repaints the current view into it.
      insertHost(createHostElement());
      render();
      return;
    }
    scheduleReposition(); // fallback placement upkeep; a no-op in flow mode
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

  function panelRoot(): HTMLElement | null {
    return hostElement()?.shadowRoot?.querySelector<HTMLElement>('.panel-root') ?? null;
  }

  // ---- rendering (createElement only; web-ext lint forbids innerHTML in extension code) ----

  function el(
    tag: string,
    init: { testid?: string; className?: string; text?: string } = {},
  ): HTMLElement {
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

  /** The AI state's LONG form for the row's aria-label (§6; the verdict state collapses to its short). */
  function aiLong(view: AnalyzedView): string {
    switch (view.jev.state) {
      case 'pending':
        return OVERLAY_COPY.pendingLong;
      case 'ready':
        return `${OVERLAY_COPY.readyLongBefore}${OVERLAY_COPY.readyLink}${OVERLAY_COPY.readyLongAfter}`;
      case 'verdict':
        return `${OVERLAY_COPY.verdictShortPrefix}${bandLabel(view.jev.verdict!)}`;
      case 'no-key':
        return `${OVERLAY_COPY.noKeyLongBefore}${OVERLAY_COPY.noKeyLink}${OVERLAY_COPY.noKeyLongAfter}`;
      case 'off':
        return OVERLAY_COPY.offLong;
      case 'error':
        return OVERLAY_COPY.errorLong(view.headline, view.jev.reason ?? OVERLAY_COPY.errorReasons.network);
    }
  }

  function aiShortLabel(view: AnalyzedView): string {
    switch (view.jev.state) {
      case 'pending':
        return OVERLAY_COPY.pendingShort;
      case 'ready':
        return OVERLAY_COPY.readyShort;
      case 'verdict':
        return `${OVERLAY_COPY.verdictShortPrefix}${bandLabel(view.jev.verdict!)}`;
      case 'no-key':
      case 'off':
        return OVERLAY_COPY.noKeyShort;
      case 'error':
        return OVERLAY_COPY.errorShort;
    }
  }

  function rowLabel(view: AnalyzedView): string {
    // The long forms are full sentences ending in a period; the label template adds its own
    // period, so the sentence's trailing one is dropped to avoid a doubled dot.
    const aiLongText = aiLong(view).replace(/\.$/u, '');
    return OVERLAY_COPY.rowLabel.replace('{n}', String(view.headline)).replace('{aiLong}', aiLongText);
  }

  // ---- optimizer rendering (§4.3; English-only surface, VAL-CROSS-016) ----

  function copyButton(variant: HookVariant): HTMLElement {
    const button = el('button', {
      className: 'btn-outline',
      testid: OVERLAY_TESTIDS.optimizerCopy,
      text: OVERLAY_COPY.copyButton,
    }) as HTMLButtonElement;
    // VAL-OPT-004: the button puts EXACTLY the variant text on the clipboard — no labels, no
    // extra text — and never touches the composer (VAL-OPT-005: copy is the transfer mechanism).
    button.addEventListener('click', () => {
      void copyVariant(variant.text)
        .then(() => {
          button.textContent = OVERLAY_COPY.copiedLabel;
          button.disabled = true;
          setTimeout(() => {
            if (button.isConnected) {
              button.textContent = OVERLAY_COPY.copyButton;
              button.disabled = false;
            }
          }, OPTIMIZER_COPY_RESET_MS);
        })
        .catch(() => undefined);
    });
    return button;
  }

  function variantCard(variant: HookVariant): HTMLElement {
    const card = el('article', { className: 'hook-card', testid: OVERLAY_TESTIDS.optimizerVariant });
    card.dataset.variantKind = variant.kind;
    // VAL-OPT-007: an over-limit variant is explicitly flagged (never presented as ready).
    card.dataset.overLimit = String(variant.overLimit);
    card.append(el('h4', { className: 'hook-kind', text: VARIANT_LABELS[variant.kind] }));
    card.append(
      el('p', { className: 'hook-text', testid: OVERLAY_TESTIDS.optimizerVariantText, text: variant.text }),
    );
    const footer = el('div', { className: 'hook-footer' });
    footer.append(
      el('span', {
        className: 'hook-chars',
        testid: OVERLAY_TESTIDS.optimizerVariantChars,
        text: variant.overLimit
          ? OVERLAY_COPY.overLimitFlag(variant.weightedChars)
          : OVERLAY_COPY.charNote(variant.weightedChars),
      }),
    );
    if (variant.overLimit) footer.querySelector('.hook-chars')?.setAttribute('data-over-limit', 'true');
    footer.append(copyButton(variant));
    card.append(footer);
    return card;
  }

  function hashtagsBlock(optimization: Extract<OptimizerSlot, { phase: 'done' }>['optimization']): HTMLElement {
    const box = el('div', { className: 'hashtags', testid: OVERLAY_TESTIDS.optimizerHashtags });
    const advice = optimization.hashtags;
    if (advice.suggestions.length === 0) {
      box.append(el('p', { text: OVERLAY_COPY.noHashtags }));
      return box;
    }
    // §4.3: "Add #Tag · #Tag" as --accent links with the rationale in the title tooltip. The
    // tags are buttons styled as links (no navigation, composer untouched); any click behavior
    // belongs to the optimizer feature, not the row.
    const line = el('p', { className: 'hashtag-line' });
    line.append(el('span', { text: `${OVERLAY_COPY.hashtagAdd} ` }));
    advice.suggestions.forEach((suggestion, index) => {
      if (index > 0) line.append(el('span', { text: ' · ' }));
      const link = el('button', {
        className: 'hashtag-link',
        testid: OVERLAY_TESTIDS.optimizerHashtag,
        text: `#${suggestion.tag}`,
      });
      link.title = suggestion.rationale;
      line.append(link);
    });
    box.append(line);
    // VAL-OPT-006: when the draft already carries excess hashtags, name which to drop.
    if (advice.dropAdvice !== undefined) {
      box.append(el('p', { testid: OVERLAY_TESTIDS.optimizerDropAdvice, text: advice.dropAdvice }));
    }
    return box;
  }

  /** The Optimize lifecycle: eligible-draft gate -> loading slot -> dispatch -> reply/failure. */
  function optimizeNow(): void {
    if (!capture || !requestOptimize) return;
    if (!settings.jevForDrafts || !options.getKeyPresence()) return;
    const hash = draftIdentity(capture);
    if (optimizerSlot?.hash === hash && optimizerSlot.phase === 'loading') return; // already in flight
    optimizerSlot = { hash, phase: 'loading' };
    render();
    requestOptimize(capture);
  }

  /** An outline pill action (the optimizer's "Find stronger hooks"). */
  function outlineAction(text: string, testid: string, onClick: () => void): HTMLElement {
    const button = el('button', { className: 'btn-outline', testid, text });
    button.dataset.size = '32';
    button.addEventListener('click', onClick);
    return button;
  }

  function pendingLine(text: string, testid: string): HTMLElement {
    const line = el('p', { className: 'pending-line', testid });
    line.append(el('span', { className: 'dot' }));
    line.append(el('span', { text }));
    return line;
  }

  function errorLine(text: string, testid: string, retry: (() => void) | null): HTMLElement {
    const line = el('p', { className: 'error-line', testid });
    line.append(el('span', { className: 'dot' }));
    line.append(el('span', { text }));
    if (retry) line.append(linkButton(OVERLAY_COPY.retryLink, OVERLAY_TESTIDS.retry, retry));
    return line;
  }

  /** A link-styled button embedded in a notice line (no innerHTML anywhere). */
  function linkButton(text: string, testid: string, onClick: () => void): HTMLElement {
    const link = el('button', { testid, text });
    link.addEventListener('click', onClick);
    return link;
  }

  function optimizerSection(view: AnalyzedView): HTMLElement | null {
    // M6 user decision D3: without AI (no key, or the AI lane off in Settings) the optimizer
    // section is HIDDEN entirely — no disabled button, no guidance notice.
    if (view.optimizer.state === 'no-key' || view.optimizer.state === 'off') return null;
    const section = el('section', { className: 'optimizer', testid: OVERLAY_TESTIDS.optimizer });
    section.dataset.optimizerState = view.optimizer.state;
    switch (view.optimizer.state) {
      case 'idle':
        section.append(outlineAction(OVERLAY_COPY.optimizeButton, OVERLAY_TESTIDS.optimize, () => optimizeNow()));
        break;
      case 'loading':
        section.append(pendingLine(OVERLAY_COPY.optimizerPending, OVERLAY_TESTIDS.optimizerPending));
        break;
      case 'done': {
        const header = el('div', { className: 'opt-header' });
        header.append(el('span', { className: 'opt-title', text: OVERLAY_COPY.optimizerHeading }));
        header.append(el('span', { className: 'opt-caption', text: OVERLAY_COPY.optimizerCaption }));
        section.append(header);
        const list = el('div', { className: 'hooks', testid: OVERLAY_TESTIDS.optimizerVariants });
        for (const variant of view.optimizer.optimization.variants) list.append(variantCard(variant));
        section.append(list);
        section.append(hashtagsBlock(view.optimizer.optimization));
        break;
      }
      case 'error':
        // VAL-OPT-010: explicit non-blocking error; local scoring and the composer untouched.
        section.append(errorLine(OVERLAY_COPY.optimizerError, OVERLAY_TESTIDS.optimizerNotice, () => optimizeNow()));
        break;
    }
    return section;
  }

  // ---- the expanded block's sections (§4) ----

  function verbatimRow(label: string, value: string): HTMLElement {
    const row = el('li');
    row.append(el('span', { className: 'label', text: label }));
    row.append(el('span', { className: 'value', text: value }));
    return row;
  }

  function chipsSection(view: AnalyzedView): HTMLElement {
    const box = el('div', { className: 'chips-box', testid: OVERLAY_TESTIDS.signals });
    const chips = el('div', { className: 'chips' });
    for (const chip of view.chips) {
      const chipEl = el('span', { className: 'chip', testid: OVERLAY_TESTIDS.chip });
      chipEl.dataset.signalId = chip.id;
      chipEl.dataset.direction = chip.direction;
      chipEl.append(el('span', { className: 'phrase', text: chip.phrase }));
      chipEl.append(el('span', { className: 'points', text: formatPoints(chip.points) }));
      chips.append(chipEl);
    }
    if (view.neutralCount > 0) {
      const toggle = el('button', {
        className: 'neutral-toggle',
        testid: OVERLAY_TESTIDS.neutralToggle,
        text: OVERLAY_COPY.neutralToggle(view.neutralCount),
      });
      toggle.setAttribute('aria-expanded', String(neutralRowsVisible));
      // The rows list is built fresh on each reveal (the view is immutable); the LOCAL toggle
      // never re-renders the other blocks, so the block's scroll position is preserved.
      let current: HTMLElement | null = neutralRowsVisible ? rowsList(view) : null;
      if (current !== null) box.append(current);
      toggle.addEventListener('click', () => {
        neutralRowsVisible = !neutralRowsVisible;
        toggle.setAttribute('aria-expanded', String(neutralRowsVisible));
        if (neutralRowsVisible && current === null) {
          current = rowsList(view);
          box.append(current);
        } else if (!neutralRowsVisible && current !== null) {
          current.remove();
          current = null;
        }
      });
      chips.append(toggle);
    }
    box.append(chips);
    return box;
  }

  /** The full rows list (label / value / points) behind the "N neutral ›" toggle. */
  function rowsList(view: AnalyzedView): HTMLElement {
    const list = el('ul', { className: 'rows', testid: OVERLAY_TESTIDS.signalRows });
    for (const signal of view.local.signals) list.append(signalRow(signal));
    // §4.2: the verdict's REMAINING weaknesses/suggestions surface only here.
    if (view.jev.state === 'verdict' && view.jev.verdict) {
      for (const weakness of view.jev.verdict.weaknesses.slice(1)) {
        list.append(verbatimRow('Weakness', weakness));
      }
      for (const suggestion of view.jev.verdict.suggestions.slice(1)) {
        list.append(verbatimRow('Suggestion', suggestion));
      }
    }
    return list;
  }

  function aiBlock(view: AnalyzedView): HTMLElement {
    const box = el('div', { className: 'ai-block', testid: OVERLAY_TESTIDS.jev });
    box.dataset.jevState = view.jev.state;
    switch (view.jev.state) {
      case 'pending':
        box.append(
          el('p', { className: 'notice', testid: OVERLAY_TESTIDS.jevNotice, text: OVERLAY_COPY.pendingLong }),
        );
        break;
      case 'ready': {
        // VAL-SETUP-010: with autoAnalyze off, typing stayed local-only and free (zero Jev
        // requests); the network half runs ONLY when the user activates the link, exactly once.
        const notice = el('p', { className: 'notice', testid: OVERLAY_TESTIDS.jevNotice });
        notice.append(el('span', { text: OVERLAY_COPY.readyLongBefore }));
        notice.append(
          linkButton(OVERLAY_COPY.readyLink, OVERLAY_TESTIDS.analyze, () => {
            // The manual trigger re-captures the draft synchronously. That re-capture is the
            // overlay's own doing, not a user edit, so it must NOT collapse the block the user
            // is looking at (VAL-SETUP-010).
            manualCapture = true;
            options.requestAnalysis();
          }),
        );
        notice.append(el('span', { text: OVERLAY_COPY.readyLongAfter }));
        box.append(notice);
        break;
      }
      case 'verdict': {
        const verdict = view.jev.verdict!;
        const head = el('div', { className: 'ai-head' });
        const chip = el('span', {
          className: 'ai-chip',
          testid: OVERLAY_TESTIDS.jevBand,
          text: `${OVERLAY_COPY.verdictChipPrefix}${bandLabel(verdict)}`,
        });
        chip.dataset.band = verdict.band;
        chip.dataset.treatment = JEVD_BAND_TREATMENT[verdict.band];
        head.append(chip);
        if (verdict.weaknesses.length > 0) {
          head.append(
            el('span', { className: 'weakness', testid: OVERLAY_TESTIDS.jevWeakness, text: verdict.weaknesses[0]! }),
          );
        }
        box.append(head);
        const pct = Math.round(verdict.confidence * 100);
        const tryText =
          verdict.suggestions.length > 0
            ? `${OVERLAY_COPY.tryPrefix} ${verdict.suggestions[0]!}${OVERLAY_COPY.confidenceSuffix(pct)}`
            : OVERLAY_COPY.confidenceOnly(pct);
        box.append(el('p', { className: 'try-line', testid: OVERLAY_TESTIDS.jevTryLine, text: tryText }));
        break;
      }
      case 'no-key': {
        const notice = el('p', { className: 'notice', testid: OVERLAY_TESTIDS.jevNotice });
        notice.append(el('span', { text: OVERLAY_COPY.noKeyLongBefore }));
        notice.append(linkButton(OVERLAY_COPY.noKeyLink, OVERLAY_TESTIDS.connectJev, () => options.openOptions()));
        notice.append(el('span', { text: OVERLAY_COPY.noKeyLongAfter }));
        box.append(notice);
        break;
      }
      case 'off':
        box.append(
          el('p', { className: 'notice', testid: OVERLAY_TESTIDS.jevNotice, text: OVERLAY_COPY.offLong }),
        );
        break;
      case 'error': {
        const reason = view.jev.reason ?? OVERLAY_COPY.errorReasons.network;
        const line = el('p', { className: 'notice', testid: OVERLAY_TESTIDS.jevNotice });
        line.append(el('span', { text: `${OVERLAY_COPY.errorLong(view.headline, reason)} ` }));
        line.append(
          linkButton(OVERLAY_COPY.retryLink, OVERLAY_TESTIDS.retry, () => {
            manualCapture = true;
            options.requestAnalysis();
          }),
        );
        box.append(line);
        break;
      }
    }
    return box;
  }

  function renderExpandedInto(block: HTMLElement, view: AnalyzedView): void {
    block.dataset.state = view.phase;
    block.append(chipsSection(view));
    block.append(aiBlock(view));
    const optimizer = optimizerSection(view);
    if (optimizer) block.append(optimizer);
  }

  /**
   * The COLLAPSED STATUS ROW (VAL-DRAFT-032): the fixed 36px anatomy — tier dot + headline
   * score, "Viral potential", the up-to-2-signal summary, the AI-state dot + short label, and
   * the chevron. The whole row is ONE `<button aria-expanded>`; its accessible name carries the
   * full English sentence for assistive tech. The row never changes height while the user types.
   */
  function rowButton(view: AnalyzedView): HTMLElement {
    const row = el('button', { className: 'row', testid: OVERLAY_TESTIDS.row });
    row.dataset.state = 'analyzed';
    row.dataset.tier = headlineTier(view.headline);
    row.dataset.jevState = view.jev.state;
    row.dataset.headlineSource = view.headlineSource;
    row.setAttribute('aria-expanded', String(expanded));
    row.setAttribute('aria-label', rowLabel(view));

    const dot = el('span', { className: 'dot' });
    dot.dataset.tier = headlineTier(view.headline);
    row.append(dot);
    row.append(el('span', { className: 'score', testid: OVERLAY_TESTIDS.headline, text: String(view.headline) }));
    row.append(el('span', { className: 'viral-label', text: OVERLAY_COPY.viralLabel }));
    // §3: "· " + up to 2 short phrases of the highest-|points| signals; nothing when none scored.
    const summaryText = view.summary.length > 0 ? `\u00B7 ${view.summary.join(' \u00B7 ')}` : '';
    row.append(el('span', { className: 'summary', testid: OVERLAY_TESTIDS.summary, text: summaryText }));
    const ai = el('span', { className: 'ai', testid: OVERLAY_TESTIDS.aiState });
    const aiDot = el('span', { className: 'ai-dot' });
    aiDot.dataset.state = view.jev.state;
    ai.append(aiDot);
    ai.append(el('span', { className: 'ai-label', text: aiShortLabel(view) }));
    row.append(ai);
    const chevron = el('span', { className: 'chevron', text: '\u2304' });
    chevron.setAttribute('aria-hidden', 'true');
    row.append(chevron);

    row.addEventListener('click', () => {
      if (destroyed || capture === null) return;
      expanded = true;
      render();
    });
    return row;
  }

  function render(): void {
    if (!shouldMount()) return;
    const view = deriveOverlayView({
      settings,
      keyPresent: options.getKeyPresence(),
      capture,
      pending,
      reply,
      transportFailures,
      optimizer: optimizerSlot,
    });
    // No qualifying draft ⇒ NO extension UI near the composer at all: the host is removed, not
    // merely emptied (VAL-DRAFT-005/014 — no row, no expanded block, no awaiting balloon).
    if (view.phase === 'empty') {
      if (mounted) unmountHost();
      return;
    }
    mountHost();
    const root = panelRoot();
    const host = hostElement();
    if (!root || !host) return;
    host.dataset.expanded = String(expanded);
    const row = rowButton(view);
    if (!expanded) {
      root.replaceChildren(row);
    } else {
      const block = el('div', { className: 'expanded', testid: OVERLAY_TESTIDS.panel });
      renderExpandedInto(block, view);
      root.replaceChildren(row, block);
    }
    scheduleReposition(); // fallback placement only; a no-op in flow mode
  }

  /**
   * Collapses the expanded block back to the row (VAL-DRAFT-035/036/037). Idempotent and cheap:
   * with nothing expanded it is a no-op, so the composer-edit lane can call it freely.
   */
  function collapse(): void {
    if (!expanded) return;
    expanded = false;
    render();
  }

  // ---- fallback placement (toolbar not found) ----

  function expandedElement(): HTMLElement | null {
    return hostElement()?.shadowRoot?.querySelector<HTMLElement>('.expanded') ?? null;
  }

  function reposition(): void {
    const host = hostElement();
    if (!host || !composer || host.dataset.placement !== 'fallback') return;
    // PLACEMENT anchors to the furniture-containing region (m5-overlay-scroll-reach); the
    // fallback degrades to the extraction region wherever the furniture is not found.
    const region = findComposerAnchorRegion(composer);
    const regionBox =
      region instanceof Element
        ? region.getBoundingClientRect()
        : { top: 0, bottom: 0, left: 0, width: 0, height: 0, right: 0 };
    const block = expandedElement();
    // Measure the block's NATURAL size: a stale cap would shrink the decision input and let the
    // cap oscillate off on the next reposition (VAL-DRAFT-023).
    block?.style.removeProperty('max-height');
    const hostBox = host.getBoundingClientRect();
    const width = hostBox.width || OVERLAY_PLACEMENT.fallbackWidth;
    const height = hostBox.height || OVERLAY_PLACEMENT.fallbackHeight;
    const position = computeAnchorPosition({
      regionRect: { top: regionBox.top, bottom: regionBox.bottom, left: regionBox.left },
      overlaySize: { width, height },
      viewport: { width: win.innerWidth, height: win.innerHeight },
      scroll: { x: win.scrollX, y: win.scrollY },
    });
    host.style.top = `${position.top}px`;
    host.style.left = `${position.left}px`;
    if (position.maxHeight === null) block?.style.removeProperty('max-height');
    else block?.style.setProperty('max-height', `${Math.max(position.maxHeight, 0)}px`);
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

  /** Escape collapses the expanded block back to the row (VAL-DRAFT-035). */
  const onKeyDown = (event: Event): void => {
    if ((event as KeyboardEvent).key !== 'Escape') return;
    collapse();
  };
  doc.addEventListener('keydown', onKeyDown, true);

  /**
   * Outside click collapses AND is FORWARDED (VAL-DRAFT-037, the M6 design): the listener only
   * collapses — it never preventDefaults, stops propagation, or captures. The click proceeds
   * natively to the page element behind it. Clicks inside our own shadow root (row, expanded
   * block, its buttons, its scrolled content) are never ours to collapse on.
   */
  const onDocClick = (event: Event): void => {
    if (destroyed || !expanded) return;
    if (insideClicks.has(event)) return;
    const host = hostElement();
    if (host === null) return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (path.includes(host)) return;
    const root = host.shadowRoot;
    if (root !== null && path.some((node) => node instanceof win.Node && root.contains(node))) return;
    collapse();
  };
  doc.addEventListener('click', onDocClick, false);

  // ---- state updates ----

  function clearAnalysisState(): void {
    capture = null;
    pending.clear();
    reply = null;
    transportFailures.clear();
    optimizerSlot = null;
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
    /**
     * Collapses the expanded block without touching the captured draft (VAL-DRAFT-036). Called on
     * the watcher's IMMEDIATE user-edit lane, so typing collapses the block at the keystroke
     * instead of ~700ms later when the debounced capture lands.
     */
    collapsePanel() {
      collapse();
    },
    onSettings(next, revision) {
      settings = next;
      settingsRevision = revision ?? settingsRevision;
      if (revision !== undefined) {
        const host = hostElement();
        if (host) host.dataset.settingsRevision = String(revision);
      }
      if (!next.enabled) {
        clearAnalysisState();
        expanded = false;
        unmountHost();
        return;
      }
      render();
    },
    onDraftCaptured(event) {
      if (manualCapture) {
        // The user's own Analyze action: keep the block open and let the local half repaint.
        manualCapture = false;
      } else {
        // VAL-DRAFT-036: ANY other capture is a user edit, so the expanded block collapses back
        // to the row BEFORE the new draft paints.
        collapse();
      }
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
      expanded = false; // a new composer (SPA navigation) always starts collapsed
      neutralRowsVisible = false;
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
      // instead of spinning forever.
      const hash = draftIdentity(snapshot);
      if (pendingCount(hash) <= 0) return; // unknown or already-settled dispatch: nothing to settle
      settlePending(hash);
      transportFailures.add(hash);
      render();
    },
    onOptimizeResult(result: OptimizationResult, dispatched: DraftSnapshot) {
      const hash = draftIdentity(dispatched);
      // A reply for anything but the CURRENT draft is stale (the user kept typing) — discard.
      if (capture === null || draftIdentity(capture) !== hash) return;
      if (result.kind === 'optimized') {
        optimizerSlot = { hash, phase: 'done', optimization: result.optimization };
      } else if (result.kind === 'error') {
        optimizerSlot = { hash, phase: 'error', failure: result.failure };
      } else {
        // Honest refusals (disabled/unavailable/no-key): the section derives its gate states live
        // from settings and key presence, so just retire the loading slot.
        optimizerSlot = null;
      }
      render();
    },
    onOptimizeFailed(dispatched: DraftSnapshot) {
      const hash = draftIdentity(dispatched);
      if (capture === null || draftIdentity(capture) !== hash) return;
      if (optimizerSlot?.hash === hash && optimizerSlot.phase === 'loading') {
        optimizerSlot = { hash, phase: 'error', failure: { kind: 'network', reason: 'unreachable' } };
        render();
      }
    },
    destroy() {
      destroyed = true;
      manualCapture = false;
      win.removeEventListener('resize', onResize);
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('click', onDocClick, false);
      themeDetector.destroy();
      unmountHost();
      clearAnalysisState();
    },
  };
}
