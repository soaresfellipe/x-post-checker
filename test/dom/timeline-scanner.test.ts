import { beforeEach, describe, expect, it } from 'vitest';
import { MARKER_HOST_ID } from '../../src/dom/marker';
import { BADGE_HOST_ATTRIBUTE, createTimelineScanner, type TimelineScanner } from '../../src/dom/timeline-scanner/scanner';
import type { ScanEvent, TimelineScannerOptions } from '../../src/dom/timeline-scanner/types';
import { FIXTURE_POSTS, renderFixtureHtml, renderPost, type FixturePost } from '../fixtures/x-fixture';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const THROTTLE_MS = 25;
const waitThrottle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, THROTTLE_MS * 3));

/** A post the timeline has never rendered (the recycling feed's "next" post). */
const RECYCLED_POST: FixturePost = {
  id: '1900000000000000099',
  handle: 'recycled_author',
  displayName: 'Recycled Author',
  text: 'This article node was recycled for a different post id.',
  ageMinutes: 40,
  timeLabel: '40 min',
  replies: 5,
  reposts: 7,
  likes: 90,
};

interface Harness {
  scanner: TimelineScanner;
  dispatches: ScanEvent[];
  events: ScanEvent[];
  articles: () => HTMLElement[];
  hostOf: (article: Element) => HTMLElement | null;
  dispatchesFor: (id: string) => ScanEvent[];
  setVisible: (ids: string[]) => void;
}

/**
 * Mounts the full fixture page and a scanner over it. Visibility defaults to ALL articles (they
 * stack vertically; real viewport visibility is covered by E2E) — tests narrow it via
 * `setVisible`.
 */
