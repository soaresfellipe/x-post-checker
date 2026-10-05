/**
 * ONE-OFF read-only real-x.com DROPDOWN-STACKING probe (m6 insertion probe follow-up): the
 * focused companion to `real-x-insertion-probe.mjs` — inserts the same 36px probe host
 * immediately before the home composer's `[data-testid="toolBar"]`, then opens X's OWN
 * @mention typeahead using the VERIFIED m5 recipe (composer.focus() + End + type ' @amplifyx',
 * delay 90) and hit-tests whether the dropdown draws OVER the in-flow probe element.
 * STRUCTURAL FACTS ONLY. Typing permitted; NEVER clicks Post or any post control. mkdtemp
 * profile deleted in a finally. Expired/challenged session -> exit 3.
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
  const profile = mkdtempSync(join(tmpdir(), 'amplifyx-dropdown-probe-'));
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
    await composer.click();
    const toolBar = page.locator('[data-testid="toolBar"]').first();
    if (!(await toolBar.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false))) {
      console.log('RESULT: no-toolbar-on-home');
      process.exitCode = 4;
      return;
    }
    // Insert the probe host (same shape as the insertion probe, pinned node).
    await page.evaluate((probeId) => {
      const bar = [...document.querySelectorAll('[data-testid="toolBar"]')].find((t) => t.getBoundingClientRect().height > 0);
      const host = document.createElement('div');
      host.id = probeId;
      host.dataset.probePinned = '1';
      host.style.cssText = 'height:36px;display:block;border-top:1px solid rgba(0,0,0,.1);pointer-events:none;';
      const inner = document.createElement('div');
      inner.style.cssText = 'height:36px;display:flex;align-items:center;font:13px/16px system-ui;';
      inner.textContent = 'AmplifyX probe row';
      host.append(inner);
      bar.parentElement.insertBefore(host, bar);
    }, PROBE_HOST_ID);

    await page.keyboard.type(DRAFT, { delay: 10 });
    await page.waitForTimeout(500);
    // The VERIFIED m5 mention recipe: focus + End + slow partial-handle typing.
    await composer.focus();
    await page.keyboard.press('End');
    await page.keyboard.type(' @amplifyx', { delay: 90 });

    let dropdownOpen = false;
    for (let i = 0; i < 60 && !dropdownOpen; i += 1) {
      dropdownOpen = await page.evaluate(() => {
        const row = document.querySelector('[data-testid="typeaheadResult"]');
        return Boolean(row && row.getBoundingClientRect().height > 0);
      });
      if (!dropdownOpen) await page.waitForTimeout(250);
    }
    const result = { dropdownOpen, ...(await page.evaluate((probeId) => {
      const dropdown = document.querySelector('[data-testid="typeaheadResult"]');
      const host = document.getElementById(probeId);
      const base = {
        overlap: null, hitTop: null, hitIsDropdown: null, hitIsProbeHost: null,
        dropdownChain: [], probeChain: [], typeaheadTestidsSeen: [], probeStillInPlace: null,
      };
      const bar = [...document.querySelectorAll('[data-testid="toolBar"]')].find((t) => t.getBoundingClientRect().height > 0);
      base.probeStillInPlace = Boolean(host && bar && host.nextElementSibling === bar);
      if (!dropdown || !host) {
        base.typeaheadTestidsSeen = [...document.querySelectorAll('[data-testid]')]
          .map((e) => e.getAttribute('data-testid'))
          .filter((t) => /typeahead|dropdown|autocomplete|user/i.test(t ?? ''))
          .slice(0, 30);
        return base;
      }
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
      if (!overlaps) return { ...base, overlap: false, dropdownChain: describeChain(dropdown), probeChain: describeChain(host), dropdownBox: { t: Math.round(dr.top), h: Math.round(dr.height) }, hostBox: { t: Math.round(hr.top), h: Math.round(hr.height) } };
      const x = (Math.max(dr.left, hr.left) + Math.min(dr.right, hr.right)) / 2;
      const y = (Math.max(dr.top, hr.top) + Math.min(dr.bottom, hr.bottom)) / 2;
      const top = document.elementFromPoint(x, y);
      return {
        ...base,
        overlap: true,
        overlapPoint: { x: Math.round(x), y: Math.round(y) },
        hitTop: top ? `${top.tagName.toLowerCase()}${top.getAttribute('data-testid') ? `[${top.getAttribute('data-testid')}]` : ''}` : null,
        hitIsDropdown: Boolean(top && (top.closest('[data-testid="typeaheadResult"]') || top.closest('[data-testid="TypeaheadUser"]'))),
        hitIsProbeHost: top?.id === probeId || Boolean(top?.closest?.(`#${probeId}`)),
        dropdownChain: describeChain(dropdown),
        probeChain: describeChain(host),
        dropdownBox: { t: Math.round(dr.top), h: Math.round(dr.height) },
        hostBox: { t: Math.round(hr.top), h: Math.round(hr.height) },
      };
    }, PROBE_HOST_ID)) };
    console.log('DROPDOWN STACKING:', JSON.stringify(result, null, 1));
    writeFileSync(join(EVIDENCE_DIR, 'dropdown-stacking.json'), JSON.stringify(result, null, 2));
    // Dismiss the dropdown (Escape — never a selection) and clear the draft.
    if (dropdownOpen) await page.keyboard.press('Escape');
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(400);
    console.log('RESULT: dropdown-probe-complete');
  } finally {
    await context?.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('PROBE ERROR:', error);
  process.exitCode = 1;
});
