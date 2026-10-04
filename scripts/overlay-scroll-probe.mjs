/**
 * ONE-OFF live root-cause probe for m5-overlay-scroll-reach (read-only, real x.com).
 *
 * Question: with the expanded panel taller than the available space, what actually happens
 * when the user wheels over it on the real site? The fixture E2E only ever asserted
 * overflowY:auto + scrollHeight>clientHeight — never a real wheel-to-the-end.
 *
 * Strictly read-only per AGENTS.md: navigating, reading the DOM, focusing the composer
 * textbox, typing a synthetic draft, clicking the EXTENSION-OWNED pill, wheeling. The Post
 * button and every post control are never touched; the draft is cleared at the end.
 * Cookie-backed mkdtemp profile, deleted in a finally on every path. No key in the profile,
 * so AI is structurally off (zero api.typesafe.ai requests expected and asserted).
 */
import { chromium } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXTENSION_DIR = join(REPO, '.output', 'chrome-mv3');
const EVIDENCE_DIR = join(REPO, 'test-results', 'overlay-scroll-probe');

const DRAFT =
  'Testing AmplifyX scroll behavior on a real timeline: does this draft earn a score, and can the panel scroll to its very end? #smoketest';

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

const network = [];
function recordRequest(request) {
  try {
    const url = new URL(request.url());
    network.push({ method: request.method(), host: url.host, path: url.pathname });
  } catch {
    network.push({ method: request.method(), host: '(unparsed)', path: '' });
  }
}