function startHarness(
  visibleIds: string[] | null = null,
  extra: Partial<TimelineScannerOptions> = {},
): Harness {
  document.body.innerHTML = renderFixtureHtml(NOW);
  const marker = document.createElement('div');
  marker.id = MARKER_HOST_ID;
  document.body.append(marker);

  const visible = new Set(visibleIds ?? []);
  let allVisible = visibleIds === null;
  const dispatches: ScanEvent[] = [];
  const events: ScanEvent[] = [];
  const idOf = (article: Element): string =>
    /(\d+)\/?$/.exec(article.querySelector('a[href*="/status/"]')!.getAttribute('href')!)![0];

  const scanner = createTimelineScanner({
    doc: document,
    throttleMs: THROTTLE_MS,
    now: () => NOW,
    isArticleVisible: (article) => allVisible || visible.has(idOf(article)),
    dispatchScoring: (event) => dispatches.push(event),
    ...extra,
  });
  scanner.onScan((event) => events.push(event));
  scanner.start();

  return {
    scanner,
    dispatches,
    events,
    articles: () => [...document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]')],
    hostOf: (article) => article.querySelector(`[${BADGE_HOST_ATTRIBUTE}="badge"]`),
    dispatchesFor: (id) => dispatches.filter((d) => d.post.id === id),
    setVisible: (ids) => {
      allVisible = false;
      visible.clear();
      for (const id of ids) visible.add(id);
    },
  };
}
describe('timeline scanner rescoring policy (VAL-TARGET-004)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('scores every visible post exactly once on the initial scan', () => {
    const h = startHarness();
    expect(h.dispatches).toHaveLength(FIXTURE_POSTS.length);
    expect(new Set(h.dispatches.map((d) => d.post.id)).size).toBe(FIXTURE_POSTS.length);
    // The dispatch's article is the CURRENT node (fresh per scan, never cached).
    expect(h.dispatches.every((d) => idOfPost(d.article) === d.post.id)).toBe(true);
    expect(h.dispatches.every((d) => d.reason === 'new')).toBe(true);
  });

  it('does not rescore unchanged posts on repeated scans, and never duplicates badge hosts', () => {
    const h = startHarness();
    const afterFirst = h.dispatches.length;

    h.scanner.rescan();
    h.scanner.rescan();
    expect(h.dispatches).toHaveLength(afterFirst); // same id + unchanged metrics → no rescore

    // At most ONE badge host per article, however many scans pass.
    for (const article of h.articles()) {
      expect(article.querySelectorAll(`[${BADGE_HOST_ATTRIBUTE}="badge"]`)).toHaveLength(1);
    }
  });

  it('rescores once when a captured metric changes, with the new metrics on the dispatch', () => {
    const h = startHarness();
    const firstId = FIXTURE_POSTS[0]!.id;
    expect(h.dispatchesFor(firstId)).toHaveLength(1);

    // The post's visible like count rises: 310 -> 311 (digits in the count span + label).
    const article = h.articles()[0]!;
    article.querySelector('[data-testid="like"] [data-testid="app-text-transition-container"] span')!.textContent = '311';
    article.querySelector('[data-testid="like"]')!.setAttribute('aria-label', '311 Curtidas. Curtir');

    h.scanner.rescan();
    const rescored = h.dispatchesFor(firstId);
    expect(rescored).toHaveLength(2); // changed metrics → exactly one rescore
    expect(rescored[1]!.reason).toBe('changed');
    expect(rescored[1]!.post.likeCount).toBe(311);

    // And the unchanged rescans that follow stay quiet.
    h.scanner.rescan();
    expect(h.dispatchesFor(firstId)).toHaveLength(2);
  });

  it('scores a newly encountered post id once and reports it as new', () => {
    const h = startHarness();
    const count = h.dispatches.length;

    // A brand-new post appears in the timeline (rendered between existing posts).
    const timeline = document.querySelector('[aria-label="Timeline: Sua Página Inicial"]')!;
    timeline.firstElementChild!.insertAdjacentHTML('beforebegin', renderPost(RECYCLED_POST, NOW));
    h.scanner.rescan();

    expect(h.dispatches).toHaveLength(count + 1);
    const added = h.dispatches.at(-1)!;
    expect(added.post.id).toBe(RECYCLED_POST.id);
    expect(added.reason).toBe('new');
    h.scanner.rescan();
    expect(h.dispatches).toHaveLength(count + 1); // scored once
  });

  it('re-diffs a recycled article node whose content was wiped (fresh host, one dispatch)', () => {
    const h = startHarness();
    const recycled = h.articles()[0]!;
    const oldId = idOfPost(recycled);

    // Virtualized-feed recycling, variant A: the feed re-renders the node's content and the
    // extension's host (a foreign trailing child) is destroyed with it.
    const freshRoot = document.createElement('div');
    freshRoot.innerHTML = renderPost(RECYCLED_POST, NOW);
    recycled.innerHTML = freshRoot.querySelector('article')!.innerHTML;
    h.scanner.rescan();

    const eventsFor = h.dispatchesFor(RECYCLED_POST.id);
    expect(eventsFor).toHaveLength(1); // exactly one dispatch for the new id
    expect(eventsFor[0]!.reason).toBe('new');
    expect(eventsFor[0]!.article).toBe(recycled); // the CURRENT node, not a cached reference
    expect(h.dispatchesFor(oldId)).toHaveLength(1); // the old id was dispatched only at first sight
    expect(recycled.querySelectorAll(`[${BADGE_HOST_ATTRIBUTE}="badge"]`)).toHaveLength(1);
  });

  it('re-diffs a recycled article node that kept its badge host (host reused, never duplicated)', () => {
    const h = startHarness();
    const recycled = h.articles()[0]!;
    const hostBefore = h.hostOf(recycled)!;

    // Virtualized-feed recycling, variant B: the feed updates the node in place and the foreign
    // trailing host SURVIVES (React removes only the children it manages).
    const freshRoot = document.createElement('div');
    freshRoot.innerHTML = renderPost(RECYCLED_POST, NOW);
    const freshArticle = freshRoot.querySelector('article')!;
    for (const child of [...recycled.childNodes]) if (child !== hostBefore) child.remove();
    for (const child of [...freshArticle.childNodes]) recycled.appendChild(child);
    h.scanner.rescan();

    const eventsFor = h.dispatchesFor(RECYCLED_POST.id);
    expect(eventsFor).toHaveLength(1); // exactly one dispatch for the new id
    expect(eventsFor[0]!.reason).toBe('new');
    expect(h.hostOf(recycled)).toBe(hostBefore); // the surviving host was REUSED, not duplicated
    expect(recycled.querySelectorAll(`[${BADGE_HOST_ATTRIBUTE}="badge"]`)).toHaveLength(1);
  });

  it('does not scan off-screen posts until they become visible', () => {
    const visibleIds = [FIXTURE_POSTS[0]!.id, FIXTURE_POSTS[1]!.id];
    const h = startHarness(visibleIds);
    expect(h.dispatches.map((d) => d.post.id).sort()).toEqual(visibleIds.slice().sort()); // off-screen: never extracted
    expect(h.articles().length).toBeGreaterThan(visibleIds.length); // they ARE in the DOM, just off-screen
    expect(h.articles().length).toBeGreaterThan(visibleIds.length); // they ARE in the DOM, just off-screen

    // One becoming visible is scanned (and dispatched for) exactly then: the fixture keeps the
    // page's own scroll mechanics; here the visibility flip IS the scroll for the injected check.
    h.setVisible(FIXTURE_POSTS.slice(0, 3).map((post) => post.id));
    h.scanner.rescan();
    const added = h.dispatchesFor(FIXTURE_POSTS[2]!.id);
    expect(added).toHaveLength(1);
    expect(added[0]!.reason).toBe('new');
  });

  it('throttles burst triggers: ten scroll signals yield at most a leading and a trailing pass', async () => {
    const h = startHarness();
    const before = scans();
    for (let i = 0; i < 10; i += 1) window.dispatchEvent(new Event('scroll'));
    await waitThrottle();
    expect(scans()).toBeGreaterThan(before);
    expect(scans() - before).toBeLessThanOrEqual(2);
    expect(h.dispatches).toHaveLength(FIXTURE_POSTS.length); // nothing changed → no new dispatches
  });

  it('scans once for burst DOM mutations, dispatching each new id exactly once', async () => {
    const h = startHarness();
    const timeline = document.querySelector('[aria-label="Timeline: Sua Página Inicial"]')!;
    timeline.firstElementChild!.insertAdjacentHTML('beforebegin', renderPost(RECYCLED_POST, NOW));
    timeline.firstElementChild!.insertAdjacentHTML(
      'beforebegin',
      renderPost({ ...RECYCLED_POST, id: '1900000000000000100', handle: 'second_new' }, NOW),
    );

    await waitThrottle(); // the throttled scan covers both mutations (plus the host-append settle pass)
    expect(h.dispatchesFor('1900000000000000099')).toHaveLength(1);
    expect(h.dispatchesFor('1900000000000000100')).toHaveLength(1);
  });

  it('stamps scanner diagnostics (state, scan count, last scan, visible posts) onto the marker host', () => {
    startHarness();
    expect(marker().dataset.scannerState).toBe('scanning');
    expect(marker().dataset.scannerLastScan).toMatch(/^\d+$/);
    expect(Number(marker().dataset.scannerScanCount)).toBeGreaterThanOrEqual(1);
    const posts = JSON.parse(marker().dataset.scannerPosts!) as Array<{
      id: string;
      replyCount: number | null;
      repostCount: number | null;
      likeCount: number | null;
    }>;
    expect(posts).toHaveLength(FIXTURE_POSTS.length);
    expect(posts[0]).toEqual({ id: FIXTURE_POSTS[0]!.id, replyCount: 45, repostCount: 12, likeCount: 310 });
  });

  it('stop() tears everything down: hosts removed, diagnostics idle, zero activity afterwards', () => {
    const h = startHarness();
    h.scanner.stop();
    expect(document.querySelectorAll(`[${BADGE_HOST_ATTRIBUTE}="badge"]`)).toHaveLength(0);
    expect(marker().dataset.scannerState).toBe('idle');
    expect(JSON.parse(marker().dataset.scannerPosts!)).toEqual([]);

    const count = h.dispatches.length;
    h.scanner.rescan();
    expect(h.dispatches).toHaveLength(count); // stopped: no scans, no dispatches
  });
});

function marker(): HTMLElement {
  return document.getElementById(MARKER_HOST_ID)!;
}

function scans(): number {
  return Number(marker().dataset.scannerScanCount);
}

function idOfPost(article: Element): string {
  return /(\d+)\/?$/.exec(article.querySelector('a[href*="/status/"]')!.getAttribute('href')!)![0];
}
