/**
 * TargetBadges controller — renders reply-target badges into the scanner-provided per-article
 * hosts and drives the detail popover.
 *
 * Ownership rules (architecture.md): each badge lives in the article's ONE scanner host (a plain
 * div the scanner created and guarantees unique), rendered through its own Shadow DOM — the
 * React-managed article nodes are never mutated beyond that extension-owned host. The badge
 * button is the ONLY pointer-interactive element (the host stays pointer-events: none), and its
 * click is isolated: stopPropagation + preventDefault so the underlying post is never activated,
 * navigated, or acted upon (VAL-TARGET-016).
 *
 * Timeline scanning stays fully local (VAL-TARGET-019): scoring is the pure `scoreTarget` run in
 * the tab at scan time — zero network, zero messages. The ONLY path to the AI is the popover's
 * explicit "Deep analysis" action, dispatched per post through the typed background protocol and
 * cached there per post id (VAL-TARGET-017/020).
 *
 * Re-render safety (VAL-TARGET-008): the controller holds NO node references across events —
 * every ScanEvent carries the CURRENT article and host, and the paint is rebuilt from that
 * event's data alone, so a recycled host (x.com reusing an article node for another post) can
 * never show a stale badge.
 */
import { isTargetStale, scoreTarget, staleTargetScore, type TargetScore } from '@/core/heuristic-engine';
import { postMetricsSignature, type PostSnapshot } from '@/core/post-snapshot';
import type { Settings } from '@/core/settings-store';
import type { TargetAnalysisResult } from '@/core/target-analysis';
import { BADGE_HOST_ATTRIBUTE, BADGE_HOST_VALUE, type ScanEvent } from '@/dom/timeline-scanner';
import { ThemeDetector, applyThemeTokens, setHostTheme, type XTheme } from '@/dom/theme';
import { BADGE_STYLE, BADGE_TESTID, BADGE_TESTIDS } from './config';
import { createTargetPopover, type TargetPopover } from './popover';
import { badgeReason, deriveTargetAiSection, isBadgeEligible } from './view-model';

export interface TargetBadgesOptions {
  /** Defaults to the current document. */
  doc?: Document;
  /** LIVE settings (the threshold gate is re-read on every scan event). */
  getSettings: () => Settings;
  /** LIVE Jev-key PRESENCE (never the key itself — the content script must not hold it). */
  getKeyPresence: () => boolean;
  /** The typed background call for "Deep analysis" (injected; DOM tests stub it). */
  requestDeepAnalysis: (post: PostSnapshot) => Promise<TargetAnalysisResult>;
  /** Opens the extension Options page (via the background; content scripts cannot). */
  openOptions: () => void;
  /**
   * The pure in-tab scorer (timeline scanning never touches the network — VAL-TARGET-019).
   * Defaults to the real `scoreTarget`; injectable for tests. The controller MEMOIZES it per
   * post id + captured-metrics signature (VAL-TARGET-004): a post whose id and captured metrics
   * are unchanged across scans is never scored again — its ScanEvent repaints from the cache.
   */
  scoreTarget?: (post: PostSnapshot) => TargetScore;
  /**
   * The evaluation clock for the cache-hit age re-check (defaults to `Date.now`). Injectable so
   * DOM tests can walk a post across the 48h boundary deterministically.
   */
  now?: () => number;
}

/** Score-cache bound (oldest evicted beyond this), mirroring the scanner's diff-state bound. */
const MAX_CACHED_SCORES = 2000;

export interface TargetBadges {
  /** Paints (or clears) this event's host from the event's OWN data. Idempotent. */
  onScan(event: ScanEvent): void;
  /** Badge rendering + popover become live. Idempotent. */
  start(): void;
  /** Closes the popover, forgets per-post analysis state, stops painting. Host removal is the scanner's stop(). */
  stop(): void;
  /** Re-renders the OPEN popover against live settings (threshold/AI toggles never need a rescan to apply to it). */
  onSettingsChanged(): void;
  destroy(): void;
}

