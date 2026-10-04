/**
 * Mock of the logged-in x.com home page. Mirrors the data-testid structure observed on the real
 * site (2026-10) including its LOCALIZED (pt-BR) aria-labels and visible count text, so DOM tests
 * and E2E exercise the same extraction paths as production.
 */

export interface FixturePost {
  id: string;
  handle: string;
  displayName: string;
  verified?: boolean;
  text: string;
  ageMinutes: number;
  timeLabel: string;
  replies: number;
  reposts: number;
  likes: number;
  photo?: boolean;
  replyingTo?: string;
  /** Viewer follows this author: renders the follow-state badge in the reply composer view. */
  followsViewer?: boolean;
  /**
   * Reply-composer follow-badge variant (scrutiny round 1, m2-composer-watcher): 'visible' renders
   * the badge beside the reply-to line, 'hidden' renders it display:none, 'unrelated' renders it
   * nested away from the reply-to line (present in the region, not bound to the reply target).
   */
  followBadge?: 'visible' | 'hidden' | 'unrelated';
}

export const FIXTURE_POSTS: readonly FixturePost[] = [
  { id: '1800000000000000001', handle: 'ana_builds', displayName: 'Ana Builds', verified: true, text: 'What is the one tool you stopped using this year, and why?', ageMinutes: 120, timeLabel: '2 h', replies: 45, reposts: 12, likes: 310, followsViewer: true },
  { id: '1800000000000000002', handle: 'joaodev', displayName: 'João Dev', text: 'Shipped the new onboarding flow today. Feels good.', ageMinutes: 30, timeLabel: '30 min', replies: 2, reposts: 0, likes: 14 },
  { id: '1800000000000000003', handle: 'marina_design', displayName: 'Marina Design', text: 'Redesigned our pricing page. Before and after below.', ageMinutes: 300, timeLabel: '5 h', replies: 88, reposts: 140, likes: 1200, photo: true },
  { id: '1800000000000000004', handle: 'old_timer', displayName: 'Old Timer', text: 'A take from a few days ago that nobody replied to.', ageMinutes: 3600, timeLabel: '28 de set.', replies: 1, reposts: 0, likes: 3 },
  { id: '1800000000000000005', handle: 'carla_ml', displayName: 'Carla ML', text: 'Agreed, benchmarks without the baseline are meaningless.', ageMinutes: 180, timeLabel: '3 h', replies: 6, reposts: 1, likes: 52, replyingTo: 'ana_builds' },
  { id: '1800000000000000006', handle: 'tech_weekly', displayName: 'Tech Weekly', verified: true, text: '5 lessons from scaling to 1M users:\n1. Measure first\n2. Cache everything\n3. Delete code\n4. Hire slowly\n5. Write it down', ageMinutes: 240, timeLabel: '4 h', replies: 210, reposts: 980, likes: 5400 },
  { id: '1800000000000000007', handle: 'newbie_01', displayName: 'Newbie', text: 'First post here, hello everyone!', ageMinutes: 10, timeLabel: '10 min', replies: 0, reposts: 0, likes: 0 },
  { id: '1800000000000000008', handle: 'pedro_pm', displayName: 'Pedro PM', text: 'Hot take: roadmaps are fiction. Do you agree?', ageMinutes: 60, timeLabel: '1 h', replies: 130, reposts: 8, likes: 240 },
  { id: '1800000000000000009', handle: 'growth_guru', displayName: 'Growth Guru', text: 'Like and retweet if you want to win! Follow for follow!', ageMinutes: 90, timeLabel: '1 h', replies: 3, reposts: 400, likes: 800 },
  { id: '1800000000000000010', handle: 'lia_writes', displayName: 'Lia Writes', text: 'A long thought about why the best creators treat every post as a small experiment: they write the hook last, they cut the first paragraph, and they reread the draft out loud before hitting send.', ageMinutes: 420, timeLabel: '7 h', replies: 19, reposts: 4, likes: 97 },
  // Scrutiny round-1 variants: reply composers whose follow-state proof is hidden or unrelated
  // (appended last so the first timeline status link stays ana_builds, the visible-badge post).
  { id: '1800000000000000011', handle: 'badge_hidden', displayName: 'Badge Hidden', text: 'My reply view keeps a follow badge that the page hides.', ageMinutes: 75, timeLabel: '1 h', replies: 4, reposts: 2, likes: 21, followBadge: 'hidden' },
  { id: '1800000000000000012', handle: 'badge_elsewhere', displayName: 'Badge Elsewhere', text: 'My reply view shows a social badge that is not about me.', ageMinutes: 85, timeLabel: '1 h', replies: 5, reposts: 3, likes: 24, followBadge: 'unrelated' },
];

