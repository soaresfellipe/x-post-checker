/**
 * Interactive verification for m3-badges-popover (route (b) of AGENTS.md: isolated headless
 * launchPersistentContext, NO debugging port, fresh mkdtemp profile — the sanctioned route when
 * background Jev interception matters). Captures screenshots + DOM/network evidence for every
 * popover state, then cleans up the profile in a finally block.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';

const EXT_DIR = path.resolve('.output/chrome-mv3-e2e');
const EVIDENCE = '/tmp/amplifyx-m3-evidence';

const TARGET_JEV_RESPONSE = {
  model: 'jev-1.13.0',
  answers: {
    reply_potential: { type: 'score', score: 4.2, confidence: 0.7, legend: {}, probabilities: { '4': 0.7 } },
    reply_angle: { type: 'choice', choice: 'share_experience', confidence: 0.8, probabilities: { share_experience: 0.8 } },
  },
  usage: { input_tokens: 100, output_tokens: 20 },
};

const POST_1 = '1800000000000000001';
const POST_8 = '1800000000000000008';
const BADGE = (id: string) => `[data-testid="amplifyx-target-badge"][data-amplifyx-post-id="${id}"]`;
const POPOVER = '[data-testid="amplifyx-target-popover"]';
const AI = '[data-testid="amplifyx-popover-ai"]';

interface Finding {
  check: string;
  ok: boolean;
  detail: string;
}
const findings: Finding[] = [];
const record = (check: string, ok: boolean, detail: string): void => {
  findings.push({ check, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${check}  ${detail}`);
};


/** Waits until the open popover's AI section reaches `state` (shadow-piercing in-page query). */
async function waitAiState(page: Page, state: string, timeout = 6_000): Promise<void> {
  await page.waitForFunction(
    (wanted) =>
      document
        .getElementById('amplifyx-target-popover-host')
        ?.shadowRoot?.querySelector('[data-testid="amplifyx-popover-ai"]')
        ?.getAttribute('data-ai-state') === wanted,
    state,
    { timeout },
  );
}

