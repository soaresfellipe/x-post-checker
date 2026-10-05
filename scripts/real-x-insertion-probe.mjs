/**
 * ONE-OFF read-only real-x.com INSERTION probe for m6-theme-foundation-and-realx-probe: insert a
 * probe host element as the immediate preceding sibling of `[data-testid="toolBar"]` in the home
 * composer AND in a status-page reply composer (navigated to by URL, never by clicking a post),
 * and observe:
 *   (a) survival across React re-renders while typing/clearing (detach/move counts, re-attach need),
 *   (b) layout: does the composer grow and push the toolbar down cleanly,
 *   (c) stacking of X's @mention dropdown relative to the inserted in-flow element,
 *   (d) body backgroundColor representation (inline style vs computed) and body style-attribute
 *       mutations observed while X re-renders; night_mode cookie variant tried client-side,
 *   (e) User-Name structure / time link shape for badge insertion.
 * STRUCTURAL FACTS ONLY (no handles, no post text, no cookies in evidence). Typing is permitted;
 * NEVER clicks Post or any post control; never attaches media. Cookie-backed mkdtemp profile is
 * deleted in a finally covering BOTH paths. Expired/challenged session -> exit 3.
 */
import { chromium } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EVIDENCE_DIR = join(REPO, 'evidence', 'm6-insertion-probe');
const PROBE_HOST_ID = 'amplifyx-probe-host';
const DRAFT =
  'Testing AmplifyX insertion behavior on a real composer: does an in-flow sibling before the toolbar survive typing? #probes';
