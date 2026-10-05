/**
 * Real x.com READ-ONLY smoke test (automated Chrome leg, authorized for m6-real-x-and-parity).
 *
 * What it proves on the LOGGED-IN real x.com, with the RELEASE extension build loaded (the
 * M6 Design-1b row model):
 *   1. the content script activates (marker mounts, background connected, composer watched);
 *   2. reply-target badges appear on eligible timeline posts (default threshold first; if the
 *      live timeline has none, the threshold is lowered through the REAL Options UI — the
 *      contract's "configured threshold" — and the timeline re-gated);
 *   3. an extension-owned badge chip (score-only, inside [data-testid="User-Name"]) click opens
 *      the popover WITHOUT activating/navigating the post (VAL-TARGET-022 Chrome leg) — run
 *      BEFORE the draft steps, which churn the virtualized feed (the fresh feed has the badges
 *      phase 2 just counted);
 *   4. typing a synthetic draft inserts the 36px STATUS ROW IN FLOW as the immediate preceding
 *      sibling of the composer's [data-testid="toolBar"] (placement 'flow', VAL-DRAFT-047),
 *      with the expanded block absent until clicked (NEVER submitted);
 *   5. clicking the row expands the inline analysis in flow (the toolBar-to-host offset grows
 *      by the block height — the toolbar is pushed down, VAL-DRAFT-024); Escape collapses back
 *      to the row;
 *   6. with the scored draft present (row visible), typing an '@' mention opens X's OWN
 *      autocomplete dropdown fully visible and usable OVER the row — geometry + hit tests land
 *      on X's dropdown, never on an AmplifyX surface (VAL-DRAFT-040; the M5 visibility-yield
 *      mechanism is removed) — and Escape dismisses it untouched;
 *   7. clearing the draft removes the ENTIRE overlay host (no UI left) within a bounded window;
 *   8. ZERO requests to api.typesafe.ai (fresh profile = no key = AI structurally off);
 *   9. ZERO post-submission requests (CreateTweet/…); the session stays logged in at the end.
 *
 * Read-only guarantees (AGENTS.md boundaries — same discipline as scripts/real-x-inspect.mjs):
 *   - The ONLY page interactions are: navigating, reading the DOM, focusing/clicking the composer
 *     TEXTBOX to type, typing, and clicking an EXTENSION-OWNED badge/popover button. The Post
 *     button and every post/like/follow/repost/bookmark control are never touched; nothing is
 *     ever submitted. The typed draft is cleared afterwards (best effort).
 *   - The cookie-bearing profile is credential material: a fresh mkdtemp dir, deleted in the
 *     finally block on BOTH the success and every error path. Only this run's profile is removed.
 *   - Evidence is STRUCTURAL FACTS ONLY: counts, test ids, op names, extension UI text. No post
 *     text, no handles, no cookies/keys/headers, no query strings. Screenshots are taken with a
 *     redaction stylesheet (page text transparent, images/avatars hidden) and clipped to the
 *     extension-owned elements; the extension shadow roots use `:host { all: initial }`, so they
 *     keep their own colors.
 *
 * Exit codes: 0 pass, 2 missing cookies, 3 session challenged/expired (surface to the
 * orchestrator — do NOT retry aggressively), 4 smoke assertion failed, 1 error.
 * Evidence dir: $REALX_EVIDENCE_DIR (default <repo>/evidence/real-x-smoke, gitignored —
 * deliberately OUTSIDE Playwright's test-results/, which is wiped at the start of every
 * `pnpm test:e2e` / `pnpm test` run, which destroyed the m5 14/14 live artifacts once).
 */
import { chromium } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXTENSION_DIR = join(REPO, '.output', 'chrome-mv3');
const EVIDENCE_DIR = process.env.REALX_EVIDENCE_DIR
  ? resolve(process.env.REALX_EVIDENCE_DIR)
  : join(REPO, 'evidence', 'real-x-smoke');

/** The synthetic, non-sensitive draft this smoke types (never submitted, never a real opinion). */
const SMOKE_DRAFT = 'Testing AmplifyX on a real timeline: does this draft earn a score? #smoketest';
/** Default reply-target threshold (src/core/settings-store). Phase A runs with it. */
const DEFAULT_THRESHOLD = 70;
/** Phase-B fallback threshold, set through the REAL Options UI when the timeline yields no badge. */
const FALLBACK_THRESHOLD = 40;

/** Post-creation endpoints: any of these in the capture is a hard failure. */
const POST_SUBMISSION = /createtweet|createnotetweet|statuses\/update|createpost/i;

/** Evidence stylesheet: page text/images cannot survive it; extension shadow roots are unaffected. */
const REDACTION_STYLESHEET = `
  html body, html body *:not(style):not(script) { color: transparent !important; }
  html img, html video, html svg { visibility: hidden !important; }
  html [style*="background-image"] { background-image: none !important; }
`;

function readEnvValues() {
  const raw = readFileSync(join(REPO, '.env.local'), 'utf8');
  const values = new Map();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    values.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return values;
}