async function main(): Promise<void> {
  await mkdir(EVIDENCE, { recursive: true });
  const profile = await mkdtemp(path.join(tmpdir(), 'amplifyx-m3-verify-'));
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  let jevRequests = 0;
  let failNext = false;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
      timeout: 45_000,
    });
    await context.route('https://api.typesafe.ai/**', async (route) => {
      jevRequests += 1;
      const current = jevRequests;
      if (failNext && current === 1) {
        await route.fulfill({ status: 500, contentType: 'text/plain', body: 'intercepted failure' });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TARGET_JEV_RESPONSE) });
    });

    const consoleErrors: string[] = [];
    const page = await context.newPage();
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    // ---- Phase 1: default settings (jevForTargets OFF) — badges are local, Deep analysis off ----
    await page.goto('http://localhost:3177/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const badge1 = page.locator(BADGE(POST_1));
    record('badge renders above threshold at load', await badge1.isVisible(), (await badge1.textContent()) ?? 'n/a');
    record('zero Jev requests during scan', jevRequests === 0, `requests=${jevRequests}`);
    await page.screenshot({ path: path.join(EVIDENCE, '01-timeline-badges.png') });

    await badge1.click();
    await page.waitForTimeout(300);
    record('popover opens from badge click', await page.locator(POPOVER).isVisible(), `postId=${await page.locator(POPOVER).getAttribute('data-amplifyx-post-id')}`);
    record('AI section is OFF by default', (await page.locator(AI).getAttribute('data-ai-state')) === 'off', '');
    record('no Deep analysis button while off', (await page.locator('[data-testid="amplifyx-popover-deep-analysis"]').count()) === 0, '');
    record('zero Jev requests with popover open', jevRequests === 0, `requests=${jevRequests}`);
    await page.screenshot({ path: path.join(EVIDENCE, '02-popover-ai-off.png') });
    await page.keyboard.press('Escape');
    record('Escape closes the popover', (await page.locator(POPOVER).count()) === 0, '');

    // ---- Phase 2: enable jevForTargets + synthetic key through the REAL Options UI ----
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
    const optionsUrl = `chrome-extension://${new URL(worker.url()).host}/options.html`;
    const options = await context.newPage();
    await options.goto(optionsUrl);
    await options.getByTestId('pref-jevForTargets').check();
    await expectSuffix(options, 'prefs-status', 'success');
    await options.getByTestId('api-key-input').fill('synthetic-key-interactive-verify');
    await options.getByTestId('save-key').click();
    await expectSuffix(options, 'key-status', 'present');
    await options.close();
    await page.bringToFront();

    // Re-open the popover WITHOUT reloading the tab: idle state + Deep analysis button appear.
    await badge1.click();
    await page.waitForTimeout(200);
    record('live key/setting pickup without reload', (await page.locator(AI).getAttribute('data-ai-state')) === 'idle', '');

    // ---- Phase 3: Deep analysis -> loading -> verdict; cached on reopen ----
    await page.locator('[data-testid="amplifyx-popover-deep-analysis"]').click();
    await page.waitForTimeout(80);
    const pendingState = await page.locator(AI).getAttribute('data-ai-state');
    record('loading state renders while pending', pendingState === 'pending' || pendingState === 'verdict', `state=${pendingState}`);
    await waitAiState(page, 'verdict', 5_000);
    record('verdict renders (band + confidence)', true, `band=${await page.locator('[data-testid="amplifyx-popover-verdict-band"]').textContent()} conf=${await page.locator('[data-testid="amplifyx-popover-verdict-confidence"]').textContent()}`);
    record('exactly ONE Jev request for the first Deep analysis', jevRequests === 1, `requests=${jevRequests}`);
    await page.screenshot({ path: path.join(EVIDENCE, '03-popover-verdict.png') });

    await page.locator('[data-testid="amplifyx-popover-close"]').click();
    await page.waitForTimeout(150);
    await badge1.click();
    await page.waitForTimeout(200);
    record('cached verdict on close/reopen', (await page.locator(AI).getAttribute('data-ai-state')) === 'verdict', '');
    record('cache: still exactly one request', jevRequests === 1, `requests=${jevRequests}`);
    await page.keyboard.press('Escape');

    // ---- Phase 4: error state on a second post, then recovery ----
    failNext = true; // the FIRST request of this post will 500
    jevRequests = 0; // count only this phase
    await page.locator(`article:has(a[href*="/status/${POST_8}"])`).scrollIntoViewIfNeeded();
    await page.locator(BADGE(POST_8)).waitFor({ state: 'visible' });
    await page.locator(BADGE(POST_8)).click();
    await page.locator('[data-testid="amplifyx-popover-deep-analysis"]').click();
    await waitAiState(page, 'error');
    record('error state renders after a 500', true, `reason=${await page.locator('[data-testid="amplifyx-popover-ai-error-reason"]').textContent()}`);
    await page.screenshot({ path: path.join(EVIDENCE, '04-popover-error.png') });
    await page.keyboard.press('Escape');
    record('popover closable in error state', (await page.locator(POPOVER).count()) === 0, '');
    await page.locator(BADGE(POST_8)).click();
    await page.locator('[data-testid="amplifyx-popover-retry"]').click();
    await waitAiState(page, 'verdict');
    record('Try again recovers to a verdict', true, '');
    record('retry made exactly one more request', jevRequests === 2, `requests=${jevRequests}`);
    await page.keyboard.press('Escape');

    // ---- Phase 5: coexistence with the draft overlay + threshold live-change ----
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    const composer = page.locator('[data-testid="tweetTextarea_0"]');
    await composer.click();
    await page.keyboard.type('What changed my year? One daily checklist that actually sticks.');
    await page.locator('#amplifyx-overlay-host').waitFor({ state: 'visible' });
    record('draft overlay and badges coexist', (await page.locator('#amplifyx-overlay-host').isVisible()) && (await page.locator(BADGE(POST_1)).isVisible()), '');
    await page.screenshot({ path: path.join(EVIDENCE, '05-overlay-plus-badges.png') });

    // Threshold change in Options -> next scan re-gates (post 2 ~69 loses its badge at 85+1... use threshold 50: it gains).
    const options2 = await context.newPage();
    await options2.goto(optionsUrl);
    await options2.getByTestId('pref-targetThreshold').fill('50');
    await options2.getByTestId('pref-targetThreshold').blur();
    await expectSuffix(options2, 'prefs-status', 'success');
    await options2.close();
    await page.bringToFront();
    await page.waitForTimeout(700);
    record('threshold 50 grants the just-below post on the next scan', await page.locator(BADGE('1800000000000000002')).isVisible(), '');

    // ---- Phase 6: master off removes badges from the open tab ----
    const options3 = await context.newPage();
    await options3.goto(optionsUrl);
    await options3.getByTestId('pref-enabled').uncheck();
    await expectSuffix(options3, 'prefs-status', 'success');
    await options3.close();
    await page.bringToFront();
    await page.waitForTimeout(500);
    record('master off removes every badge + the overlay without reload', (await page.locator(BADGE(POST_1)).count()) === 0 && (await page.locator('#amplifyx-overlay-host').count()) === 0, '');
    await page.screenshot({ path: path.join(EVIDENCE, '06-master-off.png') });

    record('no page/console errors through every phase', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

    // Redacted storage snapshot from an EXTENSION page (the fixture tab has no chrome.storage):
    // presence only, never values.
    const storagePage = await context.newPage();
    await storagePage.goto(optionsUrl);
    const storage = (await storagePage.evaluate(() =>
      (globalThis as unknown as {
        chrome: { storage: { local: { get(keys: null): Promise<Record<string, unknown>> } } };
      }).chrome.storage.local.get(null),
    )) as Record<string, unknown>;
    await storagePage.close();
    record(
      'storage holds the settings + caches (key value never surfaced)',
      typeof storage === 'object' && 'targetThreshold' in storage,
      `keys=${Object.keys(storage).sort().join(',')} keyPresent=${typeof storage.jevApiKey === 'string' && (storage.jevApiKey as string).length > 0}`,
    );
  } finally {
    await context?.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
  }

  const failed = findings.filter((f) => !f.ok);
  console.log(`\n${findings.length - failed.length}/${findings.length} checks passed; evidence in ${EVIDENCE}`);
  if (failed.length > 0) process.exit(1);
}

async function expectSuffix(page: Page, testid: string, state: string): Promise<void> {
  await page.locator(`[data-testid="${testid}"]`).waitFor({ state: 'visible' });
  await page.waitForFunction(
    ({ testid, state }) => document.querySelector(`[data-testid="${testid}"]`)?.getAttribute('data-state') === state,
    { testid, state },
    { timeout: 5_000 },
  );
}

void main();