// Client-side theme-preference cookie hint (our own ephemeral session profile; X renders the
// body background from it without any account-state write — verified per-variant below).
const NIGHT_MODE_VARIANTS = [null, '1', '2'];

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
  const profile = mkdtempSync(join(tmpdir(), 'amplifyx-insertion-probe-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1280, height: 800 },
      timeout: 45_000,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);

    // ---------- (d) theme representation: default + night_mode cookie variants ----------
    const themeFacts = { variants: [], bodyStyleMutationsDuringUse: 0 };
    for (const nightMode of NIGHT_MODE_VARIANTS) {
      const cookies = [
        { name: 'auth_token', value: authToken, domain: '.x.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
        { name: 'ct0', value: ct0, domain: '.x.com', path: '/', secure: true, sameSite: 'Lax' },
      ];
      if (nightMode !== null) cookies.push({ name: 'night_mode', value: nightMode, domain: '.x.com', path: '/', secure: true, sameSite: 'Lax' });
      await context.clearCookies();
      await context.addCookies(cookies);
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const body = await page.evaluate(() => ({
        computed: getComputedStyle(document.body).backgroundColor,
        inlineStyle: document.body.style.cssText,
        inlineBg: document.body.style.backgroundColor || null,
        bodyClass: document.body.className,
        htmlClass: document.documentElement.className,
      }));
      themeFacts.variants.push({ nightMode, ...body });
    }
    console.log('THEME VARIANTS:', JSON.stringify(themeFacts.variants, null, 1));

    // Re-load WITHOUT the night_mode hint so the rest of the probe runs on the account's default.
    await context.clearCookies();
    await context.addCookies([
      { name: 'auth_token', value: authToken, domain: '.x.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'ct0', value: ct0, domain: '.x.com', path: '/', secure: true, sameSite: 'Lax' },
    ]);
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const composer = page.locator('div[data-testid="tweetTextarea_0"][role="textbox"][contenteditable="true"]');
    if (!(await composer.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false))) {
      console.log('RESULT: session-challenged');
      process.exitCode = 3;
      return;
    }

    // Instrument body style-attribute mutations for the WHOLE rest of the run: any X-side rewrite
    // of body style during normal use is exactly what the ThemeDetector observer must catch.
    await page.evaluate(() => {
      window.__probeBodyStyleMutations = 0;
      window.__probeBodyStyleSamples = [];
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.type !== 'attributes' || record.attributeName !== 'style') continue;
          window.__probeBodyStyleMutations += 1;
          if (window.__probeBodyStyleSamples.length < 10) {
            window.__probeBodyStyleSamples.push({
              inlineBg: document.body.style.backgroundColor || null,
              cssText: document.body.style.cssText,
            });
          }
        }
      }).observe(document.body, { attributes: true, attributeFilter: ['style'] });
    });

    // ---------- home composer: expand, measure, insert, measure ----------
    await composer.click();
    const toolBar = page.locator('[data-testid="toolBar"]').first();
    if (!(await toolBar.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false))) {
      console.log('RESULT: no-toolbar-on-home');
      process.exitCode = 4;
      return;
    }
    const homeFacts = await probeOneComposer(page);
    console.log('HOME FACTS:', JSON.stringify(homeFacts, null, 1));

    // ---------- (a) survival across typing / clearing ----------
    await page.keyboard.type(DRAFT, { delay: 10 });
    await page.waitForTimeout(800);
    const duringTyping = await survivalSnapshot(page);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(600);
    const afterClear = await survivalSnapshot(page);
    await page.keyboard.type('One more pass', { delay: 10 });
    await page.waitForTimeout(600);
    await page.keyboard.type(' @', { delay: 60 });

    // ---------- (c) @mention dropdown stacking ----------
    let dropdownOpen = false;
    for (let i = 0; i < 48 && !dropdownOpen; i += 1) {
      dropdownOpen = await page.evaluate(() => {
        const row = document.querySelector('[data-testid="typeaheadResult"]');
        return Boolean(row && row.getBoundingClientRect().height > 0);
      });
      if (!dropdownOpen) await page.waitForTimeout(250);
    }
    let dropdownStacking = { dropdownOpen, overlap: null, hitTop: null, hitIsDropdown: null, hitIsProbeHost: null, dropdownChain: [], probeChain: [], typeaheadTestidsSeen: [] };
    if (!dropdownOpen) {
      // Diagnostic (structural only): which typeahead-ish testids exist at all right now?
      dropdownStacking.typeaheadTestidsSeen = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid]')]
          .map((e) => e.getAttribute('data-testid'))
          .filter((t) => /typeahead|dropdown|autocomplete/i.test(t ?? ''))
          .slice(0, 20),
      );
    } else {
      dropdownStacking = { dropdownOpen, ...(await stackingProbe(page)) };
      await page.keyboard.press('Escape');
    }
    console.log('DROPDOWN STACKING:', JSON.stringify(dropdownStacking, null, 1));
    const afterDropdown = await survivalSnapshot(page);

    // Clear the draft completely, then capture the body-style mutation counts.
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(400);
    const afterFinalClear = await survivalSnapshot(page);
    themeFacts.bodyStyleMutationsDuringUse = await page.evaluate(() => window.__probeBodyStyleMutations);
    const bodyStyleSamples = await page.evaluate(() => window.__probeBodyStyleSamples);

    // ---------- (e) User-Name structure for badge insertion ----------
    const userNameFacts = await page.evaluate(() => {
      const name = document.querySelector('article [data-testid="User-Name"]');
      if (!name) return { present: false };
      const describe = (e) => {
        const link = e.closest('a');
        const href = link ? link.getAttribute('href') || '' : '';
        const time = e.querySelector('time');
        return {
          tag: e.tagName.toLowerCase(),
          testid: e.getAttribute('data-testid'),
          hrefShape: href ? href.replace(/\/[A-Za-z0-9_]{1,20}\/status\//, '/<handle>/status/').replace(/^\/([A-Za-z0-9_]{1,20})(\/|$)/, '/<handle>$1') : null,
          hasTime: Boolean(time),
          childCount: e.children.length,
        };
      };
      return {
        present: true,
        childCount: name.children.length,
        children: [...name.children].map(describe),
        // Deepest path that holds the <time> element (the badge inserts after the time link).
        timeChain: (() => {
          const time = name.querySelector('time');
          if (!time) return null;
          const chain = [];
          for (let e = time; e && e !== name; e = e.parentElement) chain.push(describe(e));
          return chain.reverse();
        })(),
        instances: document.querySelectorAll('article [data-testid="User-Name"]').length,
      };
    });
    console.log('USER-NAME STRUCTURE:', JSON.stringify(userNameFacts, null, 1));

    // ---------- reply composer (status page, navigated by URL — no post clicks) ----------
    const statusPath = await page.evaluate(() => {
      for (const a of document.querySelectorAll('article a[href*="/status/"]')) {
        const href = a.getAttribute('href') || '';
        if (/^\/[A-Za-z0-9_]{1,20}\/status\/\d+\/?$/.test(href)) return href;
      }
      return null;
    });
    let replyFacts = { statusPageReached: false, reason: 'no-status-link-visible' };
    if (statusPath) {
      await page.goto(`https://x.com${statusPath}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const replyComposer = page.locator('div[data-testid="tweetTextarea_0"][role="textbox"][contenteditable="true"]');
      const replyReached = await replyComposer.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false);
      if (!replyReached) {
        replyFacts = { statusPageReached: false, reason: 'no-reply-composer' };
      } else {
        await replyComposer.click();
        const replyToolBar = page.locator('[data-testid="toolBar"]').last();
        const replyToolBarVisible = await replyToolBar.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
        if (!replyToolBarVisible) {
          replyFacts = { statusPageReached: true, toolBarPresent: false };
        } else {
          replyFacts = { statusPageReached: true, ...(await probeOneComposer(page)) };
          await page.keyboard.type('Reply-side insertion probe draft.', { delay: 10 });
          await page.waitForTimeout(800);
          replyFacts.survivalDuringTyping = await survivalSnapshot(page);
          await page.keyboard.press('Control+A');
          await page.keyboard.press('Backspace');
          await page.waitForTimeout(400);
          replyFacts.survivalAfterClear = await survivalSnapshot(page);
        }
      }
    }
    console.log('REPLY FACTS:', JSON.stringify(replyFacts, null, 1));

    const summary = {
      probedAt: new Date().toISOString(),
      viewport: '1280x800',
      themeFacts,
      bodyStyleSamples,
      home: {
        ...homeFacts,
        survivalDuringTyping: duringTyping,
        survivalAfterClear: afterClear,
        dropdownStacking,
        survivalAfterDropdown: afterDropdown,
        survivalAfterFinalClear: afterFinalClear,
      },
      userName: userNameFacts,
      reply: replyFacts,
    };
    writeFileSync(join(EVIDENCE_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log('RESULT: probe-complete');
  } finally {
    await context?.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
}

/** Insert the probe host immediately before the visible toolBar and measure the layout effect. */
async function probeOneComposer(page) {
  return page.evaluate((probeId) => {
    const describe = (e) => {
      if (!e) return null;
      const b = e.getBoundingClientRect();
      const tid = e.getAttribute && e.getAttribute('data-testid');
      return `${e.tagName.toLowerCase()}${tid ? `[data-testid="${tid}"]` : ''} rect{t:${Math.round(b.top)},h:${Math.round(b.height)}}`;
    };
    const toolBar = [...document.querySelectorAll('[data-testid="toolBar"]')].find((t) => t.getBoundingClientRect().height > 0);
    if (!toolBar) return { toolBarPresent: false };
    const editor = document.querySelector('div[data-testid^="tweetTextarea_"][role="textbox"][contenteditable="true"]');
    const anc = (e) => { const out = []; for (let a = e; a; a = a.parentElement) out.push(a); return out; };
    const toolBarAncestors = anc(toolBar);
    const composerBlock = editor ? anc(editor).find((a) => toolBarAncestors.includes(a)) ?? null : null;
    const blockBefore = composerBlock ? composerBlock.getBoundingClientRect() : null;
    const barBefore = toolBar.getBoundingClientRect();
    const barStyleBefore = toolBar.getAttribute('style');
    const prevSibling = toolBar.previousElementSibling;

    // Insert: in-flow block, 36px, mirrors the Design 1b host (border-top, no pointer events).
    const host = document.createElement('div');
    host.id = probeId;
    host.dataset.probePinned = '1'; // pin NOW: any later snapshot reading the pin holds the same node
    host.style.cssText = 'height:36px;display:block;border-top:1px solid rgba(0,0,0,.1);pointer-events:none;';
    const inner = document.createElement('div');
    inner.style.cssText = 'height:36px;display:flex;align-items:center;font:13px/16px system-ui;';
    inner.textContent = 'AmplifyX probe row';
    host.append(inner);
    toolBar.parentElement.insertBefore(host, toolBar);

    // Watchdog: record every detachment/move of the probe host (or removal of its anchor
    // toolbar) from THIS moment on — the re-attach frequency the observer must match.
    window.__probeEvents = [];
    window.__probeLastState = 'inserted';
    setInterval(() => {
      const h = document.getElementById(probeId);
      const bar = [...document.querySelectorAll('[data-testid="toolBar"]')].find((t) => t.getBoundingClientRect().height > 0) ?? null;
      const state = h
        ? bar && h.nextElementSibling === bar
          ? 'in-place'
          : 'in-dom-misplaced'
        : 'detached';
      if (state !== window.__probeLastState) {
        window.__probeEvents.push({ at: Date.now(), from: window.__probeLastState, to: state });
        window.__probeLastState = state;
      }
    }, 100);

    const barAfter = toolBar.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const blockAfter = composerBlock ? composerBlock.getBoundingClientRect() : null;
    const overlaps = (a, b) => !(a.bottom <= b.top || a.top >= b.bottom || a.right <= b.left || a.left >= b.right);
    const deltas = {
      toolBarTopDelta: Math.round((barAfter.top - barBefore.top) * 10) / 10,
      toolBarHeightDelta: Math.round((barAfter.height - barBefore.height) * 10) / 10,
      composerBlockHeightDelta: blockBefore && blockAfter ? Math.round((blockAfter.height - blockBefore.height) * 10) / 10 : null,
      hostHeight: Math.round(hostRect.height),
    };
    return {
      toolBarPresent: true,
      toolBarDescribe: describe(toolBar),
      composerBlockDescribe: describe(composerBlock),
      prevSiblingDescribe: describe(prevSibling),
      insertion: {
        inserted: document.getElementById(probeId) === host,
        parentIsComposerBlock: composerBlock ? host.parentElement === composerBlock : host.parentElement === toolBar.parentElement,
      },
      layout: {
        deltas,
        overlap: { withToolBar: overlaps(hostRect, barAfter), withEditor: editor ? overlaps(hostRect, editor.getBoundingClientRect()) : null },
        barStyleChanged: toolBar.getAttribute('style') !== barStyleBefore,
      },
    };
  }, PROBE_HOST_ID);
}

/** Sample probe-host survival: connected? still the same node? still before the toolBar? */
async function survivalSnapshot(page) {
  return page.evaluate((probeId) => {
    const host = document.getElementById(probeId);
    const toolBar = [...document.querySelectorAll('[data-testid="toolBar"]')].find((t) => t.getBoundingClientRect().height > 0) ?? null;
    return {
      hostInDom: host !== null,
      sameNodeAsInserted: Boolean(host && host.dataset.probePinned === '1'),
      immediatelyBeforeToolBar: Boolean(host && toolBar && host.nextElementSibling === toolBar),
      parentIsToolBarParent: Boolean(host && toolBar && host.parentElement === toolBar.parentElement),
      toolBarStillPresent: toolBar !== null,
      detachEvents: (window.__probeEvents ?? []).slice(),
    };
  }, PROBE_HOST_ID);
}

/** (c) Does X's mention dropdown draw OVER the in-flow probe element? */
async function stackingProbe(page) {
  return page.evaluate((probeId) => {
    const dropdown = document.querySelector('[data-testid="typeaheadResult"]');
    const host = document.getElementById(probeId);
    if (!dropdown || !host) return { overlap: null, hitTop: null, hitIsDropdown: null, dropdownChain: [], probeChain: [] };
    const dr = dropdown.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const overlaps = !(dr.bottom <= hr.top || dr.top >= hr.bottom || dr.right <= hr.left || dr.left >= hr.right);
    const describeChain = (e) => {
      const out = [];
      for (let a = e && e.parentElement; a && a !== document.body; a = a.parentElement) {
        const tid = a.getAttribute('data-testid');
        out.push(`${a.tagName.toLowerCase()}${tid ? `[${tid}]` : ''}`);
      }
      return out.slice(0, 6);
    };
    if (!overlaps) return { overlap: false, hitTop: null, hitIsDropdown: null, hitIsProbeHost: null, dropdownChain: describeChain(dropdown), probeChain: describeChain(host) };
    const x = (Math.max(dr.left, hr.left) + Math.min(dr.right, hr.right)) / 2;
    const y = (Math.max(dr.top, hr.top) + Math.min(dr.bottom, hr.bottom)) / 2;
    const top = document.elementFromPoint(x, y);
    return {
      overlap: true,
      overlapPoint: { x: Math.round(x), y: Math.round(y) },
      hitTop: top ? `${top.tagName.toLowerCase()}${top.getAttribute('data-testid') ? `[${top.getAttribute('data-testid')}]` : ''}` : null,
      hitIsDropdown: Boolean(top && (top.closest('[data-testid="typeaheadResult"]') || top.closest('[data-testid="TypeaheadUser"]'))),
      hitIsProbeHost: top?.id === probeId || Boolean(top?.closest?.(`#${probeId}`)),
      dropdownChain: describeChain(dropdown),
      probeChain: describeChain(host),
    };
  }, PROBE_HOST_ID);
}

main().catch((error) => {
  console.error('PROBE ERROR:', error);
  process.exitCode = 1;
});