/** @type {{ step: string, pass: boolean, detail: string }[]} */
const results = [];
function record(step, pass, detail) {
  results.push({ step, pass, detail });
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${step}: ${detail}`);
}

/** Network capture: method + host + path ONLY (query strings stripped, headers never kept). */
const network = [];
function recordRequest(request) {
  try {
    const url = new URL(request.url());
    network.push({ method: request.method(), host: url.host, path: url.pathname });
  } catch {
    network.push({ method: request.method(), host: '(unparsed)', path: '' });
  }
}

/** Polls an async predicate until it returns a value or the timeout elapses (returns null). */
async function waitFor(poll, timeoutMs, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await poll();
      if (value) return value;
    } catch {
      /* keep polling until the deadline */
    }
    if (Date.now() > deadline) return null;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, intervalMs));
  }
}

async function main() {
  const env = readEnvValues();
  const authToken = env.get('X_AUTH_TOKEN');
  const ct0 = env.get('X_CT0');
  if (!authToken || !ct0) {
    console.log('RESULT: missing-cookies');
    process.exitCode = 2;
    return;
  }
  if (!readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8').includes('x.com')) {
    console.log('RESULT: error — .output/chrome-mv3 missing or does not match x.com; run `pnpm build:chrome`');
    process.exitCode = 1;
    return;
  }
  mkdirSync(EVIDENCE_DIR, { recursive: true });

  // Credential-material profile: fresh mkdtemp, deleted in the finally below on EVERY path.
  const profile = mkdtempSync(join(tmpdir(), 'amplifyx-realx-smoke-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1280, height: 1400 }, // tall: the expanded analysis must fit for evidence
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
      ],
      timeout: 45_000,
    });
    context.on('request', recordRequest);
    context.on('pageerror', (error) => {
      record('page-error', false, `uncaught exception: ${String(error).slice(0, 160)}`);
    });

    await context.addCookies([
      { name: 'auth_token', value: authToken, domain: '.x.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'ct0', value: ct0, domain: '.x.com', path: '/', secure: true, sameSite: 'Lax' },
    ]);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);

    // ---- 1. Session check on real x.com/home ----
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const composer = page.locator('div[data-testid="tweetTextarea_0"][role="textbox"][contenteditable="true"]');
    const composerAppeared = await composer.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false);
    if (!composerAppeared) {
      console.log('RESULT: session-challenged (no home composer after load)');
      process.exitCode = 3;
      return;
    }
    record('session-ok', true, 'logged-in home composer visible, no login wall');

    // ---- 2. Content-script activation ----
    // `data-background` is stamped on the INNER shadow-DOM marker div (mountMarker returns it —
    // the fixture E2E asserts it there); watcher/scanner diagnostics are stamped on the HOST.
    // The ping reply is async, and the real site can remount the host (run-2 scan counts reset
    // mid-run), so poll both facts with a generous window and dump structural dataset facts on
    // failure (attribute names/values only — no page content).
    const activation = await waitFor(async () => {
      const background = await page
        .locator('#amplifyx-marker-host [data-testid="amplifyx-marker"]')
        .getAttribute('data-background');
      const watcher = await page.locator('#amplifyx-marker-host').getAttribute('data-watcher-state');
      return background === 'connected' && watcher === 'watching' ? { watcher, background } : null;
    }, 25_000);
    let activationDetail = `marker=${activation ? 'connected' : 'unconfirmed'} watcher=${activation?.watcher ?? 'n/a'}`;
    if (activation === null) {
      const facts = await page.evaluate(() => {
        const hosts = document.querySelectorAll('#amplifyx-marker-host');
        const host = hosts[0];
        const inner = host?.shadowRoot?.querySelector('[data-testid="amplifyx-marker"]');
        return {
          hostCount: hosts.length,
          hostDataset: host ? { ...host.dataset } : null,
          innerDataset: inner ? { ...inner.dataset } : null,
        };
      });
      activationDetail += ` facts=${JSON.stringify(facts)}`;
    }
    record('content-script-active', activation !== null, activationDetail);

    // ---- 3. Timeline badges (Phase A: default threshold) ----
    let badgeCount = 0;
    let effectiveThreshold = DEFAULT_THRESHOLD;
    const markerHost = page.locator('#amplifyx-marker-host');
    const scannerReady = await waitFor(async () => {
      const count = Number((await markerHost.getAttribute('data-scanner-scan-count')) ?? '0');
      return count >= 1 ? count : null;
    }, 15_000);
    record('timeline-scanned', scannerReady !== null, `scan passes=${scannerReady ?? 'none'}`);

    let found = await waitFor(async () => {
      const n = await page.locator('button[data-testid="amplifyx-target-badge"]').count();
      return n > 0 ? n : null;
    }, 12_000);
    if (found === null) {
      // Surface more of the virtualized feed (wheel scrolling is read-only).
      for (let scroll = 0; scroll < 2 && found === null; scroll += 1) {
        await page.mouse.wheel(0, 1400);
        await page.waitForTimeout(5_000);
        found = await waitFor(async () => {
          const n = await page.locator('button[data-testid="amplifyx-target-badge"]').count();
          return n > 0 ? n : null;
        }, 6_000);
      }
    }
    badgeCount = found ?? 0;

    if (badgeCount === 0) {
      // Phase B: lower the threshold through the REAL Options UI (the contract's configured
      // threshold), then let the live settings sync re-gate the timeline.
      const worker = context.serviceWorkers()[0]
        ?? (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
      const optionsPage = await context.newPage();
      await optionsPage.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`, {
        waitUntil: 'domcontentloaded',
      });
      const thresholdInput = optionsPage.locator('#pref-targetThreshold');
      await thresholdInput.fill(String(FALLBACK_THRESHOLD));
      await thresholdInput.press('Tab'); // prefs save on the input's change event
      const saved = await optionsPage
        .locator('[data-testid="prefs-status"]')
        .filter({ hasText: 'Preferences saved.' })
        .waitFor({ state: 'visible', timeout: 10_000 })
        .then(() => true, () => false);
      await optionsPage.close();
      await page.bringToFront(); // background tabs throttle timers: foreground the timeline
      record('threshold-lowered', saved, `threshold ${DEFAULT_THRESHOLD} -> ${FALLBACK_THRESHOLD} via Options UI`);

      found = await waitFor(async () => {
        const n = await page.locator('button[data-testid="amplifyx-target-badge"]').count();
        return n > 0 ? n : null;
      }, 20_000);
      badgeCount = found ?? 0;
      if (badgeCount > 0) effectiveThreshold = FALLBACK_THRESHOLD;
    }

    const scannedPosts = JSON.parse((await markerHost.getAttribute('data-scanner-posts')) ?? '[]').length;
    record(
      'badges-on-eligible-posts',
      badgeCount > 0,
      `badges=${badgeCount} at threshold=${effectiveThreshold} (posts scanned in view: ${scannedPosts})`,
    );

    // ---- 3b. Extension-owned badge click -> popover, WITHOUT activating the post ----
    if (badgeCount > 0) {
      const urlBefore = page.url();
      // Re-establish a badge AT CLICK TIME (the virtualized feed recycles articles and badges
      // re-attach on rescans). All probes here go through the SHADOW-PIERCING chip lookup (the
      // host → shadowRoot → chip chain): a light-DOM locator can under-report while X churns
      // the feed. Wheel scrolling (up to the snap-list top, then down) is read-only.
      const chipsPresent = () =>
        page.evaluate(() => {
          for (const host of document.querySelectorAll('[data-amplifyx-host="badge"]')) {
            if (host.shadowRoot?.querySelector('button[data-testid="amplifyx-target-badge"]')) return true;
          }
          return false;
        });
      const clickFirstChip = () =>
        page.evaluate(() => {
          for (const host of document.querySelectorAll('[data-amplifyx-host="badge"]')) {
            const chip = host.shadowRoot?.querySelector('button[data-testid="amplifyx-target-badge"]');
            if (chip instanceof HTMLElement) {
              chip.click();
              return true;
            }
          }
          return false;
        });
      await page.mouse.wheel(0, -12_000); // back to the top of the snap list
      await page.waitForTimeout(3_000);
      let badgeAtClickTime = await waitFor(async () => ((await chipsPresent()) ? 1 : null), 15_000);
      for (let scroll = 0; scroll < 3 && badgeAtClickTime === null; scroll += 1) {
        await page.mouse.wheel(0, 900);
        await page.waitForTimeout(5_000);
        badgeAtClickTime = await waitFor(async () => ((await chipsPresent()) ? 1 : null), 8_000);
      }
      const popoverLoc = page.locator('#amplifyx-target-popover-host [data-testid="amplifyx-target-popover"]');
      let popoverAppeared = false;
      if (badgeAtClickTime === null) {
        // No badge came back even after surfacing more feed: nothing to click; the diagnostics
        // below still record the structural state. Never a reason to touch a post control.
        console.log('      badge-step diagnostics: no badge re-appeared within the re-wait window');
      } else {
        // A chip can be DETACHED by a React re-render between the lookup and the click (the
        // click then lands on a stale node and opens nothing), so retry through FRESH lookups.
        for (let attempt = 0; attempt < 3 && !popoverAppeared; attempt += 1) {
          await clickFirstChip();
          popoverAppeared = await popoverLoc
            .waitFor({ state: 'visible', timeout: 8_000 })
            .then(() => true, () => false);
          if (!popoverAppeared && attempt < 2) await page.waitForTimeout(2_000);
        }
      }
      const popoverAi = popoverAppeared
        ? await page.locator('#amplifyx-target-popover-host [data-testid="amplifyx-popover-ai-notice"]').innerText().catch(() => '')
        : '';
      if (!popoverAppeared) {
        // Structural diagnostics only: badge geometry + what the badge's own click point resolves
        // to (id/testid/tag names — never page text).
        const diag = await page.evaluate(() => {
          const badgeEl = document.querySelector('button[data-testid="amplifyx-target-badge"]');
          const box = badgeEl?.getBoundingClientRect() ?? null;
          const hit =
            box && box.width > 0
              ? (() => {
                  const el = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
                  if (!el) return 'outside-viewport';
                  const testid = el.getAttribute?.('data-testid') ?? '(none)';
                  return `${el.tagName.toLowerCase()}#=${el.id || '-'} testid=${testid}`;
                })()
              : 'no-box';
          return {
            badgeCount: document.querySelectorAll('button[data-testid="amplifyx-target-badge"]').length,
            badgeBox: box ? { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) } : null,
            hitAtBadgeCenter: hit,
            popoverHostPresent: document.getElementById('amplifyx-target-popover-host') !== null,
          };
        });
        console.log(`      badge-step diagnostics: ${JSON.stringify(diag)}`);
      }
      record(
        'badge-click-popover-no-navigation',
        popoverAppeared && page.url() === urlBefore,
        `popover=${popoverAppeared ? 'opened' : 'absent'} urlUnchanged=${page.url() === urlBefore} aiNotice="${popoverAi.slice(0, 60)}"`,
      );
      // 1b placement + anatomy (VAL-TARGET-022 Chrome leg / VAL-TARGET-026): the chip host sits
      // INSIDE the article's [data-testid="User-Name"] and the chip carries the SCORE ONLY (the
      // reason lives in the tooltip/aria-label). Structural facts, no page content.
      const badgePlacement = await page.evaluate(() => {
        for (const host of document.querySelectorAll('[data-amplifyx-host="badge"]')) {
          const button = host.shadowRoot?.querySelector('button[data-testid="amplifyx-target-badge"]');
          if (!button) continue;
          return {
            inUserName: host.parentElement?.closest('[data-testid="User-Name"]') !== null,
            chipText: (button.textContent ?? '').trim(),
            scoreOnly: /^\d{1,3}$/.test((button.textContent ?? '').trim()),
            ariaLabel: (button.getAttribute('aria-label') ?? '').startsWith('Reply target score '),
            hostCount: document.querySelectorAll('[data-amplifyx-host="badge"]').length,
          };
        }
        return null;
      });
      record(
        'badge-chip-in-user-name',
        badgePlacement !== null && badgePlacement.inUserName && badgePlacement.scoreOnly && badgePlacement.ariaLabel,
        `inUserName=${badgePlacement?.inUserName ?? 'n/a'} chip="${badgePlacement?.chipText ?? 'n/a'}" scoreOnly=${badgePlacement?.scoreOnly ?? 'n/a'} ariaLabelShaped=${badgePlacement?.ariaLabel ?? 'n/a'} badgeHosts=${badgePlacement?.hostCount ?? 0}`,
      );
      if (popoverAppeared) {
        try {
          await page
            .locator('#amplifyx-target-popover-host [data-testid="amplifyx-popover-close"]')
            .click({ timeout: 8_000 });
        } catch {
          await page.evaluate(() => {
            const close = document
              .getElementById('amplifyx-target-popover-host')
              ?.shadowRoot?.querySelector('[data-testid="amplifyx-popover-close"]');
            if (close instanceof HTMLElement) close.click();
          });
        }
      }
    }

    // ---- 4. Draft status row on a typed synthetic draft (NEVER submitted) ----
    // M6 DESIGN-1B ROW MODEL: while typing the ONLY extension UI near the composer is the 36px
    // in-flow status row inserted as the immediate preceding sibling of X's toolBar. The inline
    // analysis exists only after an explicit click on the row (VAL-DRAFT-032), and the row's
    // placement must be 'flow' — never the fallback while the toolbar exists (VAL-DRAFT-047).
    await composer.click(); // focus the composer TEXTBOX (not a post control) to expand it
    await page.keyboard.type(SMOKE_DRAFT, { delay: 12 });
    const row = page.locator('#amplifyx-overlay-host [data-testid="amplifyx-overlay-row"]');
    const rowAppeared = await row.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false);
    const rowHeadline = rowAppeared
      ? await page.locator('#amplifyx-overlay-host [data-testid="overlay-headline"]').innerText().catch(() => '')
      : '';
    const expandedAbsentWhileTyping = (await page.locator('#amplifyx-overlay-host [data-testid="amplifyx-overlay"]').count()) === 0;
    const rowFacts = await page.evaluate(() => {
      const host = document.getElementById('amplifyx-overlay-host');
      const toolBars = [...document.querySelectorAll('[data-testid="toolBar"]')];
      return {
        placement: host?.getAttribute('data-placement') ?? null,
        toolbarSibling: toolBars.some((bar) => bar.previousElementSibling === host),
        hostCount: document.querySelectorAll('#amplifyx-overlay-host').length,
        rowHeight: host?.shadowRoot?.querySelector('[data-testid="amplifyx-overlay-row"]') instanceof HTMLElement
          ? Math.round(host.shadowRoot.querySelector('[data-testid="amplifyx-overlay-row"]').getBoundingClientRect().height)
          : null,
      };
    });
    record(
      'draft-row-inserted-before-toolbar',
      rowAppeared && expandedAbsentWhileTyping && rowFacts.placement === 'flow' && rowFacts.toolbarSibling && rowFacts.hostCount === 1,
      `placement=${rowFacts.placement} toolbarSibling=${rowFacts.toolbarSibling} hosts=${rowFacts.hostCount} rowHeight=${rowFacts.rowHeight}px headline="${rowHeadline.trim()}" blockPresentWhileTyping=${!expandedAbsentWhileTyping}`,
    );

    // Expand through the row — the only way the inline analysis comes into existence. The
    // expanded block must push the toolbar DOWN (in-flow layout shift, VAL-DRAFT-024/042).
    let blockState = null;
    let headline = '';
    let chipCount = 0;
    let jevNotice = '';
    let toolbarPushedDown = false;
    let clickMode = 'not-clicked';
    let toolBarOffsetBefore = null;
    /** The toolBar-to-host offset (both ends scroll with the composer item, so the delta is
     * page-scroll invariant): collapsed = the row's 37px; expanded = 37px + the block height. */
    const ownToolBarOffsetFromHost = () =>
      page.evaluate(() => {
        const host = document.getElementById('amplifyx-overlay-host');
        const bar =
          host?.nextElementSibling?.getAttribute?.('data-testid') === 'toolBar'
            ? host.nextElementSibling
            : ([...document.querySelectorAll('[data-testid="toolBar"]')].find((candidate) => candidate.previousElementSibling === host) ?? null);
        if (bar === null || host === null) return null;
        return bar.getBoundingClientRect().top - host.getBoundingClientRect().top;
      });
    const maskFacts = () =>
      page.evaluate(() => {
        const mask = document.querySelector('div[data-testid="mask"]');
        if (!mask) return null;
        const dialog = document.querySelector('#layers [role="dialog"], #layers [data-testid="sheetDrawer"]');
        return {
          maskPresent: true,
          dialogTestid: dialog?.getAttribute?.('data-testid') ?? null,
          dialogAriaLabelled: dialog?.hasAttribute?.('aria-label') ?? false,
        };
      });
    if (rowAppeared) {
      // X's home timeline is a scroll-snap list whose FIRST item is the composer block: while
      // the feed settles it can scroll the composer (row + toolbar with it) partially out of
      // view, which both stalls the click's stability check and skews any toolBar measurement.
      // Bring the composer back into view first (a scroll is read-only) and let it settle.
      await page.evaluate(() => {
        document.getElementById('amplifyx-overlay-host')?.scrollIntoView({ block: 'center', behavior: 'instant' });
      });
      await page.waitForTimeout(1_500);
      // If X opened one of its own modal dialogs while we typed, dismiss it with Escape
      // (closes X's own UI only — no post control is touched) and record the fact.
      let mask = await maskFacts();
      if (mask !== null) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1_000);
        const after = await maskFacts();
        console.log(`      note: X dialog scrim detected while typing (${JSON.stringify(mask)}); Escape-dismissed: ${after === null}`);
        mask = after;
      }
      toolBarOffsetBefore = await ownToolBarOffsetFromHost();
      // Click the EXTENSION-OWNED row button. On the live site Playwright's actionability
      // hit-target check can stall (X re-renders under the pointer / layout churn), so fall
      // back to a programmatic click on the SAME shadow button — still an extension-owned
      // interaction, still read-only (it toggles the overlay's own expansion).
      try {
        await row.click({ timeout: 8_000 });
        clickMode = 'locator-click';
      } catch {
        // X can open one of its own modal dialogs mid-click (its scrim then scroll-locks the
        // page and stalls the hit-target check). Dismiss X's dialog with Escape — it is page
        // UI, not a post control — and record the fact.
        const maskDuringStall = await maskFacts();
        if (maskDuringStall !== null) {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(800);
        }
        const hit = await page.evaluate(() => {
          const rowEl = document.getElementById('amplifyx-overlay-host')?.shadowRoot?.querySelector('[data-testid="amplifyx-overlay-row"]');
          if (!rowEl) return 'row-gone';
          const box = rowEl.getBoundingClientRect();
          const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          if (!at) return 'outside-viewport';
          // Structural identity of the element that won the hit test at the row's center:
          // tag + testid + WHERE it lives (in X's layers portal? an ancestor of the composer?)
          // — enough to tell X's own transient layer from a real occluder, never any content.
          const inLayers = at.closest('#layers') !== null;
          const composer = document.querySelector('div[data-testid="tweetTextarea_0"]');
          const chain = [];
          let node = at;
          for (let depth = 0; depth < 4 && node !== null; depth += 1) {
            chain.push(`${node.tagName?.toLowerCase()}${node.id ? `#${node.id}` : ''}${node.getAttribute?.('data-testid') ? `[${node.getAttribute('data-testid')}]` : ''}`);
            node = node.parentElement;
          }
          const style = getComputedStyle(at);
          return `${at.tagName.toLowerCase()} testid=${at.getAttribute?.('data-testid') ?? '-'} inLayers=${inLayers} ancestorOfComposer=${composer !== null && at.contains(composer)} position=${style.position} z=${style.zIndex} chain=${chain.slice(0, 4).join(' < ')}`;
        });
        await page.evaluate(() => {
          const rowEl = document.getElementById('amplifyx-overlay-host')?.shadowRoot?.querySelector('[data-testid="amplifyx-overlay-row"]');
          if (rowEl instanceof HTMLElement) rowEl.click();
        });
        clickMode = `evaluate-click (hit-at-center=${hit}${maskDuringStall !== null ? '; Escape-dismissed an X dialog mid-click' : ''})`;
      }
      const block = page.locator('#amplifyx-overlay-host [data-testid="amplifyx-overlay"]');
      const blockAppeared = await block.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false);
      if (blockAppeared) {
        blockState = await waitFor(async () => {
          const state = await block.getAttribute('data-state');
          return state === 'analyzed' ? 'analyzed' : null;
        }, 15_000);
        headline = await page.locator('#amplifyx-overlay-host [data-testid="overlay-headline"]').innerText().catch(() => '');
        chipCount = await page.locator('#amplifyx-overlay-host [data-testid="overlay-chip"]').count();
        jevNotice = await page.locator('#amplifyx-overlay-host [data-testid="overlay-jev-notice"]').innerText().catch(() => '');
        toolbarPushedDown = await page.evaluate((before) => {
          const host = document.getElementById('amplifyx-overlay-host');
          const bar =
            host?.nextElementSibling?.getAttribute?.('data-testid') === 'toolBar'
              ? host.nextElementSibling
              : ([...document.querySelectorAll('[data-testid="toolBar"]')].find((candidate) => candidate.previousElementSibling === host) ?? null);
          if (bar === null || host === null) return false;
          // The toolBar-to-host OFFSET is page-scroll invariant (both scroll with the composer
          // item); it grows by the expanded block's height when the block pushes the bar down.
          const after = bar.getBoundingClientRect().top - host.getBoundingClientRect().top;
          return after > before + 1;
        }, toolBarOffsetBefore);
      }
    }
    const headlineScore = Number.parseInt(headline, 10);
    const toolBarOffsetAfter = await ownToolBarOffsetFromHost();
    const fmt = (value) => (typeof value === 'number' ? `${Math.round(value)}px` : 'n/a');
    record(
      'draft-row-expands-inline',
      blockState === 'analyzed' && Number.isInteger(headlineScore) && headlineScore >= 0 && headlineScore <= 100 && chipCount > 0 && toolbarPushedDown,
      `state=${blockState ?? 'n/a'} headline=${Number.isInteger(headlineScore) ? headlineScore : 'n/a'} chips=${chipCount} toolbarOffset ${fmt(toolBarOffsetBefore)} -> ${fmt(toolBarOffsetAfter)} click=${clickMode} aiNotice="${jevNotice.slice(0, 60)}"`,
    );
    record(
      'draft-ai-off-local-only',
      jevNotice.startsWith('Local signals only'),
      'no key in this profile: the expanded analysis shows the local-only notice (AI structurally off)',
    );

    // Evidence of the collapsed row and the expanded analysis BEFORE the clear (redacted), then
    // Escape (collapse back to the row) and the clear-and-reset step.
    await page.addStyleTag({ content: REDACTION_STYLESHEET });
    await page
      .locator('#amplifyx-overlay-host')
      .screenshot({ path: join(EVIDENCE_DIR, 'overlay-row-expanded-redacted.png') })
      .catch(() => {});
    await page.keyboard.press('Escape'); // collapse back to the row for the collapsed evidence
    const escapeCollapsed = await waitFor(
      async () => ((await page.locator('#amplifyx-overlay-host [data-testid="amplifyx-overlay"]').count()) === 0 ? true : null),
      5_000,
    );
    const rowStillThere = (await page.locator('#amplifyx-overlay-host [data-testid="amplifyx-overlay-row"]').count()) === 1;
    record(
      'escape-collapses-row-remains',
      escapeCollapsed === true && rowStillThere,
      `block collapsed by Escape=${escapeCollapsed === true} row still present=${rowStillThere}`,
    );
    await page
      .locator('#amplifyx-overlay-host')
      .screenshot({ path: join(EVIDENCE_DIR, 'overlay-row-collapsed-redacted.png') })
      .catch(() => {});

    // ---- 4b. Mention-autocomplete over the status row (VAL-DRAFT-040): with a scored draft
    // present (the 36px row visible in flow), typing an '@' mention must show X's OWN
    // autocomplete dropdown fully visible and usable — X's dropdown may draw OVER the row (the
    // M5 visibility-yield is removed); geometry + a HIT TEST prove no AmplifyX surface covers
    // it: the top-most element at sample points inside the dropdown must live in the dropdown's
    // own tree, never at an extension host. Escape then dismisses it WITHOUT selecting anyone.
    let mentionOk = false;
    let mentionDetail = 'step not reached';
    let mentionFacts = null;
    try {
      await page.keyboard.press('Escape'); // the evidence analysis collapses back to the row
      const collapsedAgain = await waitFor(
        async () => ((await page.locator('#amplifyx-overlay-host [data-testid="amplifyx-overlay"]').count()) === 0 ? true : null),
        5_000,
      );
      // Focus the TEXTBOX to keep typing (never a post control). focus() — the sanctioned
      // read-only interaction, same as scripts/real-x-inspect.mjs — rather than a hit-tested
      // click: a click here races X's own composer chrome (actionability retries), while focus()
      // puts the caret in the editor deterministically.
      await composer.focus();
      await page.keyboard.press('End'); // caret to the end of the single-line draft
      await page.keyboard.type(' @amplifyx', { delay: 90 });
      // X's own mention-typeahead ROWS (observed live 2026-10-04: `typeaheadResult` items with
      // `TypeaheadUser` rows; the wrapped-container testids seen in earlier probes belong to the
      // search typeahead, not the composer dropdown).
      const typeaheadLoc = '[data-testid="typeaheadResult"]';
      const dropdownAppeared = await page
        .locator(typeaheadLoc)
        .first()
        .waitFor({ state: 'visible', timeout: 8_000 })
        .then(() => true, () => false);
      // An X-owned modal scrim (see the typing step) must not stand between the hit tests and
      // the dropdown: dismiss it with Escape first if it re-appeared, then require the dropdown
      // to still be open (Escape closes the dialog, NOT the composer's typeahead — if the
      // typeahead also closed, the step re-opens it by retyping the trailing '@' fragment).
      const maskAtDropdown = await maskFacts();
      if (maskAtDropdown !== null) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(800);
        console.log(`      note: X dialog scrim detected over the dropdown (${JSON.stringify(maskAtDropdown)}); Escape-dismissed: ${(await maskFacts()) === null}`);
        if ((await page.locator(typeaheadLoc).count()) === 0) {
          await page.keyboard.type('@amplifyx', { delay: 90 });
          await page.locator(typeaheadLoc).first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
        }
      }
      if (!collapsedAgain || !dropdownAppeared) {
        // Structural diagnostics only: presence facts + typeahead-ish testids (no page text).
        // Shadow-root content is read through shadowRoot so presence is honest.
        const diag = await page.evaluate(() => {
          const composer = document.querySelector('div[data-testid="tweetTextarea_0"]');
          const host = document.getElementById('amplifyx-overlay-host');
          const root = host?.shadowRoot ?? null;
          return {
            composerPresent: composer !== null,
            composerCharCount: composer === null ? null : (composer.textContent ?? '').length,
            overlayHostPresent: host !== null,
            expandedBlockPresent: root?.querySelector('[data-testid="amplifyx-overlay"]') !== null,
            rowPresent: root?.querySelector('[data-testid="amplifyx-overlay-row"]') !== null,
            typeaheadTestids: [...new Set([...document.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid') ?? '').filter((t) => /typeahead|dropdown|autocomplete/i.test(t)))].slice(0, 10),
          };
        });
        mentionDetail = `collapsed=${collapsedAgain === true} dropdownAppeared=${dropdownAppeared} diag=${JSON.stringify(diag)}`;
        await page.keyboard.press('Escape'); // never leave X's typeahead open for later steps
      } else {
        mentionFacts = await page.evaluate((loc) => {
          const overlapArea = (a, b) =>
            Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
            Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          const items = [...document.querySelectorAll(loc)];
          if (items.length === 0) return { found: false };
          // The dropdown's own tree: the items' common list container plus the items themselves.
          const container = items[0].parentElement;
          const inDropdownTree = (el) =>
            items.some((item) => item === el || item.contains(el)) ||
            (container !== null && (el === container || container.contains(el)));
          // Union box of every visible result row = the dropdown as the user sees it.
          let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
          for (const item of items) {
            const box = item.getBoundingClientRect();
            if (box.width <= 0 || box.height <= 0) continue;
            left = Math.min(left, box.left);
            top = Math.min(top, box.top);
            right = Math.max(right, box.right);
            bottom = Math.max(bottom, box.bottom);
          }
          const box = { left, top, right, bottom, width: right - left, height: bottom - top };
          const hostEl = document.getElementById('amplifyx-overlay-host');
          const rowEl = hostEl?.shadowRoot?.querySelector('[data-testid="amplifyx-overlay-row"]') ?? null;
          const rowBox = rowEl?.getBoundingClientRect() ?? null;
          const hostBox = hostEl?.getBoundingClientRect() ?? null;
          // Sample points: the union box's center and corners (inset), and — when an extension
          // surface's box intersects the dropdown's — that overlap's centroid, where only the
          // DROPDOWN being on top proves it is not occluded (X's own dropdown covering the row
          // is fine; the row covering X's dropdown is the defect).
          const points = [
            [box.left + box.width / 2, box.top + box.height / 2],
            [box.left + box.width * 0.1, box.top + box.height * 0.1],
            [box.right - box.width * 0.1, box.top + box.height * 0.1],
            [box.left + box.width * 0.1, box.bottom - box.height * 0.1],
            [box.right - box.width * 0.1, box.bottom - box.height * 0.1],
          ];
          for (const surface of [rowBox, hostBox]) {
            if (!surface || overlapArea(surface, box) <= 0) continue;
            const ix0 = Math.max(surface.left, box.left);
            const iy0 = Math.max(surface.top, box.top);
            const ix1 = Math.min(surface.right, box.right);
            const iy1 = Math.min(surface.bottom, box.bottom);
            points.push([(ix0 + ix1) / 2, (iy0 + iy1) / 2]);
          }
          const hits = points.map(([x, y]) => {
            const el = document.elementFromPoint(x, y);
            if (!el) return { verdict: 'outside-viewport' };
            const composedRoot = el.getRootNode();
            if (inDropdownTree(el) || (composedRoot !== document && inDropdownTree(composedRoot.host))) {
              return { verdict: 'dropdown' };
            }
            if (el.id === 'amplifyx-overlay-host' || el.id === 'amplifyx-marker-host' || el.hasAttribute('data-amplifyx-host')) {
              return { verdict: 'extension' };
            }
            // Structural identity of a foreign hit (tag + testid ONLY — never text/handles):
            // distinguishes X's own portal chrome from anything suspicious.
            return {
              verdict: 'other',
              tag: el.tagName?.toLowerCase() ?? 'null',
              testid: el.getAttribute?.('data-testid') ?? null,
              parentTestid: el.parentElement?.getAttribute?.('data-testid') ?? null,
            };
          });
          return {
            found: true,
            itemCount: items.length,
            boxLeft: box.left,
            boxTop: box.top,
            width: Math.round(box.width),
            height: Math.round(box.height),
            rowOverlap: rowBox ? Math.round(overlapArea(rowBox, box)) : 0,
            activeTestid: document.activeElement?.getAttribute?.('data-testid') ?? null,
            hits,
          };
        }, typeaheadLoc);
        const hitsOk = Array.isArray(mentionFacts.hits) && mentionFacts.hits.length > 0 && mentionFacts.hits.every((h) => h?.verdict === 'dropdown');
        mentionOk = mentionFacts.found === true && mentionFacts.width > 0 && mentionFacts.height > 0 && hitsOk;
        const hitSummary = (mentionFacts.hits ?? []).map((h) => (typeof h === 'string' ? h : h?.verdict === 'other' ? `other(${h.tag}/${h.testid ?? '-'})` : h?.verdict ?? '?'));
        mentionDetail = `items=${mentionFacts.itemCount} dropdown=${mentionFacts.width}x${mentionFacts.height} rowOverlap=${mentionFacts.rowOverlap} hitTests=[${hitSummary.join(',')}]`;
        // Evidence of the OPEN dropdown, clipped to it (the page-redaction stylesheet is already
        // applied), then dismiss it WITHOUT selecting anyone.
        const clipX = Math.max(0, mentionFacts.boxLeft - 8);
        const clipY = Math.max(0, mentionFacts.boxTop - 8);
        await page
          .screenshot({
            path: join(EVIDENCE_DIR, 'mention-typeahead-open-redacted.png'),
            clip: {
              x: clipX,
              y: clipY,
              width: Math.min(mentionFacts.width + 16, 1280 - clipX),
              height: Math.min(mentionFacts.height + 16, 1400 - clipY),
            },
          })
          .catch(() => {});
        await page.keyboard.press('Escape');
        // Dismissal: the dropdown either UNMOUNTS or goes hidden/empty (X has done both across
        // probes); accept the row count dropping to 0 OR no visible row remaining.
        const dismissed = await waitFor(
          async () => {
            const count = await page.locator(typeaheadLoc).count();
            const visible = count > 0 ? await page.locator(typeaheadLoc).first().isVisible().catch(() => false) : false;
            return count === 0 || !visible ? true : null;
          },
          5_000,
        );
        mentionOk = mentionOk && dismissed === true;
        mentionDetail += ` dismissed=${dismissed === true}`;
      }
    } catch (error) {
      const lines = String(error).split('\n').filter((line) => line.trim() !== '').slice(0, 3);
      mentionDetail = `error: ${lines.join(' | ').slice(0, 300)}`;
    }
    record('mention-autocomplete-not-occluded', mentionOk, mentionDetail);


    // ---- 4c. Clear-and-reset (m4-fix-real-site-clear-reset): the real editor performs
    // select-all deletion through its own DOM writes with NO input event (verified live
    // 2026-10-03: the clear produced childList mutations with the text dropping to empty and
    // zero beforeinput/input events), so the watcher must pick the reset up from composer
    // content mutations. Every overlay surface must disappear within a bounded window (~700ms
    // debounce + live-site margin), never stick to the last analyzed state.
    let draftCleared = false;
    let overlayReset = false;
    let resetDetail = '';
    try {
      await composer.focus();
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Backspace');
      draftCleared = await waitFor(async () => ((await composer.innerText()).trim() === '' ? true : null), 5_000, 250) ?? false;
      if (!draftCleared) {
        resetDetail = 'composer never confirmed empty — reset not assessable';
      } else {
        const clearedAt = Date.now();
        // Clearing removes EVERY extension surface near the composer (VAL-DRAFT-014/047) — there
        // is no empty state left behind, so the host itself must disappear.
        const reset = await waitFor(
          async () => ((await page.locator('#amplifyx-overlay-host').count()) === 0 ? 'no-ui' : null),
          10_000,
          300,
        );
        overlayReset = reset === 'no-ui';
        resetDetail = overlayReset
          ? `all overlay UI removed in ${Date.now() - clearedAt}ms (bounded window 10s)`
          : `overlay stuck with ${await page.locator('#amplifyx-overlay-host').count()} host(s) present for the full 10s window`;
      }
    } catch {
      draftCleared = false;
    }
    record(
      'draft-cleared-after-test',
      draftCleared,
      draftCleared ? 'composer restored to empty' : 'best-effort clear did not confirm (nothing was ever submitted; the temp profile is deleted)',
    );
    record('clear-resets-overlay', overlayReset, resetDetail || 'clear not confirmed; overlay reset not assessable');

    // ---- 6. Network assertions ----
    const jevCalls = network.filter((r) => r.host === 'api.typesafe.ai');
    const postSubmissions = network.filter((r) => POST_SUBMISSION.test(r.path));
    const graphqlOps = [...new Set(network.filter((r) => r.path.includes('/graphql/')).map((r) => r.path.split('/').pop() ?? ''))].sort();
    record('zero-jev-calls', jevCalls.length === 0, `api.typesafe.ai requests: ${jevCalls.length}`);
    record('zero-post-submissions', postSubmissions.length === 0, `post-submission requests: ${postSubmissions.length}`);
    console.log(`      graphql ops observed (read endpoints): ${graphqlOps.join(', ') || '(none)'}`);

    // ---- 7. Evidence (captured while the surfaces are still live, structural facts only;
    // redacted screenshots — the redaction stylesheet was applied before the clear step) ----
    writeFileSync(
      join(EVIDENCE_DIR, 'overlay-dom.json'),
      JSON.stringify(
        {
          rowPlacement: rowFacts,
          rowHeadline: rowHeadline.trim(),
          expandedBlockPresentWhileTyping: !expandedAbsentWhileTyping,
          blockState,
          headlineScore: Number.isInteger(headlineScore) ? headlineScore : null,
          chipCount,
          toolbarPushedDown,
          escapeCollapsed: escapeCollapsed === true,
          aiNotice: jevNotice,
          mention: mentionFacts,
        },
        null,
        2,
      ),
    );
    if (badgeCount > 0) {
      await page.locator('[data-amplifyx-host="badge"]').first().screenshot({ path: join(EVIDENCE_DIR, 'badge-redacted.png') }).catch(() => {});
      const badgeFacts = await page.evaluate(() => {
        for (const host of document.querySelectorAll('[data-amplifyx-host="badge"]')) {
          const button = host.shadowRoot?.querySelector('button[data-testid="amplifyx-target-badge"]');
          if (button) {
            return {
              postId: button.getAttribute('data-amplifyx-post-id'),
              chipText: (button.textContent ?? '').trim(),
              ariaLabel: button.getAttribute('aria-label'),
              inUserName: host.parentElement?.closest('[data-testid="User-Name"]') !== null,
            };
          }
        }
        return null;
      });
      writeFileSync(join(EVIDENCE_DIR, 'badge-dom.json'), JSON.stringify(badgeFacts, null, 2));
    }
    writeFileSync(join(EVIDENCE_DIR, 'network.json'), JSON.stringify(network, null, 2));
    writeFileSync(
      join(EVIDENCE_DIR, 'marker-diagnostics.json'),
      JSON.stringify(
        {
          watcherState: activation?.watcher ?? null,
          backgroundState: activation?.background ?? null,
          scannerScanCount: await markerHost.getAttribute('data-scanner-scan-count'),
          scannerPosts: await markerHost.getAttribute('data-scanner-posts'),
          scannerDispatches: await markerHost.getAttribute('data-scanner-dispatches'),
        },
        null,
        2,
      ),
    );

    // ---- 8. Session integrity: still logged in at the end ----
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const stillLoggedIn = await page
      .locator('div[data-testid="tweetTextarea_0"][role="textbox"][contenteditable="true"]')
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true, () => false);
    const cookieNames = (await context.cookies('https://x.com/')).map((c) => c.name); // NAMES only
    record(
      'session-integrity',
      stillLoggedIn && cookieNames.includes('auth_token') && cookieNames.includes('ct0') && !/\/i\/flow|\/login/.test(new URL(page.url()).pathname),
      `final state: composer=${stillLoggedIn ? 'visible' : 'absent'} sessionCookies=${cookieNames.includes('auth_token') && cookieNames.includes('ct0') ? 'present' : 'missing'} url=${new URL(page.url()).pathname}`,
    );

    const failed = results.filter((r) => !r.pass);
    writeFileSync(
      join(EVIDENCE_DIR, 'summary.json'),
      JSON.stringify({ result: failed.length === 0 ? 'pass' : 'fail', draft: SMOKE_DRAFT, effectiveThreshold, steps: results }, null, 2),
    );
    console.log(failed.length === 0 ? 'RESULT: pass' : `RESULT: fail (${failed.length} failed step(s))`);
    process.exitCode = failed.length === 0 ? 0 : 4;
  } catch (error) {
    console.log('RESULT: error');
    console.log(String(error).split('\n').slice(0, 5).join('\n'));
    process.exitCode = 1;
  } finally {
    if (context) await context.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
}

main();
