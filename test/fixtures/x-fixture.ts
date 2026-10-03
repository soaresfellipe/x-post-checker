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
</style>
</head>
<body>
<div id="react-root">
<nav data-testid="sidebarNav"><a href="/explore" role="link" data-testid="navExplore"><span>Explorar</span></a></nav>
<main role="main">
  <div data-testid="primaryColumn">
    <div data-testid="toolBar">
      <div data-testid="tweetTextarea_0RichTextInputContainer">
        <div class="DraftEditor-root">
          <div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" aria-label="Texto do post" aria-multiline="true" spellcheck="true" class="notranslate public-DraftEditor-content"></div>
        </div>
        <label data-testid="tweetTextarea_0_label">O que está acontecendo?</label>
      </div>
      <button type="button" data-testid="addMedia" aria-label="Adicionar midia"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M0 0h24v24H0z" fill="none"/></svg></button>
      <button type="button" data-testid="tweetButtonInline" aria-disabled="true">Postar</button>
    </div>
    <div aria-label="Timeline: Sua Página Inicial">
${FIXTURE_POSTS.map((post) => renderPost(post, now)).join('\n')}
    </div>
  </div>
</main>
</div>
<script>
(function () {
  'use strict';
  var primary = document.querySelector('[data-testid="primaryColumn"]');
  if (!primary) return;
  var homeHtml = primary.innerHTML;
  var POSTS_BY_ID = ${JSON.stringify(
    Object.fromEntries(
      FIXTURE_POSTS.map((post) => [
        post.id,
        {
          handle: post.handle,
          followBadge: post.followBadge ?? (post.followsViewer === true ? 'visible' : null),
        },
      ]),
    ),
  )};

  function statusId(path) {
    var match = /\\/status\\/(\\d+)/.exec(path);
    return match ? match[1] : null;
  }

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
      '<button type="button" data-testid="tweetButton" aria-disabled="false">Responder</button>' +
      '</div>' +
      '</div>';
  }

  function renderHome() {
    primary.innerHTML = homeHtml;
  }

  var EXPLORE_VIEW_HTML = ${JSON.stringify(renderExploreViewHtml())};
  function renderExploreView() {
    primary.innerHTML = EXPLORE_VIEW_HTML;
  }

  // A direct load of /explore starts on the composer-less view (full reloads keep real routes).
  if (location.pathname === '/explore') renderExploreView();

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
    if (id) renderReplyView(id);
    else renderHome();
  });
})();
</script>
</body>
</html>
`;
}
