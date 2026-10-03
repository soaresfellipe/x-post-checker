/**
 * Real x.com READ-ONLY smoke test (automated Chrome leg, authorized for m4-real-x-smoke).
 *
 * What it proves on the LOGGED-IN real x.com, with the RELEASE extension build loaded:
 *   1. the content script activates (marker mounts, background connected, composer watched);
 *   2. reply-target badges appear on eligible timeline posts (default threshold first; if the
 *      live timeline has none, the threshold is lowered through the REAL Options UI — the
 *      contract's "configured threshold" — and the timeline re-gated);
 *   3. typing a synthetic draft shows the score overlay with a local score (NEVER submitted);
 *   4. clearing the draft (select-all + Backspace) resets the overlay to the empty/hidden state
 *      within a bounded window (m4-fix-real-site-clear-reset — the real editor performs the
 *      deletion through its own DOM writes with NO input event, so the watcher must pick the
 *      reset up from composer content mutations);
 *   5. an extension-owned badge click opens the popover WITHOUT activating/navigating the post;
 *   6. ZERO requests to api.typesafe.ai (fresh profile = no key = AI structurally off);
 *   7. ZERO post-submission requests (CreateTweet/…); the session stays logged in at the end.
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
 * Evidence dir: $REALX_EVIDENCE_DIR (default <repo>/test-results/real-x-smoke, gitignored).
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
  : join(REPO, 'test-results', 'real-x-smoke');

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
      viewport: { width: 1280, height: 1400 }, // tall: the overlay panel must fit for evidence
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

    // ---- 4. Draft overlay on a typed synthetic draft (NEVER submitted) ----
    await composer.click(); // focus the composer TEXTBOX (not a post control) to expand it
    await page.keyboard.type(SMOKE_DRAFT, { delay: 12 });
    const panel = page.locator('#amplifyx-overlay-host [data-testid="amplifyx-overlay"]');
    const panelAppeared = await panel.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false);
    const panelState = panelAppeared
      ? await waitFor(async () => {
          const state = await page.locator('#amplifyx-overlay-host [data-testid="amplifyx-overlay"]').getAttribute('data-state');
          return state === 'analyzed' ? 'analyzed' : null;
        }, 15_000)
      : null;
    const headline = panelAppeared
      ? await page.locator('#amplifyx-overlay-host [data-testid="overlay-headline"]').innerText().catch(() => '')
      : '';
    const headlineScore = Number.parseInt(headline, 10);
    const signalCount = panelAppeared
      ? await page.locator('#amplifyx-overlay-host [data-testid="overlay-signals"] li').count()
      : 0;
    const jevNotice = panelAppeared
      ? await page.locator('#amplifyx-overlay-host [data-testid="overlay-jev-notice"]').innerText().catch(() => '')
      : '';
    record(
      'draft-overlay-score',
      panelState === 'analyzed' && Number.isInteger(headlineScore) && headlineScore >= 0 && headlineScore <= 100 && signalCount > 0,
      `state=${panelState ?? 'n/a'} headline=${Number.isInteger(headlineScore) ? headlineScore : 'n/a'} signals=${signalCount} aiNotice="${jevNotice.slice(0, 60)}"`,
    );
    record(
      'draft-ai-off-local-only',
      jevNotice.startsWith('Local signals only'),
      'no key in this profile: the overlay shows the local-only notice (AI structurally off)',
    );

    // Evidence of the analyzed panel BEFORE the clear (redacted), then the clear-and-reset step.
    await page.addStyleTag({ content: REDACTION_STYLESHEET });
    await page
      .locator('#amplifyx-overlay-host')
      .screenshot({ path: join(EVIDENCE_DIR, 'overlay-analyzed-redacted.png') })
      .catch(() => {});

    // ---- 4b. Clear-and-reset (m4-fix-real-site-clear-reset): the real editor performs
    // select-all deletion through its own DOM writes with NO input event (verified live
    // 2026-10-03: the clear produced childList mutations with the text dropping to empty and
    // zero beforeinput/input events), so the watcher must pick the reset up from composer
    // content mutations. The overlay must leave the analyzed state for the empty/hidden state
    // within a bounded window (~700ms debounce + live-site margin), never stick.
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
        const reset = await waitFor(async () => {
          const panel = page.locator('#amplifyx-overlay-host [data-testid="amplifyx-overlay"]');
          if ((await panel.count()) === 0) return 'hidden'; // overlay unmounted: also a reset
          const state = await panel.getAttribute('data-state');
          return state === 'empty' ? 'empty' : null;
        }, 10_000, 300);
        overlayReset = reset === 'empty' || reset === 'hidden';
        resetDetail = overlayReset
          ? `overlay reset to ${reset} in ${Date.now() - clearedAt}ms (bounded window 10s)`
          : `overlay stuck at state=${(await page.locator('#amplifyx-overlay-host [data-testid="amplifyx-overlay"]').getAttribute('data-state').catch(() => 'host-gone')) ?? 'n/a'} for the full 10s window`;
        await page
          .locator('#amplifyx-overlay-host')
          .screenshot({ path: join(EVIDENCE_DIR, 'overlay-after-clear-redacted.png') })
          .catch(() => {});
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

    // ---- 5. Extension-owned badge click -> popover, WITHOUT activating the post ----
    if (badgeCount > 0) {
      const urlBefore = page.url();
      await page.locator('button[data-testid="amplifyx-target-badge"]').first().click();
      const popoverAppeared = await page
        .locator('#amplifyx-target-popover-host [data-testid="amplifyx-target-popover"]')
        .waitFor({ state: 'visible', timeout: 8_000 })
        .then(() => true, () => false);
      const popoverAi = popoverAppeared
        ? await page.locator('#amplifyx-target-popover-host [data-testid="amplifyx-popover-ai-notice"]').innerText().catch(() => '')
        : '';
      record(
        'badge-click-popover-no-navigation',
        popoverAppeared && page.url() === urlBefore,
        `popover=${popoverAppeared ? 'opened' : 'absent'} urlUnchanged=${page.url() === urlBefore} aiNotice="${popoverAi.slice(0, 60)}"`,
      );
      if (popoverAppeared) {
        await page.locator('#amplifyx-target-popover-host [data-testid="amplifyx-popover-close"]').click();
      }
    }

    // ---- 6. Network assertions ----
    const jevCalls = network.filter((r) => r.host === 'api.typesafe.ai');
    const postSubmissions = network.filter((r) => POST_SUBMISSION.test(r.path));
    const graphqlOps = [...new Set(network.filter((r) => r.path.includes('/graphql/')).map((r) => r.path.split('/').pop() ?? ''))].sort();
    record('zero-jev-calls', jevCalls.length === 0, `api.typesafe.ai requests: ${jevCalls.length}`);
    record('zero-post-submissions', postSubmissions.length === 0, `post-submission requests: ${postSubmissions.length}`);
    console.log(`      graphql ops observed (read endpoints): ${graphqlOps.join(', ') || '(none)'}`);

    // ---- 7. Evidence (captured while the surfaces are still live, structural facts only;
    // redacted screenshots — the redaction stylesheet was applied before the clear step) ----
    if (panelAppeared) {
      await page.locator('#amplifyx-overlay-host').screenshot({ path: join(EVIDENCE_DIR, 'overlay-redacted.png') }).catch(() => {});
      writeFileSync(
        join(EVIDENCE_DIR, 'overlay-dom.json'),
        JSON.stringify({ panelState, headlineScore: Number.isInteger(headlineScore) ? headlineScore : null, signalCount, aiNotice: jevNotice }, null, 2),
      );
    }
    if (badgeCount > 0) {
      await page.locator('button[data-testid="amplifyx-target-badge"]').first().screenshot({ path: join(EVIDENCE_DIR, 'badge-redacted.png') }).catch(() => {});
      const badgeFacts = await page.evaluate(() => {
        for (const host of document.querySelectorAll('[data-amplifyx-host]')) {
          const button = host.shadowRoot?.querySelector('button[data-testid="amplifyx-target-badge"]');
          if (button) {
            return { postId: button.getAttribute('data-amplifyx-post-id'), badgeHtml: button.outerHTML };
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
