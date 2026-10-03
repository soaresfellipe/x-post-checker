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
import { scoreTarget, type TargetScore } from '@/core/heuristic-engine';
import type { PostSnapshot } from '@/core/post-snapshot';
import type { Settings } from '@/core/settings-store';
import type { TargetAnalysisResult } from '@/core/target-analysis';
import type { ScanEvent } from '@/dom/timeline-scanner';
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
}

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

  let running = false;
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

  function paintBadge(event: ScanEvent, score: TargetScore): void {
    const shadow = event.host.shadowRoot ?? event.host.attachShadow({ mode: 'open' });
    if (shadow.querySelector('style') === null) {
      const style = doc.createElement('style');
      style.textContent = BADGE_STYLE;
      shadow.append(style);
    }
    event.host.style.height = 'auto';

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
    // Click isolation (VAL-TARGET-016): the badge consumes its own activation so the underlying
    // post's handlers, navigation, and controls never see it. The popover still opens.
    button.addEventListener('click', (domEvent) => {
      domEvent.stopPropagation();
      domEvent.preventDefault();
      openPopoverFor(event.post, score, event.article);
    });
    shadow.append(button);
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
      const score = scoreTarget(event.post); // pure, in-tab: timeline scanning never touches the network
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
    },
  };
}