/**
 * Posts revealed ONLY by scrolling the home timeline: the fixture recycles its article nodes to
 * show them (the virtualized-feed behavior — VAL-TARGET-001 off-screen, VAL-TARGET-002 recycle).
 * id '15' doubles as a search-timeline post ("tool").
 */
export const EXTENDED_POSTS: readonly FixturePost[] = [
  { id: '1800000000000000013', handle: 'rafa_ops', displayName: 'Rafa Ops', text: 'Migrated our CI to remote runners and cut build times in half.', ageMinutes: 45, timeLabel: '45 min', replies: 9, reposts: 6, likes: 140 },
  { id: '1800000000000000014', handle: 'sofia_data', displayName: 'Sofia Data', verified: true, text: 'Hot take: dashboards are where insight goes to die.', ageMinutes: 200, timeLabel: '3 h', replies: 33, reposts: 11, likes: 260 },
  { id: '1800000000000000015', handle: 'lucas_sec', displayName: 'Lucas Sec', text: 'What is your favorite tool for dependency auditing these days?', ageMinutes: 15, timeLabel: '15 min', replies: 21, reposts: 3, likes: 66 },
];

/** Posts reachable only from the profile and search timelines (SPA routes — VAL-TARGET-003). */
export const EXTRA_POSTS: readonly FixturePost[] = [
  { id: '1800000000000000016', handle: 'ana_builds', displayName: 'Ana Builds', verified: true, text: 'Weekend build: a tiny CLI that turns TODOs into issues.', ageMinutes: 90, timeLabel: '1 h', replies: 12, reposts: 5, likes: 180, followsViewer: true },
  { id: '1800000000000000017', handle: 'ana_builds', displayName: 'Ana Builds', verified: true, text: 'Shipping beats perfect. Every time.', ageMinutes: 1440, timeLabel: '1 dia', replies: 7, reposts: 9, likes: 240, followsViewer: true },
  { id: '1800000000000000018', handle: 'tool_finder', displayName: 'Tool Finder', text: 'Compiled a list of the best tools for small teams this year.', ageMinutes: 120, timeLabel: '2 h', replies: 18, reposts: 22, likes: 310 },
];

/** Every post the fixture can render, on any route. */
export const ALL_POSTS: readonly FixturePost[] = [...FIXTURE_POSTS, ...EXTENDED_POSTS, ...EXTRA_POSTS];

/** The home timeline's Following tab: in-network posts, two of them shared with the scroll set. */
export const FOLLOWING_IDS: readonly string[] = [
  '1800000000000000002',
  '1800000000000000006',
  '1800000000000000008',
  '1800000000000000013',
  '1800000000000000014',
];

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** pt-BR style compact count, e.g. 1200 -> "1,2 mil". Zero renders as an empty label like on x.com. */
export function formatCount(count: number): string {
  if (count === 0) return '';
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace('.', ',').replace(',0', '')} mil`;
  return String(count);
}

function actionButton(testid: string, count: number, noun: string, verb: string): string {
  const label = count > 0 ? `${formatCount(count)} ${noun}. ${verb}` : verb;
  const countHtml = count > 0 ? `<span data-testid="app-text-transition-container"><span>${formatCount(count)}</span></span>` : '';
  return `<button role="button" type="button" data-testid="${testid}" aria-label="${escapeHtml(label)}"><div dir="ltr"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M0 0h24v24H0z" fill="none"/></svg>${countHtml}</div></button>`;
}