export function createTargetBadges(options: TargetBadgesOptions): TargetBadges {
  const doc = options.doc ?? document;
  const popover: TargetPopover = createTargetPopover(
    {
      onDeepAnalysis: (post) => void dispatchDeepAnalysis(post),
      onConnectOptions: () => options.openOptions(),
    },
    doc,
  );

  const scoreOf = options.scoreTarget ?? scoreTarget;
  /** The clock the cache-hit age re-check evaluates against (defaults to the real time). */
  const evaluateNow = options.now ?? Date.now;
  /**
   * id -> { signature, score } of the last scored capture. The rescoring policy's other half:
   * the scanner's diff decides WHICH events carry a scoring dispatch; this cache makes the
   * actual `scoreTarget` invocation follow the same rule, so 'unchanged' events (emitted on
   * every pass so rendering can re-sync) repaint from the cached score at zero scoring cost.
   * Survives stop()/start() like the scanner's diff state, so a master-switch re-enable does
   * not rescore unchanged posts.
   */
  const scoreCache = new Map<string, { signature: string; score: TargetScore }>();

  let running = false;
  // M6 theme foundation: one detector drives every badge host's `data-theme` (the token custom
  // properties on each shadow `:host` resolve from it); a live theme switch restamps all hosts.
  const themeDetector = new ThemeDetector({ doc });
  const themeRestamp = (theme: XTheme): void => {
    for (const host of doc.querySelectorAll(`[${BADGE_HOST_ATTRIBUTE}="${BADGE_HOST_VALUE}"]`)) {
      setHostTheme(host, theme);
    }
  };
  themeDetector.subscribe(themeRestamp);
  /** Per-post deep-analysis state (memory only; the authoritative cache lives in the background). */
  const pending = new Set<string>();
  const settled = new Map<string, TargetAnalysisResult>();
  /** Context behind the currently open popover, for refreshes (settings changes). */
  let open: { post: PostSnapshot; score: TargetScore; article: Element } | null = null;

  function aiSectionFor(post: PostSnapshot): ReturnType<typeof deriveTargetAiSection> {
    return deriveTargetAiSection({
      jevForTargets: options.getSettings().jevForTargets,
      keyPresent: options.getKeyPresence(),
      pending: pending.has(post.id),
      settled: settled.get(post.id) ?? null,
    });
  }

  function openPopoverFor(post: PostSnapshot, score: TargetScore, article: Element): void {
    open = { post, score, article };
    popover.open({ post, score, ai: aiSectionFor(post) }, article);
  }

  function refreshPopover(): void {
    if (!open) return;
    popover.refresh({ post: open.post, score: open.score, ai: aiSectionFor(open.post) });
  }

  async function dispatchDeepAnalysis(post: PostSnapshot): Promise<void> {
    if (!running) return;
    // VAL-TARGET-020: a settled verdict answers immediately from memory — closing and reopening
    // the popover never re-dispatches. Refusals and failures ARE remembered (so their state
    // renders after a refresh) but never short-circuit: retrying re-dispatches, and only an
    // analyzed verdict is treated as final.
    const existing = settled.get(post.id);
    if (existing?.kind === 'analyzed') {
      refreshPopover();
      return;
    }
    settled.delete(post.id);
    pending.add(post.id);
    refreshPopover();
    let result: TargetAnalysisResult;
    try {
      result = await options.requestDeepAnalysis(post);
    } catch {
      // Transport-level failure (background unreachable): a typed error the popover renders.
      result = { kind: 'error', failure: { kind: 'network', reason: 'unreachable' } };
    }
    pending.delete(post.id);
    settled.set(post.id, result);
    refreshPopover();
  }

  /**
   * The score for this post, from the cache when the id + captured-metrics signature match the
   * last scored capture (no rescore), else exactly one `scoreTarget` invocation.
   */
  function scoreFor(post: PostSnapshot): TargetScore {
    const signature = postMetricsSignature(post);
    const cached = scoreCache.get(post.id);
    if (cached && cached.signature === signature) {
      // VAL-TARGET-010 cache-hit age re-check: a memoized score is only as fresh as its CAPTURED
      // metrics — time moves independently of the signature (48h±1s both round to 2880
      // ageMinutes), so the exact 48h gate is re-evaluated from `publishedAt` against the CURRENT
      // time on EVERY hit. A post now past the window is excluded — the same typed stale
      // exclusion a fresh rescore would produce — at zero scorer cost; a still-eligible hit keeps
      // serving its cached score unchanged (docs/timeline-scanner.md sections 2 and 4).
      if (cached.score.eligible && isTargetStale(post, evaluateNow())) return staleTargetScore(post);
      return cached.score;
    }
    const score = scoreOf(post);
    scoreCache.set(post.id, { signature, score });
    const excess = scoreCache.size - MAX_CACHED_SCORES;
    if (excess > 0) {
      let dropped = 0;
      for (const key of scoreCache.keys()) {
        scoreCache.delete(key);
        if (++dropped >= excess) break;
      }
    }
    return score;
  }

  function paintBadge(event: ScanEvent, score: TargetScore): void {
    const shadow = event.host.shadowRoot ?? event.host.attachShadow({ mode: 'open' });
    // Idempotent repaint: every scan pass rebuilds the shadow content from THIS event's data, so
    // repeated passes (and recycled hosts re-rendered for a new post) can never accumulate
    // duplicate badge buttons (VAL-TARGET-008's "without duplicate hosts" contract).
    let style = shadow.querySelector('style:not([data-amplifyx-theme-tokens])');
    if (style === null) {
      style = doc.createElement('style');
      style.textContent = BADGE_STYLE;
    }
    // M6 theme tokens on the badge host's :host (idempotent shared block).
    const themeStyle = applyThemeTokens(shadow);
    setHostTheme(event.host, themeDetector.getTheme());

    const reason = badgeReason(score);
    const button = doc.createElement('button');
    button.type = 'button';
    button.dataset.testid = BADGE_TESTID;
    button.setAttribute('data-amplifyx-post-id', event.post.id);
    button.setAttribute('aria-label', `Reply target score ${score.headline}: ${reason}`);
    button.className = 'badge';
    const scoreSpan = doc.createElement('span');
    scoreSpan.dataset.testid = BADGE_TESTIDS.score;
    scoreSpan.className = 'score';
    scoreSpan.textContent = String(score.headline);
    const reasonSpan = doc.createElement('span');
    reasonSpan.dataset.testid = BADGE_TESTIDS.reason;
    reasonSpan.className = 'reason';
    reasonSpan.textContent = reason;
    button.append(scoreSpan, reasonSpan);
    shadow.replaceChildren(themeStyle, style, button);
    event.host.style.height = 'auto';
    // Click isolation (VAL-TARGET-016): the badge consumes its own activation so the underlying
    // post's handlers, navigation, and controls never see it. The popover still opens.
    button.addEventListener('click', (domEvent) => {
      domEvent.stopPropagation();
      domEvent.preventDefault();
      openPopoverFor(event.post, score, event.article);
    });
  }

  function clearHost(event: ScanEvent): void {
    const shadow = event.host.shadowRoot;
    if (shadow) shadow.replaceChildren();
    event.host.style.height = '0';
  }

  return {
    onScan(event) {
      if (!running) return;
      const threshold = options.getSettings().targetThreshold;
      const score = scoreFor(event.post); // memoized: unchanged posts cost zero scoreTarget calls
      if (isBadgeEligible(score, threshold)) paintBadge(event, score);
      else clearHost(event);
    },
    start() {
      running = true;
    },
    stop() {
      running = false;
      open = null;
      popover.destroy();
      pending.clear();
      settled.clear();
    },
    onSettingsChanged() {
      if (!running || !open) return;
      refreshPopover();
    },
    destroy() {
      this.stop();
      themeDetector.destroy();
    },
  };
}
