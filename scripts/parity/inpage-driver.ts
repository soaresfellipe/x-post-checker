/**
 * The in-page fixture driver: ONE function, executed inside the fixture page in BOTH browsers —
 * Playwright `page.evaluate` for the Chromium leg, Marionette `WebDriver:ExecuteAsyncScript` for
 * the Firefox leg — so the two browsers run byte-identical flow logic and only the transport
 * differs. That is what makes its outcomes COMPARABLE: cross-browser fixture parity
 * (VAL-CROSS-009) is equality of the recorded outcomes.
 *
 * The driver must stay SELF-CONTAINED: no imports, no closure references — it is serialized with
 * `.toString()` and evaluated as page JavaScript. It probes the extension only through
 * page-visible DOM: the open Shadow-DOM hosts (overlay, badges, popover — all attached with
 * `mode: 'open'`), the marker's data-* diagnostics, and same-origin fetches to the fixture
 * server's Jev-mock control endpoints.
 */

export interface DriverArg {
  /** Full storage.local payload posted through the e2e seed listener before the flow runs. */
  seed: Record<string, unknown>;
  /** Per-flow draft texts (unique across flows so verdict caches never collide). */
  texts: Record<string, string>;
}

export type FlowOutcome = Record<string, unknown>;

export function fixtureDriverMain(flow: string, arg: DriverArg): Promise<FlowOutcome> {
  const TEXTS = arg.texts;
  const HOST_ID = 'amplifyx-overlay-host';
  const PANEL_TESTID = 'amplifyx-overlay';
  const MARKER_ID = 'amplifyx-marker-host';
  const BADGE_HOST_ATTR = 'data-amplifyx-host';
  const POPOVER_ID = 'amplifyx-target-popover-host';

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor<T>(probe: () => T | null | undefined | Promise<T | null | undefined>, timeoutMs: number, label: string): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // ASYNC PROBES MUST BE AWAITED: an unawaited promise is truthy and would end the wait
      // immediately (this exact bug once voided the stale-response flow's call-count waits).
      const value = await probe();
      if (value !== null && value !== undefined && value !== false) return value;
      if (Date.now() > deadline) throw new Error(`driver wait timed out: ${label}`);
      await sleep(50);
    }
  }

  const overlayPanel = (): Element | null =>
    document.getElementById(HOST_ID)?.shadowRoot?.querySelector(`[data-testid="${PANEL_TESTID}"]`) ?? null;
  const panelState = (): string | null => overlayPanel()?.getAttribute('data-state') ?? null;
  const marker = (): HTMLElement | null => document.getElementById(MARKER_ID);
  const markerAttr = (name: string): string | null => marker()?.getAttribute(name) ?? null;

  function jevSection(): Element | null {
    return overlayPanel()?.querySelector('[data-testid="overlay-jev"]') ?? null;
  }

  function panelSummary(): Record<string, unknown> {
    const panel = overlayPanel();
    if (panel === null) return { present: false };
    const gauge = panel.querySelector('[data-testid="overlay-gauge"]');
    const signals = panel.querySelectorAll('[data-testid="overlay-signals"] li').length;
    const jev = jevSection();
    return {
      present: true,
      state: panel.getAttribute('data-state'),
      headline: panel.querySelector('[data-testid="overlay-headline"]')?.textContent ?? null,
      headlineSource: gauge?.getAttribute('data-headline-source') ?? null,
      signals,
      emptyText: panel.querySelector('[data-testid="overlay-empty"]')?.textContent ?? null,
      jevState: jev?.getAttribute('data-jev-state') ?? null,
      jevNotice: jev?.querySelector('[data-testid="overlay-jev-notice"]')?.textContent ?? null,
      jevErrorReason: jev?.querySelector('.error-reason')?.textContent ?? null,
      jevPendingText: jev?.querySelector('[data-testid="overlay-jev-pending"]')?.textContent ?? null,
      jevBand: jev?.querySelector('[data-testid="overlay-jev-band"]')?.textContent ?? null,
      jevConfidence: jev?.querySelector('[data-testid="overlay-jev-confidence"]')?.textContent ?? null,
      jevWeaknesses: jev?.querySelector('[data-testid="overlay-jev-weaknesses"]')?.textContent ?? null,
      connectJev: panel.querySelector('[data-testid="overlay-connect-jev"]') !== null,
    };
  }

  function badgeSummary(): Array<Record<string, unknown>> {
    const badges: Array<Record<string, unknown>> = [];
    for (const host of document.querySelectorAll(`[${BADGE_HOST_ATTR}]`)) {
      const button = host.shadowRoot?.querySelector('[data-testid="amplifyx-target-badge"]');
      if (button === null || button === undefined) continue;
      badges.push({
        postId: button.getAttribute('data-amplifyx-post-id') ?? null,
        score: Number(button.querySelector('[data-testid="amplifyx-badge-score"]')?.textContent ?? '-1'),
        reason: button.querySelector('[data-testid="amplifyx-badge-reason"]')?.textContent ?? null,
      });
    }
    return badges.sort((a, b) => String(a['postId']).localeCompare(String(b['postId'])));
  }

  function popoverSummary(): Record<string, unknown> {
    const panel = document.getElementById(POPOVER_ID)?.shadowRoot?.querySelector('[data-testid="amplifyx-target-popover"]');
    if (panel === null || panel === undefined) return { present: false };
    const ai = panel.querySelector('[data-testid="amplifyx-popover-ai"]');
    return {
      present: true,
      localScore: panel.querySelector('[data-testid="amplifyx-popover-local-score"]')?.textContent ?? null,
      aiState: ai?.getAttribute('data-ai-state') ?? null,
      aiNotice: ai?.querySelector('[data-testid="amplifyx-popover-ai-notice"]')?.textContent ?? null,
      aiErrorReason: ai?.querySelector('[data-testid="amplifyx-popover-ai-error-reason"]')?.textContent ?? null,
    };
  }

  /** Types into a composer the way the DOM harness does (line block + bubbling input event). */
  async function typeDraft(testid: string, text: string): Promise<void> {
    const composer = await waitFor(
      () => (document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null) ?? undefined,
      10_000,
      `composer ${testid}`,
    );
    composer.focus();
    composer.replaceChildren();
    const line = document.createElement('div');
    line.textContent = text;
    composer.append(line);
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(30);
  }

  async function clearDraft(testid: string): Promise<void> {
    const composer = document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
    if (composer === null) throw new Error(`clear: composer ${testid} not found`);
    composer.focus();
    composer.replaceChildren();
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(30);
  }

  async function mockJevCalls(): Promise<number> {
    const response = await fetch('/__mock/jev/calls', { cache: 'no-store' });
    const calls = (await response.json()) as unknown[];
    return calls.length;
  }

  /** Applies a seed through the extension's typed 'seed-test-state' protocol and awaits the
   * ack. The postMessage is RETRIED until an ack arrives: the content script registers its
   * relay at document_idle, which a fresh navigation can race. Seeds are idempotent (the
   * background applies full state every time), so retries are harmless. */
  async function seed(payload: Record<string, unknown>): Promise<void> {
    const seedId = `${Date.now()}-${Math.random()}`;
    const deadline = Date.now() + 20_000;
    let ack: { ok?: boolean; error?: string } | null = null;
    const listener = (event: MessageEvent): void => {
      if (event.source !== window) return;
      const data = event.data as { type?: unknown; seedId?: unknown } | null;
      if (!data || data.type !== 'amplifyx:e2e-seed-applied' || data.seedId !== seedId) return;
      ack = data as { ok?: boolean; error?: string };
    };
    window.addEventListener('message', listener);
    try {
      for (;;) {
        window.postMessage({ type: 'amplifyx:e2e-seed', seedId, payload }, '*');
        await sleep(250);
        if (ack !== null) break;
        if (Date.now() > deadline) throw new Error('seed not acknowledged by the content script');
      }
    } finally {
      window.removeEventListener('message', listener);
    }
    if (ack['ok'] !== true) throw new Error(`seed refused: ${JSON.stringify(ack['error'])}`);
    await sleep(200); // settings/key lanes settle (broadcast -> overlay/badge refresh)
  }

  /** Reads a page-global value the fixture records (e.g. `__fixtureEpoch`). */
  function pageGlobal(name: string): unknown {
    return (window as unknown as Record<string, unknown>)[name];
  }

  const epoch = (): string => String(pageGlobal('__fixtureEpoch') ?? 'missing');

  async function run(): Promise<FlowOutcome> {
    // Every flow starts from a fully applied seed (settings + key + endpoint override).
    await seed(arg.seed);
    switch (flow) {
      case 'main-composer-detected': {
        await waitFor(() => (markerAttr('data-watcher-state') === 'watching' ? true : null), 20_000, 'watcher watching');
        await waitFor(() => (document.getElementById(HOST_ID) !== null ? true : null), 10_000, 'overlay host');
        await waitFor(() => (panelState() === 'empty' ? true : null), 10_000, 'panel empty phase');
        return {
          watcherState: markerAttr('data-watcher-state'),
          watcherComposer: markerAttr('data-watcher-composer'),
          overlay: panelSummary(),
          epoch: epoch(),
        };
      }

      case 'short-draft-empty-state': {
        await typeDraft('tweetTextarea_0', TEXTS['short']!);
        await waitFor(() => (panelState() === 'empty' ? true : null), 10_000, 'empty phase for short draft');
        return { overlay: panelSummary(), epoch: epoch() };
      }

      case 'reply-composer-detected': {
        const link = await waitFor(
          () => (document.querySelector('article a[href*="/status/"]') as HTMLAnchorElement | null) ?? undefined,
          10_000,
          'status link',
        );
        link.click();
        await waitFor(() => (markerAttr('data-watcher-composer') === 'tweetTextarea_1' ? true : null), 10_000, 'reply composer watched');
        await typeDraft('tweetTextarea_1', TEXTS['reply']!);
        await waitFor(() => (panelState() === 'analyzed' ? true : null), 15_000, 'reply draft analyzed');
        return {
          watcherComposer: markerAttr('data-watcher-composer'),
          overlay: panelSummary(),
          epoch: epoch(),
        };
      }

      case 'local-score-no-key': {
        await typeDraft('tweetTextarea_0', TEXTS['local']!);
        await waitFor(() => (panelState() === 'analyzed' ? true : null), 15_000, 'local analysis');
        return { overlay: panelSummary(), epoch: epoch() };
      }

      case 'jev-pending-success': {
        await typeDraft('tweetTextarea_0', TEXTS['pending']!);
        await waitFor(() => (panelState() === 'analyzed' ? true : null), 15_000, 'analyzed with pending AI');
        const pending = panelSummary();
        await waitFor(() => (jevSection()?.getAttribute('data-jev-state') === 'verdict' ? true : null), 15_000, 'jev verdict');
        return { pending, settled: panelSummary(), epoch: epoch() };
      }

      case 'jev-failure': {
        await typeDraft('tweetTextarea_0', TEXTS['failure']!);
        await waitFor(() => (jevSection()?.getAttribute('data-jev-state') === 'error' ? true : null), 20_000, 'jev error state');
        return { overlay: panelSummary(), epoch: epoch() };
      }

      case 'clearing': {
        await typeDraft('tweetTextarea_0', TEXTS['clear']!);
        await waitFor(() => (panelState() === 'analyzed' ? true : null), 15_000, 'draft analyzed before clearing');
        await clearDraft('tweetTextarea_0');
        await waitFor(() => (panelState() === 'empty' ? true : null), 10_000, 'panel back to empty');
        return { overlay: panelSummary(), epoch: epoch() };
      }

      case 'stale-response': {
        await fetch('/__mock/jev/reset', { method: 'POST' });
        await typeDraft('tweetTextarea_0', TEXTS['staleA']!);
        await waitFor(async () => ((await mockJevCalls()) >= 1 ? true : null), 15_000, 'first (slow) Jev call');
        // Draft B while A's slow response is still in flight.
        await typeDraft('tweetTextarea_0', TEXTS['staleB']!);
        await waitFor(async () => ((await mockJevCalls()) >= 2 ? true : null), 15_000, 'second Jev call');
        await waitFor(() => (panelState() === 'analyzed' ? true : null), 15_000, 'draft B analyzed');
        const afterB = panelSummary();
        // A's reply lands ~3s after its request; the panel must still show B's result.
        await sleep(4_000);
        const afterLateReply = panelSummary();
        return {
          afterB,
          afterLateReply,
          headlineUnchanged: afterB['headline'] === afterLateReply['headline'],
          bandUnchanged: afterB['jevBand'] === afterLateReply['jevBand'],
          mockCalls: await mockJevCalls(),
          epoch: epoch(),
        };
      }

      case 'spa-teardown-remount': {
        await typeDraft('tweetTextarea_0', TEXTS['spa']!);
        await waitFor(() => (panelState() === 'analyzed' ? true : null), 15_000, 'draft analyzed before SPA nav');
        const before = { overlayPresent: document.getElementById(HOST_ID) !== null, epoch: epoch() };
        (document.querySelector('[data-testid="navExplore"]') as HTMLElement).click();
        await waitFor(() => (document.getElementById(HOST_ID) === null ? true : null), 10_000, 'overlay torn down');
        const tornDown = { watcherState: markerAttr('data-watcher-state'), overlayGone: document.getElementById(HOST_ID) === null };
        // The explore view has no home link (like x.com's) — go BACK (popstate renders home).
        history.back();
        await waitFor(() => (document.getElementById(HOST_ID) !== null ? true : null), 10_000, 'overlay remounted');
        await waitFor(() => (panelState() === 'empty' ? true : null), 10_000, 'fresh empty panel');
        return {
          before,
          tornDown,
          remounted: { watcherState: markerAttr('data-watcher-state'), epoch: epoch(), overlay: panelSummary() },
        };
      }

      case 'both-surfaces': {
        await typeDraft('tweetTextarea_0', TEXTS['both']!);
        await waitFor(() => (panelState() === 'analyzed' ? true : null), 15_000, 'draft analyzed');
        await waitFor(() => (badgeSummary().length > 0 ? true : null), 15_000, 'badges present');
        const badges = badgeSummary();
        // Native control pass-through: clicking a like button must reach the page (the badge
        // hosts never capture pointer input), recorded by the fixture's click counter.
        const article = document.querySelector('article[data-testid="tweet"]') as HTMLElement;
        (article.querySelector('[data-testid="like"]') as HTMLElement).click();
        await waitFor(
          () => {
            const clicks = pageGlobal('__fixtureClicks') as { controls?: Record<string, number> } | null;
            return clicks?.['controls']?.['like'] !== undefined ? true : null;
          },
          10_000,
          'native like click reached the page',
        );
        // Badge click opens the popover without activating the post (badge isolation).
        const firstBadgeHost = document.querySelector(`[${BADGE_HOST_ATTR}]`) as HTMLElement;
        const badgeButton = firstBadgeHost.shadowRoot!.querySelector('[data-testid="amplifyx-target-badge"]') as HTMLElement;
        badgeButton.click();
        await waitFor(() => (popoverSummary().present ? true : null), 10_000, 'popover opened');
        const popover = popoverSummary();
        (document.getElementById(POPOVER_ID)!.shadowRoot!.querySelector('[data-testid="amplifyx-popover-close"]') as HTMLElement).click();
        await waitFor(() => (!popoverSummary().present ? true : null), 10_000, 'popover closed');
        return {
          overlay: panelSummary(),
          badges,
          likeClickReachedPage: true,
          popover,
          popoverClosed: !popoverSummary().present,
          locationStillHome: location.pathname === '/',
          epoch: epoch(),
        };
      }

      case 'outage-draft': {
        await typeDraft('tweetTextarea_0', TEXTS['outage']!);
        await waitFor(() => (panelState() === 'analyzed' ? true : null), 25_000, 'local analysis under outage');
        // The local half renders immediately; the degraded notice arrives after the (refused)
        // exchange and its retries. The flow records only the SETTLED state.
        await waitFor(() => (jevSection()?.getAttribute('data-jev-state') === 'error' ? true : null), 40_000, 'degraded notice under outage');
        return { overlay: panelSummary(), epoch: epoch() };
      }

      case 'outage-targets': {
        await waitFor(() => (badgeSummary().length > 0 ? true : null), 15_000, 'badges present under outage');
        const badges = badgeSummary();
        const firstBadgeHost = document.querySelector(`[${BADGE_HOST_ATTR}]`) as HTMLElement;
        const badgeButton = firstBadgeHost.shadowRoot!.querySelector('[data-testid="amplifyx-target-badge"]') as HTMLElement;
        badgeButton.click();
        await waitFor(() => (popoverSummary().present ? true : null), 10_000, 'popover opened');
        (document.getElementById(POPOVER_ID)!.shadowRoot!.querySelector('[data-testid="amplifyx-popover-deep-analysis"]') as HTMLElement).click();
        await waitFor(() => (popoverSummary()['aiState'] === 'error' ? true : null), 25_000, 'deep analysis failed visibly');
        const popover = popoverSummary();
        return { badges, popover, epoch: epoch() };
      }

      default:
        throw new Error(`unknown flow: ${flow}`);
    }
  }

  return run();
}