function renderPost(post: FixturePost, now: number): string {
  const datetime = new Date(now - post.ageMinutes * 60_000).toISOString();
  const verified = post.verified
    ? '<svg viewBox="0 0 22 22" width="18" height="18" aria-label="Conta verificada" role="img" data-testid="icon-verified"><path d="M0 0h22v22H0z" fill="none"/></svg>'
    : '';
  // The article-level viewer-follows-author marker (the inNetwork extraction contract): rendered
  // ONLY for authors the viewer follows. Real x.com exposes no such marker in timeline articles
  // (library/x-dom.md, verified absence) — this fixture shape is what exercises the extraction.
  const followsMarker = post.followsViewer
    ? '<span data-testid="viewerFollowsAuthor">Seguindo</span>'
    : '';
  const replyingTo = post.replyingTo
    ? `<div dir="ltr"><span>Respondendo a </span><a href="/${post.replyingTo}" role="link">@${post.replyingTo}</a></div>`
    : '';
  const photo = post.photo
    ? `<div data-testid="tweetPhoto"><img alt="Imagem" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" width="64" height="64"/></div>`
    : '';
  const body = escapeHtml(post.text).replace(/\n/g, '<br/>');

  return `<div data-testid="cellInnerDiv"><div data-testid="placementTracking"><article data-testid="tweet" role="article" tabindex="0">
  <div data-testid="Tweet-User-Avatar"><a href="/${post.handle}" role="link"><img alt="" width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="/></a></div>
  <div data-testid="User-Name">
    <a href="/${post.handle}" role="link"><span>${escapeHtml(post.displayName)}</span>${verified}</a>
    <a href="/${post.handle}" role="link"><span>@${post.handle}</span></a>
    <a href="/${post.handle}/status/${post.id}" role="link"><time datetime="${datetime}">${escapeHtml(post.timeLabel)}</time></a>
  </div>
  <button data-testid="caret" type="button" aria-label="Mais"></button>
  ${followsMarker}
  ${replyingTo}
  <div data-testid="tweetText" lang="en" dir="auto"><span>${body}</span></div>
  ${photo}
  <div role="group" aria-label="${post.replies} respostas, ${post.reposts} reposts, ${post.likes} curtidas">
    ${actionButton('reply', post.replies, 'Respostas', 'Responder')}
    ${actionButton('retweet', post.reposts, 'reposts', 'Repostar')}
    ${actionButton('like', post.likes, 'Curtidas', 'Curtir')}
    ${actionButton('bookmark', 0, '', 'Salvar')}
  </div>
</article></div></div>`;
}

export { renderPost };

/**
 * A composer-LESS route view (like x.com's Explore): an unrelated DraftEditor search box with no
 * `tweetTextarea` testid and NO recognized composer container around it (`RichTextInputContainer`
 * /`toolBar`). The structural composer fallback must not match here, the watcher must attach
 * nothing, and the overlay must stay unmounted (VAL-DRAFT-029, scrutiny round 1).
 */
export function renderExploreViewHtml(): string {
  return (
    '<div data-testid="exploreView">' +
    '<h2>Explorar</h2>' +
    '<div class="DraftEditor-root">' +
    '<div class="public-DraftEditor-content" role="textbox" contenteditable="true" aria-label="Buscar" spellcheck="true"></div>' +
    '</div>' +
    '</div>'
  );
}

