/**
 * ScoreOverlay controller — the draft-analysis surface near the active composer.
 *
 * COLLAPSED-FIRST (M5, user-approved after real-site testing): the always-expanded panel covered
 * X's own mention-autocomplete and could not be scrolled, so the default surface is a COMPACT
 * PILL showing ONLY the headline number. Clicking it expands the full detail panel; the panel
 * collapses on an outside click (which never reaches the page), on Escape, and on ANY new user
 * edit in the composer — that last rule is the deterministic anti-occlusion guarantee, since while
 * typing only the pill exists and X's mention/emoji/GIF popups grow into free space below it.
 * No qualifying draft means NO UI at all: no pill, no panel, no awaiting balloon.
 *
 * Ownership rules (architecture.md): the surface lives in its OWN Shadow-DOM host appended to
 * `document.body`, never inside the React-managed x.com tree; and pointer capture is deliberately
 * asymmetric — the host is `pointer-events: none` always, only the pill button takes hits, and
 * ONLY the expanded panel re-enables hits on itself (the one user-approved exception to the
 * no-pointer-capture convention, AGENTS.md).
 *
 * State machine (see `view-model.ts`): `empty` below the minimum length renders nothing at all;
 * `analyzed` renders the local "Algorithm signals" half immediately at capture time (never waiting
 * for Jev — VAL-DRAFT-006) plus the "AI judgment" half that arrives asynchronously and is clearly
 * distinguished (VAL-DRAFT-008). Replies match drafts by hash, so the newest draft always wins
 * (VAL-DRAFT-011), and every Jev half-state (pending, verdict, no key, off, failure) renders an
 * explicit English notice inside the expanded panel while the pill keeps the usable local score.
 */
import type { DraftSnapshot } from '@/core/draft-snapshot';
import { JEV_BAND_LABELS, type JevVerdict } from '@/core/heuristic-engine';
import { DEFAULT_SETTINGS, type Settings } from '@/core/settings-store';
import type { DraftAnalysis, DraftAnalysisResult } from '@/core/analyzer';
import { VARIANT_LABELS, type HookVariant, type OptimizationResult } from '@/core/optimizer';
import type { SignalEntry } from '@/core/heuristic-engine';
import { findComposerAnchorRegion } from '@/dom/composer-watcher';
import { SELECTORS } from '@/selectors';
import {
  OPTIMIZER_COPY_RESET_MS,
  OVERLAY_COPY,
  OVERLAY_HEADLINE_TIERS,
  OVERLAY_HOST_ID,
  OVERLAY_PLACEMENT,
  OVERLAY_TESTIDS,
} from './config';
import { clampPillClearOfControl, computeAnchorPosition, computePillPosition } from './position';
import { deriveOverlayView, draftIdentity } from './view-model';
import type { OptimizerSection, OptimizerSlot, OverlayView, ScoreOverlay, ScoreOverlayOptions } from './types';