async function waitFor(poll, timeoutMs, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await poll();
      if (value) return value;
    } catch {
      /* keep polling */
    }
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Geometry + scroll state of the panel, the region it anchors to, and the page. */
async function snapshot(page) {
  return page.evaluate(() => {
    const host = document.querySelector('#amplifyx-overlay-host');
    const panel = host?.shadowRoot?.querySelector('[data-testid="amplifyx-overlay"]');
    const composer = document.querySelector('div[data-testid="tweetTextarea_0"]');
    const container = composer?.closest('[data-testid$="RichTextInputContainer"]');
    const region = container?.parentElement ?? composer?.parentElement ?? null;
    const rect = (e) => {
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height };
    };
    const style = panel ? getComputedStyle(panel) : null;
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight, scrollY: window.scrollY },
      host: rect(host),
      panel: rect(panel),
      panelScroll: panel
        ? {
            scrollTop: panel.scrollTop,
            scrollHeight: panel.scrollHeight,
            clientHeight: panel.clientHeight,
            maxHeight: style.maxHeight,
            overflowY: style.overflowY,
            pointerEvents: style.pointerEvents,
          }
        : null,
      region: rect(region),
      regionTag: region ? `${region.tagName.toLowerCase()}${region.id ? `#${region.id}` : ''}` : null,
      // Occlusion witnesses: the real-site composer furniture the panel must never cover.
      postButton: rect(document.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')),
      dialog: rect(document.querySelector('[role="dialog"]')),
      counter: rect(document.querySelector('[role="progressbar"]')),
      typeahead: rect(document.querySelector('[data-testid="typeaheadDropdownWrapped-10"], [data-testid="DropdownWrapper-1"]')),
      wheelLog: (window.__wheelProbe ?? []).slice(-8),
    };
  });
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
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'amplifyx-scroll-probe-'));
  let context;
  const findings = { steps: [], snapshots: [] };
  const note = (step, detail) => {
    findings.steps.push({ step, detail });
    console.log(`-- ${step}: ${detail}`);
  };
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      // REALISTIC SHORT viewport: 800px tall forces the VAL-DRAFT-023 cap. The m4 smoke used
      // 1400px specifically so the panel always fit — which is why it never saw this bug.
      viewport: { width: Number(process.env.PROBE_W) || 1280, height: Number(process.env.PROBE_H) || 800 },
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
      timeout: 45_000,
    });
    context.on('request', recordRequest);
    context.on('pageerror', (error) => note('page-error', String(error).slice(0, 200)));

    await context.addCookies([
      { name: 'auth_token', value: authToken, domain: '.x.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'ct0', value: ct0, domain: '.x.com', path: '/', secure: true, sameSite: 'Lax' },
    ]);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);

    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const composer = page.locator('div[data-testid="tweetTextarea_0"][role="textbox"][contenteditable="true"]');
    if (!(await composer.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false))) {
      console.log('RESULT: session-challenged');
      process.exitCode = 3;
      return;
    }
    note('session', 'logged-in home composer visible');

    // Type the synthetic draft (allowed; NEVER submitted). Only the pill must exist while typing.
    await composer.click();
    await page.keyboard.type(DRAFT, { delay: 12 });
    const pill = page.locator('#amplifyx-overlay-host [data-testid="amplifyx-overlay-pill"]');
    const pillAppeared = await pill.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false);
    note('pill', pillAppeared ? `visible, text="${(await pill.innerText()).trim()}"` : 'NOT visible');
    await page.screenshot({ path: join(EVIDENCE_DIR, '1-collapsed-pill.png'), style: REDACTION_STYLESHEET });
    // The PILL's own occlusion geometry (collapsed state): the pill is the host's whole box here.
    const pillGeo = await snapshot(page);
    findings.snapshots.push({ label: 'collapsed-pill', geo: pillGeo });
    const boxOverlap = (a, b) =>
      !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    note(
      'pill-occlusion',
      `pillOverPost=${boxOverlap(pillGeo.host, pillGeo.postButton)} pillOverCounter=${boxOverlap(pillGeo.host, pillGeo.counter)} ` +
        `pill=${JSON.stringify(pillGeo.host)} post=${JSON.stringify(pillGeo.postButton)} counter=${JSON.stringify(pillGeo.counter)}`,
    );

    // Expand through the pill (extension-owned control).
    await pill.click();
    const panel = page.locator('#amplifyx-overlay-host [data-testid="amplifyx-overlay"]');
    const state = await waitFor(async () => {
      const s = await panel.getAttribute('data-state');
      return s === 'analyzed' ? s : null;
    }, 15_000);
    note('panel', `expanded, state=${state}`);
    const initial = await snapshot(page);
    findings.snapshots.push({ label: 'expanded-initial', geo: initial });
    // Occlusion check: does the expanded panel's box overlap the real-site composer furniture?
    const overlap = (a, b) =>
      !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const occ = overlap(initial.panel, initial.postButton);
    note(
      'occlusion',
      `panelOverPostButton=${occ} panelOverCounter=${overlap(initial.panel, initial.counter)} ` +
        `postButton=${JSON.stringify(initial.postButton)} region=${JSON.stringify(initial.region)} ` +
        `regionTag=${initial.regionTag} dialog=${JSON.stringify(initial.dialog)}`,
    );

    // Install the wheel probe: a window-level BUBBLE listener runs AFTER the overlay's
    // document-level listener, so `defaultPrevented` tells us whether the redirect claimed it.
    await page.evaluate(() => {
      window.__wheelProbe = [];
      window.addEventListener(
        'wheel',
        (event) => {
          window.__wheelProbe.push({
            x: event.clientX,
            y: event.clientY,
            deltaY: event.deltaY,
            defaultPrevented: event.defaultPrevented,
          });
        },
        { passive: true },
      );
    });

    // Wheel over the panel center in realistic notches until the end or no progress.
    const panelBox = await panel.boundingBox();
    if (!panelBox) throw new Error('panel has no box');
    const cx = panelBox.x + panelBox.width / 2;
    const cy = panelBox.y + Math.min(panelBox.height / 2, 200);
    const trace = [];
    for (let i = 0; i < 14; i += 1) {
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(150);
      const geo = await snapshot(page);
      trace.push({ i, scrollTop: geo.panelScroll?.scrollTop, scrollY: geo.viewport.scrollY, wheel: geo.wheelLog });
      const ps = geo.panelScroll;
      if (ps && ps.scrollTop + ps.clientHeight >= ps.scrollHeight - 1) break;
    }
    findings.snapshots.push({ label: 'after-wheel-sequence', geo: await snapshot(page) });
    findings.wheelTrace = trace;
    const last = trace[trace.length - 1];
    const first = trace[0];
    note(
      'wheel-result',
      `scrollTop ${String(first?.scrollTop)} -> ${String(last?.scrollTop)} after ${trace.length} wheels; ` +
        `lastWheelDefaultPrevented=${String(last?.wheel?.at(-1)?.defaultPrevented)}; pageScrollY=${String(last?.scrollY)}`,
    );

    // ---- ROOT-CAUSE INSTRUMENTATION --------------------------------------
    // Stamp the panel element, observe the shadow panel-root for childList replacements, poll
    // scrollTop/identity/revision every 250ms, and record the host's settingsRevision (a bump =
    // a storage change drove overlay.onSettings -> render -> replaceChildren).
    findings.idleMonitor = await page.evaluate(async () => {
      const host = document.querySelector('#amplifyx-overlay-host');
      const panelRoot = host?.shadowRoot?.querySelector('.panel-root');
      const panel = host?.shadowRoot?.querySelector('[data-testid="amplifyx-overlay"]');
      if (!panel || !panelRoot) return { error: 'panel missing' };
      window.__panel0 = panel;
      const events = [];
      const shObs = new MutationObserver((records) => {
        for (const r of records) {
          events.push({
            t: Date.now(),
            kind: 'panel-root-childList',
            removed: r.removedNodes.length,
            added: r.addedNodes.length,
            sameAsStamped: r.removedNodes.length > 0 && Array.prototype.includes.call(r.removedNodes, window.__panel0),
          });
        }
      });
      shObs.observe(panelRoot, { childList: true });
      const samples = [];
      const start = Date.now();
      const startTop = panel.scrollTop;
      while (Date.now() - start < 9000) {
        await new Promise((r) => setTimeout(r, 250));
        const h = document.querySelector('#amplifyx-overlay-host');
        const p = h?.shadowRoot?.querySelector('[data-testid="amplifyx-overlay"]');
        samples.push({
          t: Date.now(),
          scrollTop: p?.scrollTop ?? null,
          isStampedPanel: p === window.__panel0,
          stampedConnected: window.__panel0.isConnected,
          settingsRevision: h?.dataset?.settingsRevision ?? null,
          expanded: h?.dataset?.expanded ?? null,
        });
        if (p && p.scrollTop !== startTop && samples.filter((s) => s.scrollTop !== startTop).length === 1) {
          events.push({ t: Date.now(), kind: 'scrollTop-first-change', from: startTop, to: p.scrollTop });
        }
      }
      shObs.disconnect();
      const current = document.querySelector('#amplifyx-overlay-host')?.shadowRoot?.querySelector('[data-testid="amplifyx-overlay"]');
      return {
        startTop,
        endTop: current?.scrollTop ?? null,
        stampedStillConnected: window.__panel0.isConnected,
        stampedIsCurrent: current === window.__panel0,
        panelRootChildListEvents: events,
        scrollTopSamples: samples,
      };
    });
    note(
      'idle-monitor',
      `stampedStillConnected=${findings.idleMonitor.stampedStillConnected} stampedIsCurrent=${findings.idleMonitor.stampedIsCurrent} ` +
        `startTop=${findings.idleMonitor.startTop} endTop=${findings.idleMonitor.endTop} ` +
        `childListEvents=${JSON.stringify(findings.idleMonitor.panelRootChildListEvents)}`,
    );
    if (findings.idleMonitor.scrollTopSamples) {
      const changedAt = findings.idleMonitor.scrollTopSamples.filter((s, i, a) => i === 0 || s.scrollTop !== a[i - 1].scrollTop);
      note('scrollTop-changes', JSON.stringify(changedAt));
    }

    // Is the panel's LAST element fully visible now?
    const lastVisible = await page.evaluate(() => {
      const panel = document
        .querySelector('#amplifyx-overlay-host')
        ?.shadowRoot?.querySelector('[data-testid="amplifyx-overlay"]');
      if (!panel) return null;
      const last = panel.lastElementChild;
      if (!last) return null;
      const b = last.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      return {
        tag: last.tagName,
        testid: last.getAttribute('data-testid') ?? last.className,
        rect: { top: b.top, bottom: b.bottom },
        panelBottom: p.bottom,
        viewportH: window.innerHeight,
        fullyInsideViewport: b.bottom <= window.innerHeight && b.top >= 0,
        fullyInsidePanel: b.bottom <= p.bottom + 1,
      };
    });
    findings.lastElementVisible = lastVisible;
    note('last-element', JSON.stringify(lastVisible));
    await page.screenshot({ path: join(EVIDENCE_DIR, '2-after-wheel-end.png'), style: REDACTION_STYLESHEET });

    // Churn check: does the scrollTop drift back while the site mutates (idle 8s, no input)?
    await page.waitForTimeout(8_000);
    const afterIdle = await snapshot(page);
    findings.snapshots.push({ label: 'after-idle-8s', geo: afterIdle });
    note('idle-drift', `scrollTop after 8s idle: ${String(afterIdle.panelScroll?.scrollTop)}`);

    // Wheel back up, then small trackpad-like deltas down again (second pass must also reach the end).
    for (let i = 0; i < 10; i += 1) {
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, -400);
    }
    await page.waitForTimeout(150);
    const backTop = await snapshot(page);
    note('wheel-up', `scrollTop back at top: ${String(backTop.panelScroll?.scrollTop)}`);
    for (let i = 0; i < 40; i += 1) {
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, 40);
      await page.waitForTimeout(30);
      const done = await page.evaluate(() => {
        const panel = document
          .querySelector('#amplifyx-overlay-host')
          ?.shadowRoot?.querySelector('[data-testid="amplifyx-overlay"]');
        return !!panel && panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 1;
      });
      if (done) break;
    }
    const secondPass = await snapshot(page);
    findings.snapshots.push({ label: 'second-pass-end', geo: secondPass });
    note(
      'second-pass',
      `scrollTop=${String(secondPass.panelScroll?.scrollTop)} clientHeight=${String(secondPass.panelScroll?.clientHeight)} scrollHeight=${String(secondPass.panelScroll?.scrollHeight)}`,
    );
    await page.screenshot({ path: join(EVIDENCE_DIR, '3-second-pass-end.png'), style: REDACTION_STYLESHEET });

    // Clean up: collapse the panel (Escape), refocus the composer, clear the draft (keyboard
    // only — the real site's chrome intercepts clicks on the composer).
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const composer = document.querySelector('div[data-testid="tweetTextarea_0"]');
      if (composer instanceof HTMLElement) composer.focus();
    });
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    const cleared = await waitFor(async () => (await page.locator('#amplifyx-overlay-host').count()) === 0, 10_000);
    note('clear', cleared ? 'overlay removed after clear' : 'overlay STILL present after clear (best effort)');

    const jevCalls = network.filter((r) => r.host === 'api.typesafe.ai').length;
    note('network', `api.typesafe.ai requests: ${jevCalls} (expected 0 — no key in profile)`);
    writeFileSync(join(EVIDENCE_DIR, 'findings.json'), JSON.stringify(findings, null, 2));
    writeFileSync(
      join(EVIDENCE_DIR, 'network.json'),
      JSON.stringify(network.filter((r) => r.host === 'api.typesafe.ai' || /createtweet|createnotetweet/i.test(r.path)), null, 2),
    );
    console.log('RESULT: probe-complete');
  } finally {
    await context?.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('PROBE ERROR:', error);
  process.exitCode = 1;
});