export function renderFixtureHtml(now: number = Date.now()): string {
  return `<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8"/>
<title>Página Inicial / X</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #fff; color: #0f1419; }
  main { max-width: 600px; margin: 0 auto; }
  article { border-bottom: 1px solid #eff3f4; padding: 12px 16px; }
  /* Out of flow like x.com's fixed sidebar: route navigation must not shift the composer/timeline
     layout (overlay placement math depends on it). */
  [data-testid="sidebarNav"] { position: fixed; top: 6px; left: 8px; z-index: 20; }
  [contenteditable] { min-height: 48px; border: 1px solid #cfd9de; padding: 8px; }
  button { background: none; border: 0; cursor: pointer; }
  [role="tab"] { display: inline-block; padding: 8px 16px; cursor: pointer; color: #536471; }
  [role="tab"][aria-selected="true"] { color: #0f1419; font-weight: 700; border-bottom: 2px solid #1d9bf0; }
</style>
</head>
<body>
<div id="react-root">
<nav data-testid="sidebarNav">
  <a href="/explore" role="link" data-testid="navExplore"><span>Explorar</span></a>
  <a href="/ana_builds" role="link" data-testid="navProfile"><span>Perfil</span></a>
  <a href="/search?q=tool" role="link" data-testid="navSearch"><span>Buscar</span></a>
</nav>
<main role="main">
  <div data-testid="primaryColumn">
    <!-- REAL x.com home-composer nesting (verified live 2026-10-04, m5-overlay-scroll-reach
         survey): the editor's RichTextInputContainer's PARENT is a tight text-row wrapper, and
         the furniture row ("toolBar": media, counter, Post) is a SIBLING subtree of the common
         composer block - NOT an ancestor of the editor. Anchoring overlay placement to the tight
         wrapper covered the furniture row on the real site; the overlay's PLACEMENT anchor must
         climb to the furniture-containing block (findComposerAnchorRegion), while EXTRACTION
         keeps the tight region. -->
    <div>
      <div>
        <div data-testid="tweetTextarea_0RichTextInputContainer">
          <div class="DraftEditor-root">
            <div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" aria-label="Texto do post" aria-multiline="true" spellcheck="true" class="notranslate public-DraftEditor-content"></div>
          </div>
          <label data-testid="tweetTextarea_0_label">O que está acontecendo?</label>
        </div>
      </div>
      <div data-testid="toolBar" style="padding: 12px 8px;">
        <!-- The composer furniture row, left to right: media control, character counter, Post
             button (x.com's real order; the real counter exposes no stable data-testid, so the
             fixture names it explicitly for the pill-placement geometry assertions). The padding
             mirrors the real row's 48px band (measured live 2026-10-04): the collapsed pill sits
             inside that band, so the row must be tall enough to hold it. -->
        <button type="button" data-testid="addMedia" aria-label="Adicionar midia"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M0 0h24v24H0z" fill="none"/></svg></button>
        <span data-testid="charCounter">0</span>
        <button type="button" data-testid="tweetButtonInline" aria-disabled="true">Postar</button>
      </div>
    </div>
    <div role="tablist" data-testid="homeTabs">
      <div role="tab" data-testid="tabForYou" aria-selected="true"><span>Para voce</span></div>
      <div role="tab" data-testid="tabFollowing" aria-selected="false"><span>Seguindo</span></div>
    </div>
    <div data-testid="primaryTimeline" aria-label="Timeline: Sua Página Inicial">
${FIXTURE_POSTS.map((post) => renderPost(post, now)).join('\n')}
    </div>
  </div>
</main>
</div>
<script>
(function () {
  'use strict';
  // Per-DOCUMENT-LOAD stamp: pushState navigation keeps this value, a reload replaces it —
  // E2E asserts SPA navigation ran without a reload by comparing epochs.
  window.__fixtureEpoch = Math.random();
  // E2E activation counters (VAL-TARGET-007/016): a BUBBLE-phase document listener records every
  // click that reaches the page — a badge (or any extension surface) that stops propagation is
  // invisible here, which is exactly what the tests assert. Native controls additionally mark
  // themselves, so the "fixture handler ran" evidence is per-control and per-article.
  window.__fixtureClicks = { articles: {}, controls: {} };
  document.addEventListener('click', function (event) {
    var target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    var article = target.closest('article[data-testid="tweet"]');
    if (article) {
      var link = article.querySelector('a[href*="/status/"]');
      var match = link ? /\\/status\\/(\\d+)/.exec(link.getAttribute('href') || '') : null;
      if (match) window.__fixtureClicks.articles[match[1]] = (window.__fixtureClicks.articles[match[1]] || 0) + 1;
    }
    var control = target.closest('[data-testid="reply"],[data-testid="retweet"],[data-testid="like"],[data-testid="bookmark"]');
    if (control) {
      var key = control.getAttribute('data-testid');
      window.__fixtureClicks.controls[key] = (window.__fixtureClicks.controls[key] || 0) + 1;
      control.setAttribute('data-fixture-activated', 'true');
    }
  }, false);
  // E2E re-render hook (VAL-TARGET-008): re-render one article's subtree from its canonical
  // markup while preserving its status URL — the badge host dies with the subtree and the
  // scanner's next pass must restore exactly one badge.
  window.__fixtureReplaceArticleInner = function (id) {
    var articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (var i = 0; i < articles.length; i++) {
      var link = articles[i].querySelector('a[href*="/status/' + id + '"]');
      if (link && ARTICLE_INNER_HTML[id]) {
        articles[i].innerHTML = ARTICLE_INNER_HTML[id];
        return true;
      }
    }
    return false;
  };

  var primary = document.querySelector('[data-testid="primaryColumn"]');
  if (!primary) return;
  var homeHtml = primary.innerHTML;
  var POSTS_BY_ID = ${JSON.stringify(
    Object.fromEntries(
      ALL_POSTS.map((post) => [
        post.id,
        {
          handle: post.handle,
          text: post.text,
          followBadge: post.followBadge ?? (post.followsViewer === true ? 'visible' : null),
        },
      ]),
    ),
  )};
  var ALL_IDS = ${JSON.stringify(ALL_POSTS.map((post) => post.id))};
  // Full cell (cellInnerDiv wrapper) and bare article-inner markup by status id: the first renders
  // timelines from data, the second is the recycling payload (the SAME article node re-rendered
  // for a different post — VAL-TARGET-002).
  var CELL_HTML = ${JSON.stringify(
    Object.fromEntries(ALL_POSTS.map((post) => [post.id, renderPost(post, now)])),
  )};
  var ARTICLE_INNER_HTML = ${JSON.stringify(
    Object.fromEntries(
      ALL_POSTS.map((post) => {
        // String surgery (no DOM here — the fixture server renders this in Node): the markup
        // between <article ...> and </article> of the canonical render.
        const cell = renderPost(post, now);
        const openTagEnd = cell.indexOf('>', cell.indexOf('<article')) + 1;
        return [post.id, cell.slice(openTagEnd, cell.lastIndexOf('</article>'))];
      }),
    ),
  )};
  var FOLLOWING_IDS = ${JSON.stringify(FOLLOWING_IDS)};
  var EXTENDED_IDS = ${JSON.stringify(EXTENDED_POSTS.map((post) => post.id))};
  var extendedNext = 0;
  var currentTab = 'foryou';

  function statusId(path) {
    var match = /\\/status\\/(\\d+)/.exec(path);
    return match ? match[1] : null;
  }

  function searchQuery(path) {
    var match = /\\/search\\/?\\?q=([^&]+)/.exec(path);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function isKnownHandle(path) {
    var match = /^\\/([A-Za-z0-9_]{1,20})\\/?$/.exec(path);
    return match && POSTS_BY_ID[ALL_IDS.find(function (id) { return POSTS_BY_ID[id].handle === match[1]; })] ? match[1] : null;
  }

  function cellOf(id) { return CELL_HTML[id] || ''; }

  function setTab(tab) {
    currentTab = tab;
    var forYou = primary.querySelector('[data-testid="tabForYou"]');
    var following = primary.querySelector('[data-testid="tabFollowing"]');
    if (forYou) forYou.setAttribute('aria-selected', tab === 'foryou' ? 'true' : 'false');
    if (following) following.setAttribute('aria-selected', tab === 'following' ? 'true' : 'false');
  }

  function renderTimelineIds(ids) {
    var timeline = primary.querySelector('[data-testid="primaryTimeline"]');
    if (timeline) timeline.innerHTML = ids.map(cellOf).join('');
    extendedNext = 0;
  }

  // For You: restore the captured home chrome (composer + tabs + timeline); Following: same
  // chrome, the Following timeline rendered in place (like x.com's tab — no route change).
  function renderHome(tab) {
    primary.innerHTML = homeHtml;
    setTab(tab);
    if (tab === 'following') renderTimelineIds(FOLLOWING_IDS);
  }

  /**
   * The reply-DIALOG view (tweetTextarea_1 + visible reply chip): what a status-link CLICK opens
   * (kept from M2). Popstate/back lands on the REAL status-page shape instead (below).
   */
  function renderReplyView(id) {
    var post = POSTS_BY_ID[id];
    if (!post) return;
    var badgeVariant = post.followBadge;
    var followBadge =
      badgeVariant === 'hidden'
        ? '<span data-testid="socialContext" style="display:none">Seguindo</span>'
        : badgeVariant === 'unrelated'
          ? '<div class="quoted-post-context"><span data-testid="socialContext">Seguindo</span></div>'
          : badgeVariant === 'visible'
            ? '<span data-testid="socialContext">Seguindo</span>'
            : '';
    primary.innerHTML =
      '<div data-testid="statusView">' +
      '<div data-testid="app-bar-close" role="button" tabindex="0">Voltar</div>' +
      '<div data-testid="replyComposerContainer">' +
      '<div dir="ltr"><span>Respondendo a </span><a href="/' + post.handle + '" role="link">@' + post.handle + '</a></div>' +
      followBadge +
      '<div data-testid="tweetTextarea_1RichTextInputContainer">' +
      '<div data-testid="tweetTextarea_1" role="textbox" contenteditable="true" aria-label="Texto do seu post" class="public-DraftEditor-content"></div>' +
      '</div>' +
      '<button type="button" data-testid="addMedia" aria-label="Adicionar midia"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M0 0h24v24H0z" fill="none"/></svg></button>' +
      // Same furniture row as the home composer: media control, character counter, Post button —
      // the row the collapsed score pill anchors into.
      '<span data-testid="charCounter">0</span>' +
      '<button type="button" data-testid="tweetButton" aria-disabled="false">Responder</button>' +
      '</div>' +
      '</div>';
  }

  /**
   * The REAL status-page view (library/x-dom.md, verified 2026-10-03): the primary post above an
   * inline "Post your reply" composer whose testid is tweetTextarea_0 and whose REGION (the plain
   * div around the RichTextInputContainer) holds ONLY those two testids — NO reply chip, no
   * follow badge. Reply context on this shape comes from the ROUTE (/<handle>/status/<id>).
   */
  function renderStatusPageView(id) {
    var postHtml = CELL_HTML[id];
    if (!postHtml) return;
    primary.innerHTML =
      '<div data-testid="statusView">' +
      '<nav><a href="/" role="link" data-testid="navHome"><span>Pagina inicial</span></a></nav>' +
      postHtml +
      '<div>' +
      '<div data-testid="tweetTextarea_0RichTextInputContainer">' +
      '<div class="DraftEditor-root">' +
      '<div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" aria-label="Poste sua resposta" spellcheck="true" class="notranslate public-DraftEditor-content"></div>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '<button type="button" data-testid="tweetButtonInline" aria-disabled="true">Responder</button>' +
      '</div>';
  }

  // The profile timeline: every post by the handle, newest first (data-derived — VAL-TARGET-003).
  function renderProfileView(handle) {
    var ids = ALL_IDS.filter(function (id) { return POSTS_BY_ID[id].handle === handle; });
    primary.innerHTML =
      '<div data-testid="profileView">' +
      '<nav><a href="/" role="link" data-testid="navHome"><span>Pagina inicial</span></a></nav>' +
      '<h1>@' + handle + '</h1>' +
      '<div data-testid="primaryTimeline">' + ids.map(cellOf).join('') + '</div>' +
      '</div>';
  }

  // The search timeline: every post whose text matches the query (data-derived — VAL-TARGET-003).
  function renderSearchView(query) {
    var needle = query.toLowerCase();
    var ids = ALL_IDS.filter(function (id) { return POSTS_BY_ID[id].text.toLowerCase().indexOf(needle) !== -1; });
    primary.innerHTML =
      '<div data-testid="searchView">' +
      '<nav><a href="/" role="link" data-testid="navHome"><span>Pagina inicial</span></a></nav>' +
      '<h1>Buscar: ' + query + '</h1>' +
      '<div data-testid="primaryTimeline">' + ids.map(cellOf).join('') + '</div>' +
      '</div>';
  }

  var EXPLORE_VIEW_HTML = ${JSON.stringify(renderExploreViewHtml())};
  function renderExploreView() {
    primary.innerHTML = EXPLORE_VIEW_HTML;
  }

  // Direct loads keep real routes: /explore is composer-less, status URLs show the REAL
  // status-page shape, /search?q= and known-handle paths show their timelines, everything else
  // is the For You home.
  if (location.pathname === '/explore') {
    renderExploreView();
  } else if (location.pathname === '/search') {
    renderSearchView(searchQuery(location.search) || '');
  } else if (statusId(location.pathname)) {
    renderStatusPageView(statusId(location.pathname));
  } else if (isKnownHandle(location.pathname)) {
    renderProfileView(isKnownHandle(location.pathname));
  }

  /**
   * Virtualized-feed recycling (VAL-TARGET-002): near the bottom, the OLDEST timeline cell is
   * recycled for the next extended post — the SAME article node re-rendered for a different post
   * id and moved to the end, so the node count never grows.
   */
  window.addEventListener('scroll', function () {
    if (location.pathname !== '/' && location.pathname !== '/home') return;
    if (currentTab !== 'foryou') return; // only the For You timeline extends by recycling
    if (extendedNext >= EXTENDED_IDS.length) return;
    var doc = document.documentElement;
    if (window.scrollY + window.innerHeight < doc.scrollHeight - 60) return;
    var timeline = primary.querySelector('[data-testid="primaryTimeline"]');
    var firstCell = timeline ? timeline.firstElementChild : null;
    var article = firstCell ? firstCell.querySelector('article') : null;
    if (!article) return;
    var nextId = EXTENDED_IDS[extendedNext];
    extendedNext += 1;
    article.innerHTML = ARTICLE_INNER_HTML[nextId];
    timeline.appendChild(firstCell);
  });

  function makeAttachments() {
    var wrap = document.createElement('div');
    wrap.setAttribute('data-testid', 'attachments');
    var photo = document.createElement('div');
    photo.setAttribute('data-testid', 'tweetPhoto');
    var img = document.createElement('img');
    img.setAttribute('alt', 'Imagem anexada');
    img.setAttribute('src', 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==');
    img.setAttribute('width', '64');
    img.setAttribute('height', '64');
    photo.appendChild(img);
    wrap.appendChild(photo);
    return wrap;
  }

  document.addEventListener('click', function (event) {
    var target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('[data-testid="addMedia"]')) {
      var region = target.closest('[data-testid="toolBar"], [data-testid="replyComposerContainer"]');
      if (region && !region.querySelector('[data-testid="attachments"]')) {
        region.appendChild(makeAttachments());
      }
      return;
    }
    if (target.closest('[data-testid="navExplore"]')) {
      event.preventDefault();
      history.pushState({}, '', '/explore');
      renderExploreView();
      return;
    }
    if (target.closest('[data-testid="navProfile"]')) {
      event.preventDefault();
      history.pushState({}, '', '/ana_builds');
      renderProfileView('ana_builds');
      return;
    }
    if (target.closest('[data-testid="navSearch"]')) {
      event.preventDefault();
      history.pushState({}, '', '/search?q=tool');
      renderSearchView('tool');
      return;
    }
    if (target.closest('[data-testid="navHome"]')) {
      event.preventDefault();
      history.pushState({}, '', '/');
      renderHome('foryou');
      return;
    }
    if (target.closest('[data-testid="tabForYou"]')) {
      renderHome('foryou');
      return;
    }
    if (target.closest('[data-testid="tabFollowing"]')) {
      // Like x.com's Following tab: the timeline swaps in place, the URL does not change.
      setTab('following');
      renderTimelineIds(FOLLOWING_IDS);
      return;
    }
    var statusLink = target.closest('a[href*="/status/"]');
    if (statusLink) {
      event.preventDefault();
      var href = statusLink.getAttribute('href') || '';
      var id = statusId(href);
      if (id && POSTS_BY_ID[id]) {
        history.pushState({}, '', href);
        renderReplyView(id);
      }
      return;
    }
    if (target.closest('[data-testid="app-bar-close"]')) {
      history.back();
    }
  });

  window.addEventListener('popstate', function () {
    if (location.pathname === '/explore') {
      renderExploreView();
      return;
    }
    var id = statusId(location.pathname);
    // Back/forward into a status route lands on the REAL status-page shape (like a fresh visit);
    // status-link CLICKS above still open the reply-DIALOG shape (tweetTextarea_1 + chip).
    if (id) renderStatusPageView(id);
    else if (location.pathname === '/search') renderSearchView(searchQuery(location.search) || '');
    else if (isKnownHandle(location.pathname)) renderProfileView(isKnownHandle(location.pathname));
    else renderHome('foryou');
  });
})();
</script>
</body>
</html>
`;
}