const STYLE = `
  /*
   * Pointer discipline (AGENTS.md, the one approved exception made explicit):
   *   - the HOST is always pointer-events: none, so it can never intercept a page click;
   *   - the collapsed state re-enables hits ONLY on the pill itself — nothing else, so typing,
   *     media attach, posting, timeline clicks and page scrolling pass through untouched;
   *   - the EXPANDED panel re-enables hits on itself, because the user explicitly opened it and
   *     the first outside click must close it without reaching the page (VAL-DRAFT-037).
   */
  :host { all: initial; position: absolute; z-index: 2147483000; pointer-events: none; }
  .panel-root { pointer-events: none; }
  .pill {
    pointer-events: auto;
    box-sizing: border-box;
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 26px; height: 20px; padding: 0 7px;
    border: 1px solid #cfd9de; border-radius: 999px;
    background: #ffffff; color: #0f1419;
    font: 700 12px/1 system-ui, -apple-system, sans-serif;
    font-variant-numeric: tabular-nums;
    cursor: pointer; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
  }
  .pill[data-tier="good"] { color: #00876a; border-color: #00876a; }
  .pill[data-tier="ok"] { color: #8a6400; border-color: #b58105; }
  .pill[data-tier="weak"] { color: #c4302b; border-color: #c4302b; }
  .pill[data-jev-state="pending"] { border-style: dashed; }
  .panel {
    pointer-events: auto;
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
  button:disabled { background: #d0d9de; cursor: default; }
  .variant-kind { display: block; font-size: 11px; font-weight: 700; letter-spacing: 0.04em;
    text-transform: uppercase; color: #536471; margin-top: 6px; }
  .variant-text { margin: 2px 0; color: #0f1419; }
  .variant-chars { display: block; color: #536471; font-size: 11px; margin: 0 0 2px; }
  .variant-chars[data-over-limit="true"] { color: #d64545; font-weight: 600; }
  .optimizer-variant { display: block; border-top: 1px solid #eff3f4; padding: 4px 0 6px; }
  .optimizer-variant li, .optimizer-hashtag { display: block; }
  .optimizer-hashtag { padding: 2px 0; }
  .hashtag-tag { font-weight: 600; margin-right: 6px; }
  .hashtag-rationale { color: #536471; }
  .drop-advice { color: #536471; margin: 4px 0 0; }
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
  // failure, so a settling dispatch can never displace another draft's terminal state (a single
  // slot let an older failing draft erase the current draft's error and downgrade it to ready).
  const transportFailures = new Set<string>();
  // The Optimize lifecycle slot (m4-optimizer): per-draft, matched by identity, reset on every
  // draft change — re-clicking Optimize on an identical draft is then served by the background's
  // optimizer cache with zero API calls (VAL-OPT-009).
  let optimizerSlot: OptimizerSlot | null = null;

  let mounted = false;
  let destroyed = false;
  // M5: expansion is EXPLICIT (a pill click) and never happens on its own. `expanded` is
  // per-composer-attach state, so navigating away and back always starts collapsed again.
  let expanded = false;
  /**
   * True only while the panel's OWN "Analyze with AI" action is re-capturing the draft. That
   * re-capture is not a user edit, so it must not collapse the panel the user just opened.
   */
  let manualCapture = false;
  // Host dimensions by state, so a toggle never measures a stale size for the new one.
  let collapsedSize: { width: number; height: number } = {
    width: OVERLAY_PLACEMENT.pillWidth,
    height: OVERLAY_PLACEMENT.pillHeight,
  };
  let expandedSize: { width: number; height: number } = {
    width: OVERLAY_PLACEMENT.fallbackWidth,
    height: OVERLAY_PLACEMENT.fallbackHeight,
  };
  let repositionScheduled = false;
  let mutationObserver: MutationObserver | null = null;
  /** The newest applied settings revision, restamped on every host the overlay mounts. */
  let settingsRevision: number | undefined;

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
    // Observability: the newest applied settings revision travels with whatever host exists, so
    // a freshly mounted surface always carries the settings that produced it.
    if (settingsRevision !== undefined) host.dataset.settingsRevision = String(settingsRevision);
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

  function panelRoot(): HTMLElement | null {
    return hostElement()?.shadowRoot?.querySelector<HTMLElement>('.panel-root') ?? null;
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

  // ---- optimizer rendering (m4-optimizer; English-only surface, VAL-CROSS-016) ----

  function copyButton(variant: HookVariant): HTMLElement {
    const button = el('button', { testid: OVERLAY_TESTIDS.optimizerCopy, text: OVERLAY_COPY.copyButton }) as HTMLButtonElement;
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

  function variantItem(variant: HookVariant): HTMLElement {
    const item = el('li', { className: 'optimizer-variant', testid: OVERLAY_TESTIDS.optimizerVariant });
    item.dataset.variantKind = variant.kind;
    // VAL-OPT-007: an over-limit variant is explicitly flagged (never presented as ready).
    item.dataset.overLimit = String(variant.overLimit);
    item.append(el('span', { className: 'variant-kind', text: VARIANT_LABELS[variant.kind] }));
    item.append(
      el('p', { className: 'variant-text', testid: OVERLAY_TESTIDS.optimizerVariantText, text: variant.text }),
    );
    item.append(
      el('span', {
        className: 'variant-chars',
        testid: OVERLAY_TESTIDS.optimizerVariantChars,
        text: variant.overLimit
          ? OVERLAY_COPY.overLimitFlag.replace('{n}', String(variant.weightedChars))
          : OVERLAY_COPY.charNote.replace('{n}', String(variant.weightedChars)),
      }),
    );
    if (variant.overLimit) item.querySelector('.variant-chars')?.setAttribute('data-over-limit', 'true');
    item.append(copyButton(variant));
    return item;
  }

  function hashtagsBlock(optimization: Extract<OptimizerSlot, { phase: 'done' }>['optimization']): HTMLElement {
    const box = el('div', { testid: OVERLAY_TESTIDS.optimizerHashtags });
    box.append(el('h4', { className: 'subheading', text: OVERLAY_COPY.hashtagHeading }));
    const advice = optimization.hashtags;
    if (advice.suggestions.length === 0) {
      box.append(el('p', { className: 'notice', text: OVERLAY_COPY.noHashtags }));
    } else {
      const list = el('ul');
      for (const suggestion of advice.suggestions) {
        const item = el('li', { className: 'optimizer-hashtag', testid: OVERLAY_TESTIDS.optimizerHashtag });
        item.dataset.tag = suggestion.tag;
        item.append(el('span', { className: 'hashtag-tag', text: `#${suggestion.tag}` }));
        item.append(el('span', { className: 'hashtag-rationale', text: suggestion.rationale }));
        list.append(item);
      }
      box.append(list);
    }
    // VAL-OPT-006: when the draft already carries excess hashtags, name which to drop.
    if (advice.dropAdvice !== undefined) {
      box.append(el('p', { className: 'drop-advice', testid: OVERLAY_TESTIDS.optimizerDropAdvice, text: advice.dropAdvice }));
    }
    return box;
  }

  function optimizeButton(enabled: boolean): HTMLElement {
    const button = el('button', { testid: OVERLAY_TESTIDS.optimize, text: OVERLAY_COPY.optimizeButton }) as HTMLButtonElement;
    button.dataset.state = enabled ? 'enabled' : 'disabled';
    if (!enabled) {
      button.disabled = true;
      return button;
    }
    button.addEventListener('click', () => optimizeNow());
    return button;
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

  function optimizerSection(view: { optimizer: OptimizerSection }): HTMLElement {
    const section = el('section', { testid: OVERLAY_TESTIDS.optimizer });
    section.dataset.optimizerState = view.optimizer.state;
    section.append(el('h3', { text: OVERLAY_COPY.optimizerHeading }));
    switch (view.optimizer.state) {
      case 'idle':
        section.append(optimizeButton(true));
        break;
      case 'off':
        // VAL-OPT-001: disabled with a clear reason (the AI lane is off in Settings).
        section.append(optimizeButton(false));
        section.append(el('p', { className: 'notice', testid: OVERLAY_TESTIDS.optimizerNotice, text: OVERLAY_COPY.optimizerOff }));
        break;
      case 'no-key': {
        // VAL-OPT-001: disabled and the guidance points to Options — made actionable with the
        // same Connect Jev control the AI-judgment section uses.
        section.append(optimizeButton(false));
        section.append(
          el('p', { className: 'notice', testid: OVERLAY_TESTIDS.optimizerNotice, text: OVERLAY_COPY.optimizerNoKey }),
        );
        const connect = el('button', { testid: OVERLAY_TESTIDS.optimizerConnect, text: OVERLAY_COPY.connectJev });
        connect.addEventListener('click', () => options.openOptions());
        section.append(connect);
        break;
      }
      case 'loading':
        section.append(el('p', { className: 'pending', testid: OVERLAY_TESTIDS.optimizerPending, text: OVERLAY_COPY.optimizerPending }));
        break;
      case 'done': {
        section.append(optimizeButton(true)); // re-click serves the cached result (VAL-OPT-009)
        const list = el('ul', { testid: OVERLAY_TESTIDS.optimizerVariants });
        for (const variant of view.optimizer.optimization.variants) list.append(variantItem(variant));
        section.append(list);
        section.append(hashtagsBlock(view.optimizer.optimization));
        break;
      }
      case 'error':
        // VAL-OPT-010: explicit non-blocking error; local scoring and the composer untouched.
        section.append(
          el('p', { className: 'notice', testid: OVERLAY_TESTIDS.optimizerNotice, text: OVERLAY_COPY.optimizerError }),
        );
        section.append(el('p', { className: 'error-reason', text: view.optimizer.reason }));
        section.append(optimizeButton(true));
        break;
    }
    return section;
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

    // M5: the panel only ever renders the `analyzed` view — there is no awaiting/empty balloon
    // and no score-less panel. No qualifying draft means NOTHING is mounted at all, so the
    // composer area is left completely free (VAL-DRAFT-005/014).
    if (view.phase !== 'analyzed') return;

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
      case 'ready': {
        // VAL-SETUP-010: with autoAnalyze off, typing stayed local-only and free (zero Jev
        // requests); the network half runs ONLY when the user activates this action, exactly once
        // per activation.
        jev.append(el('p', { className: 'notice', testid: OVERLAY_TESTIDS.jevNotice, text: OVERLAY_COPY.ready }));
        const analyze = el('button', { testid: OVERLAY_TESTIDS.analyze, text: OVERLAY_COPY.analyzeButton });
        analyze.addEventListener('click', () => {
          // The manual trigger re-captures the draft synchronously. That re-capture is the
          // overlay's own doing, not a user edit, so it must NOT collapse the panel the user is
          // looking at: they asked for the verdict to appear right here (VAL-SETUP-010).
          manualCapture = true;
          options.requestAnalysis();
        });
        jev.append(analyze);
        break;
      }
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
    panel.append(optimizerSection(view));
  }

  /**
   * The COLLAPSED PILL (VAL-DRAFT-032): the headline number and NOTHING else — no label, no
   * breakdown, no notices. Its accessible name carries the full English sentence for assistive
   * tech, and the AI half-state rides a data attribute plus a dashed border so the pill never
   * grows while typing (VAL-CROSS-016 keeps the copy in the table, not here). `data-state` is
   * always 'analyzed' — a pill exists only for a qualifying draft — and the panel carries the
   * same attribute, so a consumer can read either surface's phase the same way.
   */
  function pillButton(view: Extract<OverlayView, { phase: 'analyzed' }>): HTMLElement {
    const pill = el('button', { className: 'pill', testid: OVERLAY_TESTIDS.pill, text: String(view.headline) });
    pill.dataset.state = 'analyzed';
    pill.dataset.tier = headlineTier(view.headline);
    pill.dataset.jevState = view.jev.state;
    pill.dataset.headlineSource = view.headlineSource;
    pill.setAttribute('aria-expanded', 'false');
    pill.setAttribute('aria-label', OVERLAY_COPY.pillLabel.replace('{n}', String(view.headline)));
    pill.title = OVERLAY_COPY.pillLabel.replace('{n}', String(view.headline));
    pill.addEventListener('click', () => {
      if (destroyed || capture === null) return;
      expanded = true;
      render();
    });
    return pill;
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
    // merely emptied (VAL-DRAFT-005/014 — no pill, no panel, no awaiting balloon).
    if (view.phase === 'empty') {
      if (mounted) unmountHost();
      return;
    }
    mountHost();
    const root = panelRoot();
    const host = hostElement();
    if (!root || !host) return;
    host.dataset.expanded = String(expanded);
    if (!expanded) {
      // Remember the panel's size while it was last visible so expanding never measures a
      // collapsed pill (the placement math measures the host box).
      const measured = host.getBoundingClientRect();
      if (measured.width > 0 && measured.height > 0) {
        expandedSize = { width: measured.width, height: measured.height };
      }
      root.replaceChildren(pillButton(view));
    } else {
      const panel = el('div', { className: 'panel', testid: OVERLAY_TESTIDS.panel });
      renderViewInto(panel, view);
      root.replaceChildren(panel);
    }
    reposition();
  }

  /**
   * Collapses the expanded panel back to the pill (VAL-DRAFT-035/036/037). Idempotent and
   * cheap: with nothing expanded it is a no-op, so the composer-edit lane can call it freely.
   */
  function collapse(): void {
    if (!expanded) return;
    expanded = false;
    render();
  }

  // ---- placement ----

  function panelElement(): HTMLElement | null {
    return hostElement()?.shadowRoot?.querySelector<HTMLElement>('.panel') ?? null;
  }

  function pillElement(): HTMLElement | null {
    return hostElement()?.shadowRoot?.querySelector<HTMLElement>('.pill') ?? null;
  }

  /**
   * True while X's OWN composer mention typeahead (autocomplete dropdown) is open for the
   * WATCHED composer: the user is mid-mention, so the watched composer holds focus AND at least
   * one typeahead row is rendered. Presence is the honest signal — X's React tree unmounts the
   * rows when the dropdown closes — and it is the only check that also works without a layout
   * engine (happy-dom rects are all-zero). The focus scoping keeps unrelated typeaheads (the
   * top-bar search) from ever hiding the pill.
   */
  function composerTypeaheadOpen(): boolean {
    if (composer === null) return false;
    const active = doc.activeElement;
    const composerFocused = active !== null && (active === composer || composer.contains(active));
    if (!composerFocused) return false;
    return SELECTORS.composerTypeahead.some((selector) => doc.querySelector(selector) !== null);
  }

  function reposition(): void {
    const host = hostElement();
    if (!host || !composer) return;
    // PLACEMENT anchors to the furniture-containing region (m5-overlay-scroll-reach): the real
    // site's extraction region is a tight text-row wrapper whose bottom sits ABOVE the furniture
    // row, so anchoring there covered the media controls, the counter and the Post button. The
    // climb degrades to the extraction region wherever the furniture is not found.
    const region = findComposerAnchorRegion(composer);
    // happy-dom's zero rects have no `right`; treat a missing edge as unmeasured so placement
    // falls back to the left-anchored branch.
    const regionBox =
      region instanceof Element
        ? region.getBoundingClientRect()
        : { top: 0, bottom: 0, left: 0, width: 0, height: 0, right: 0 };
    const panel = panelElement();
    // Measure the surface's NATURAL size: the state being rendered decides which cached size is
    // authoritative, and measuring a stale cap would shrink the decision input and let the cap
    // oscillate off on the next reposition (VAL-DRAFT-023).
    panel?.style.removeProperty('max-height');
    const hostBox = host.getBoundingClientRect();
    const fallbackWidth = expanded ? OVERLAY_PLACEMENT.fallbackWidth : OVERLAY_PLACEMENT.pillWidth;
    const fallbackHeight = expanded ? OVERLAY_PLACEMENT.fallbackHeight : OVERLAY_PLACEMENT.pillHeight;
    const width = hostBox.width || (expanded ? expandedSize.width : collapsedSize.width) || fallbackWidth;
    const height = hostBox.height || (expanded ? expandedSize.height : collapsedSize.height) || fallbackHeight;
    if (!expanded && hostBox.width > 0 && hostBox.height > 0) collapsedSize = { width, height };
    const placement = {
      regionRect: { top: regionBox.top, bottom: regionBox.bottom, left: regionBox.left, right: regionBox.right },
      overlaySize: { width, height },
      viewport: { width: win.innerWidth, height: win.innerHeight },
      scroll: { x: win.scrollX, y: win.scrollY },
    };
    // The COLLAPSED pill lives in the composer furniture row; the EXPANDED panel keeps the
    // below-the-region placement so it never covers the composer at all (VAL-DRAFT-033).
    const position = expanded ? computeAnchorPosition(placement) : computePillPosition(placement);
    let top = position.top;
    let left = position.left;
    if (!expanded) {
      // The real x.com furniture row puts the Post button at the region's RIGHT edge — exactly
      // where the pill's right-aligned inset lands — so when the pill's box would cover a
      // MEASURABLE Post button, it slides left of it (clearing the counter too). Where no layout
      // engine runs (happy-dom zero rects) or the button sits elsewhere, the pure math stands.
      const post = SELECTORS.composerPostButton
        .map((selector) => region.querySelector(selector))
        .find((match): match is Element => match !== null);
      const postBox = post?.getBoundingClientRect();
      const cleared = clampPillClearOfControl(
        { top, left },
        { width, height },
        postBox && postBox.width > 0 && postBox.height > 0
          ? {
              top: postBox.top + win.scrollY,
              bottom: postBox.bottom + win.scrollY,
              left: postBox.left + win.scrollX,
              right: postBox.right + win.scrollX,
            }
          : null,
        OVERLAY_PLACEMENT.pillPostClearance,
        placement.scroll.x + OVERLAY_PLACEMENT.viewportMargin,
      );
      top = cleared.top;
      left = cleared.left;
    }
    host.style.position = 'absolute';
    host.style.top = `${top}px`;
    host.style.left = `${left}px`;
    // The height cap (null = natural size): the surface scrolls internally while capped, so it
    // stays inside the viewport at short-window geometry.
    if (position.maxHeight === null) panel?.style.removeProperty('max-height');
    else panel?.style.setProperty('max-height', `${position.maxHeight}px`);
    // VAL-DRAFT-040 (the user-reported defect, reproduced live 2026-10-04): the collapsed pill
    // sits in the furniture row where X's own mention dropdown extends, and with the host's
    // top-most z-index the pill COVERED a sliver of the dropdown — hit-tested live. While X's
    // composer typeahead is open the pill therefore YIELDS (hidden entirely); it returns when
    // the dropdown closes. The expanded panel never coexists with the typeahead: the '@'
    // keystroke is a composer edit and collapses the panel first (VAL-DRAFT-036).
    const pill = pillElement();
    if (pill !== null) pill.style.visibility = !expanded && composerTypeaheadOpen() ? 'hidden' : '';
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
  // Focus changes re-evaluate the typeahead yield (its check requires the watched composer to
  // hold focus), so focus moving in or out of the composer re-runs the placement pass.
  const onFocusIn = (): void => scheduleReposition();
  doc.addEventListener('focusin', onFocusIn, true);

  /** Escape collapses the expanded panel back to the pill (VAL-DRAFT-035). */
  const onKeyDown = (event: Event): void => {
    if ((event as KeyboardEvent).key !== 'Escape') return;
    collapse();
  };
  doc.addEventListener('keydown', onKeyDown, true);

  /**
   * The ONE user-approved exception to the extension's no-pointer-capture convention, and only
   * while the panel is EXPANDED (VAL-DRAFT-037): the first click outside the panel collapses it
   * and is NOT forwarded to the page, so nothing behind it activates. The next identical click
   * finds no panel and reaches the page natively.
   *
   * Only the CLICK is captured, never the preceding pointerdown/mousedown: swallowing those would
   * also cancel the default focus behaviour, so clicking the composer to keep typing (or any
   * other focusable control) would silently do nothing. The click is where every activation
   * actually happens — link navigation, button handlers, the Post control — so stopping it there
   * is exactly "does not reach the page".
   *
   * Clicks that START inside our own shadow root (panel, its buttons, its scrolled content) are
   * never intercepted: they are the extension's own, which is why the panel re-enables pointer
   * events on itself while open. A click whose propagation a page handler already stopped never
   * reaches this listener at all, so nothing is ever double-handled.
   */
  const onOutsideClick = (event: Event): void => {
    if (destroyed || !expanded) return;
    const host = hostElement();
    if (host === null) return;
    const root = host.shadowRoot;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    // A composed click retargets to the host, so `path.includes(host)` is the normal case. The
    // shadow-root check is the fallback for events that do not cross the boundary.
    if (path.includes(host)) return;
    if (root !== null && path.some((node) => node instanceof win.Node && root.contains(node))) return;
    collapse();
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  doc.addEventListener('click', onOutsideClick, true);

  /**
   * Internal scrolling for a capped panel (VAL-DRAFT-023) without breaking the pointer
   * discipline: the host stays pointer-events:none, but while the panel is EXPANDED it takes hits,
   * so a wheel over it naturally targets the panel and never the page. This listener only has to
   * route the wheel for engines that do not resolve a pointer-events:none subtree from the hit
   * test, and never while collapsed — where every wheel must belong to the page (VAL-DRAFT-038).
   */
  const onWheel = (event: WheelEvent): void => {
    if (!expanded) return; // collapsed: the page keeps every wheel (only the pill is interactive)
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
     * Collapses the expanded panel without touching the captured draft (VAL-DRAFT-036). Called on
     * the watcher's IMMEDIATE user-edit lane, so typing collapses the panel at the keystroke
     * instead of ~700ms later when the debounced capture lands. Idempotent: a no-op when the
     * panel is already collapsed (or never opened).
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
        // The user's own Analyze action: keep the panel open and let the local half repaint.
        manualCapture = false;
      } else {
        // VAL-DRAFT-036 (the anti-occlusion guarantee): ANY other capture is a user edit, so the
        // expanded panel collapses back to the pill BEFORE the new draft paints. While typing only
        // the pill exists, which is what structurally keeps X's mention/emoji/GIF popups uncovered.
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
      doc.removeEventListener('focusin', onFocusIn, true);
      doc.removeEventListener('wheel', onWheel);
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('click', onOutsideClick, true);
      unmountHost();
      clearAnalysisState();
    },
  };
}
