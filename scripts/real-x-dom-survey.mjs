/**
 * ONE-OFF read-only real-x.com DOM survey for m5-overlay-scroll-reach: after typing the
 * synthetic draft (never submitted), dump the composer editor's ANCESTOR CHAIN and the Post
 * button's ancestor chain (tags + data-testids + rects, structural facts only — no text
 * content), plus their lowest common ancestor. Cookie-backed mkdtemp profile deleted in a
 * finally. No clicks on any post control; the draft is cleared at the end.
 */
import { chromium } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXTENSION_DIR = join(REPO, '.output', 'chrome-mv3');
const EVIDENCE_DIR = join(REPO, 'test-results', 'overlay-scroll-probe');
const DRAFT =
  'Testing AmplifyX scroll behavior on a real timeline: does this draft earn a score, and can the panel scroll to its very end? #smoketest';

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
  const profile = mkdtempSync(join(tmpdir(), 'amplifyx-dom-survey-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1280, height: 800 },
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
      timeout: 45_000,
    });
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
    await composer.click();
    await page.keyboard.type(DRAFT, { delay: 12 });
    // Wait for the expanded composer's Post button to exist (the furniture row we care about).
    const postButton = page
      .locator('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]')
      .first();
    const postVisible = await postButton.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
    console.log('post-button-visible:', postVisible);

    const survey = await page.evaluate(() => {
      const describe = (e) => {
        const b = e.getBoundingClientRect();
        const tid = e.getAttribute('data-testid');
        return `${e.tagName.toLowerCase()}${tid ? `[data-testid="${tid}"]` : ''} rect{t:${Math.round(b.top)},b:${Math.round(b.bottom)},l:${Math.round(b.left)},r:${Math.round(b.right)},h:${Math.round(b.height)}}`;
      };
      const chain = (element) => {
        const out = [];
        for (let e = element; e && e !== document.body; e = e.parentElement) out.push(describe(e));
        return out;
      };
      const editor = document.querySelector('div[data-testid="tweetTextarea_0"]');
      const container = editor?.closest('[data-testid$="RichTextInputContainer"]');
      const regionFn = container?.parentElement ?? null;
      const post =
        [...document.querySelectorAll('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]')].find(
          (b) => b.getBoundingClientRect().height > 0,
        ) ?? null;
      // Lowest common ancestor of container and Post button:
      const anc = (e) => {
        const set = [];
        for (let a = e; a; a = a.parentElement) set.push(a);
        return set;
      };
      const postAncestors = post ? anc(post) : [];
      const common = container ? anc(container).find((a) => postAncestors.includes(a)) ?? null : null;
      return {
        editorChain: chain(editor),
        containerChain: chain(container),
        regionChain: chain(regionFn),
        regionChainFromContainer: container && regionFn ? [container, ...Array.from({ length: 6 }, (_, i) => {
          let e = container.parentElement;
          for (let k = 0; k < i && e; k += 1) e = e.parentElement;
          return e;
        }).filter(Boolean).map(describe)] : [],
        postButton: post ? describe(post) : null,
        postButtonChain: post ? chain(post) : null,
        lowestCommonAncestor: common ? describe(common) : null,
        toolBarPresent: document.querySelector('[data-testid="toolBar"]') !== null,
      };
    });
    writeFileSync(join(EVIDENCE_DIR, 'dom-survey.json'), JSON.stringify(survey, null, 2));
    console.log(JSON.stringify(survey, null, 1));

    // Cleanup: clear the draft.
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    console.log('RESULT: survey-complete');
  } finally {
    await context?.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('SURVEY ERROR:', error);
  process.exitCode = 1;
});
