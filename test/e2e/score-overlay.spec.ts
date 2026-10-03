import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, FIXTURE_URL, optionsUrl, popupUrl, test } from './extension';
import { VERIFIED_JEV_RESPONSE } from '../helpers/jev-fixtures';

/**
 * ScoreOverlay E2E on the x.com fixture (fixture-controlled Jev responses via route
 * interception, plus ONE live-API test gated on JEV_API_KEY). Covers the m2-score-overlay
 * assertions: empty/awaiting below the minimum (VAL-DRAFT-005), local-before-Jev independence
 * (VAL-DRAFT-006), the six algorithm signals (VAL-DRAFT-007), async verdict addition
 * (VAL-DRAFT-008), the band table (VAL-DRAFT-009), pending state (VAL-DRAFT-010), stale-response
 * discard (VAL-DRAFT-011), clear-to-empty reset (VAL-DRAFT-014), Connect Jev with no key
 * (VAL-DRAFT-017), failure degradation (VAL-DRAFT-018), jevForDrafts off (VAL-DRAFT-021),
 * composer/posting non-interference (VAL-DRAFT-022), resize repositioning (VAL-DRAFT-023), the
 * master-switch broadcast (VAL-SETUP-016) and settings-without-reload (VAL-CROSS-002).
 */

const SYNTHETIC_KEY = 'key-overlay-e2e-0001';
const HOME_COMPOSER = '[data-testid="tweetTextarea_0"]';
const OVERLAY_HOST = '#amplifyx-overlay-host';
const POST_BUTTON = '[data-testid="tweetButtonInline"]';
const MEDIA_BUTTON = '[data-testid="addMedia"]';

type JevAnswer =
  | { action: 'fulfill'; body: unknown }
  | { action: 'park'; body: unknown }
  | { action: 'abort' }
  | { action: 'status'; status: number; text: string };

interface CapturedJevCall {
  url: string;
  method: string;
  body: string;
  /** The request's `state` field (draft text + context block). */
  state: string;
}

/**
 * Intercepts every api.typesafe.ai request from ANY context (including the background worker)
 * and answers per `respond`. `park` holds the response until the test releases it — the Jev
 * client's own 10s full-response timeout bounds how long a parked call may stay unanswered.
 */
async function interceptJev(
  context: BrowserContext,
  respond: (call: { index: number; state: string }) => JevAnswer,
): Promise<{ calls: CapturedJevCall[]; parked: Array<{ release: () => void }> }> {
  const calls: CapturedJevCall[] = [];
  const parked: Array<{ release: () => void }> = [];
  await context.route('https://api.typesafe.ai/**', async (route) => {
    const request = route.request();
    const rawBody = request.postData() ?? '';
    let state: string;
    try {
      state = String((JSON.parse(rawBody) as { state: string }).state);
    } catch {
      state = '';
    }
    const index = calls.length;
    calls.push({ url: request.url(), method: request.method(), body: rawBody, state });
    const answer = respond({ index, state });
    if (answer.action === 'park') {
      await new Promise<void>((release) => parked.push({ release }));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer.body) });
      return;
    }
    if (answer.action === 'abort') {
      await route.abort('connectionreset');
      return;
    }
    if (answer.action === 'status') {
      await route.fulfill({ status: answer.status, contentType: 'text/plain', body: answer.text });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer.body) });
  });
  return { calls, parked };
}

/** A verified-shape Jev response with a chosen ordinal/confidence/weakness. */
function jevResponse(overrides: { ordinal: number; confidence?: number; weakness?: string }): unknown {
  const base = JSON.parse(JSON.stringify(VERIFIED_JEV_RESPONSE)) as {
    answers: Record<string, Record<string, unknown>>;
  };
  const score = base.answers.viral_potential!;
  score.score = overrides.ordinal;
  score.confidence = overrides.confidence ?? 0.71;
  const choice = base.answers.main_weakness!;
  choice.choice = overrides.weakness ?? 'weak_hook';
  return base;
}

const BANDS = ['Weak', 'Weak', 'Below avg', 'Moderate', 'Strong', 'Exceptional'] as const;

/** Opens Options and saves the synthetic key through the real UI + background write path. */
async function saveKeyViaOptions(context: BrowserContext, key: string = SYNTHETIC_KEY): Promise<Page> {
  const options = await context.newPage();
  await options.goto(await optionsUrl(context));
  await expect(options.getByTestId('key-status')).not.toBeEmpty();
  await options.getByTestId('api-key-input').fill(key);
  await options.getByTestId('save-key').click();
  await expect(options.getByTestId('key-status')).toHaveAttribute('data-state', 'present');
  return options;
}

/** Opens the fixture and waits for the watcher to be live. */
async function openFixture(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#amplifyx-marker-host')).toHaveAttribute('data-watcher-state', 'watching');
  return page;
}

/** Collects console errors and uncaught page errors for the no-uncaught-error assertions. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}

/**
 * Clears the composer (select-all + backspace) and types `text`, so sequential drafts in one
 * test are independent (a leftover previous draft would change the draft hash and the request
 * state). The stale-discard test types its continuation directly instead.
 */
async function typeDraft(page: Page, text: string): Promise<void> {
  await page.locator(HOME_COMPOSER).click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text);
}

const panelOf = (page: Page) => page.getByTestId('amplifyx-overlay');

test.describe('score overlay states', () => {
  test('shows the empty/awaiting state below the minimum length with no score and no request (VAL-DRAFT-005)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    const page = await openFixture(context);
    await expect(panelOf(page)).toHaveAttribute('data-state', 'empty');
    await expect(page.getByTestId('overlay-empty')).toContainText('Type a post to see its viral-potential score.');

    await typeDraft(page, '123456789'); // 9 raw chars; default minDraftLength is 10
    await page.waitForTimeout(1_200); // past the ~700ms debounce
    await expect(panelOf(page)).toHaveAttribute('data-state', 'empty');
    await expect(page.getByTestId('overlay-gauge')).toHaveCount(0);
    await expect(page.getByTestId('overlay-signals')).toHaveCount(0);
    expect(calls).toHaveLength(0); // no Jev request for a below-minimum draft
  });

  test('renders the local score and breakdown while the Jev response is held pending, then adds the verdict (VAL-DRAFT-006, VAL-DRAFT-010, VAL-DRAFT-008)', async ({ context }) => {
    const draft = 'What is the one tool you stopped using this year, and why?';
    const { calls, parked } = await interceptJev(context, ({ state }) =>
      state.startsWith(draft) ? { action: 'park', body: jevResponse({ ordinal: 3.44, confidence: 0.65 }) } : { action: 'fulfill', body: jevResponse({ ordinal: 1 }) },
    );
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, draft);
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
    expect(parked).toHaveLength(1); // the Jev response is deliberately held pending

    // The local 0-100 score renders WITHOUT waiting for Jev: local headline + pending AI half.
    await expect(panelOf(page)).toHaveAttribute('data-state', 'analyzed');
    await expect(page.getByTestId('overlay-gauge')).toHaveAttribute('data-headline-source', 'local');
    await expect(page.getByTestId('overlay-headline')).toHaveText(/^(?:[0-9]|[1-9][0-9]|100)$/);
    await expect(page.getByTestId('overlay-signals')).toContainText('Algorithm signals');
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'pending');
    await expect(page.getByTestId('overlay-jev-pending')).toContainText('Analyzing with AI');

    // Release: the verdict is added asynchronously, beside the unchanged local breakdown.
    parked[0]!.release();
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict');
    await expect(page.getByTestId('overlay-jev-band')).toHaveText('Moderate');
    await expect(page.getByTestId('overlay-jev-confidence')).toHaveText('Confidence: 65%');
    await expect(page.getByTestId('overlay-gauge')).toHaveAttribute('data-headline-source', 'hybrid');
    await expect(page.getByTestId('overlay-signals')).toContainText('Algorithm signals'); // never relabeled
    await expect(page.getByTestId('overlay-jev')).toContainText('AI judgment');
    await expect(page.getByTestId('overlay-jev-weaknesses')).not.toBeEmpty();
  });

  test('explains the local score with the six concrete algorithm signals (VAL-DRAFT-007)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    const errors = collectErrors(page);
    await typeDraft(page, 'What changed my year? One daily checklist. #focus #systems https://example.com/post');
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);

    const signals = page.getByTestId('overlay-signals');
    await expect(signals.locator('h3')).toHaveText('Algorithm signals');
    for (const id of ['reply-magnet', 'length', 'hashtags', 'external-link', 'media', 'reply-mutual']) {
      const row = signals.locator(`li[data-signal-id="${id}"]`);
      await expect(row).toHaveCount(1);
      await expect(row.locator('.value')).not.toBeEmpty();
      await expect(row.locator('.label')).not.toBeEmpty();
    }
    await expect(signals.locator('li[data-signal-id="hashtags"] .value')).toContainText('2');
    expect(errors).toEqual([]);
  });

  test('maps every exact rubric ordinal to its band label and never as a percentage (VAL-DRAFT-009)', async ({ context }) => {
    const ordinals = [0, 1, 2, 3, 4, 5];
    const { calls } = await interceptJev(context, ({ index }) => ({
      action: 'fulfill',
      body: jevResponse({ ordinal: ordinals[Math.min(index, ordinals.length - 1)]!, confidence: 0.71 }),
    }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);

    for (let index = 0; index < ordinals.length; index += 1) {
      const ordinal = ordinals[index]!;
      await typeDraft(page, `Band check draft number ${index}: the ordinal should map to ${BANDS[index]}`);
      await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(index + 1);
      await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict');
      await expect(page.getByTestId('overlay-jev-band')).toHaveText(BANDS[index]!);
      await expect(page.getByTestId('overlay-jev-confidence')).toHaveText('Confidence: 71%');
      // The ordinal is never presented as a probability or percentage (no "20%", "40%", ...).
      const ordinalPercent = Math.round((ordinal / 5) * 100);
      const jevText = await page.getByTestId('overlay-jev').innerText();
      expect(jevText).not.toMatch(new RegExp(`(^|[^0-9])${ordinalPercent}([^0-9]|$)`));
    }
  });

  test('discards a stale reply: the verdict for the newest draft wins even when the older response lands last (VAL-DRAFT-011)', async ({ context }) => {
    const draftA = 'Draft A: what is your favorite database and why does it matter?';
    // Draft B extends A (typing more), so the most-specific check wins in the responder below.
    const draftB = draftA + ' and what made you finally drop the spreadsheets for good?';
    const { calls, parked } = await interceptJev(context, ({ state }) => {
      if (state.startsWith(draftB)) return { action: 'fulfill', body: jevResponse({ ordinal: 4.5, confidence: 0.8, weakness: 'no_major_weakness' }) };
      if (state.startsWith(draftA)) return { action: 'park', body: jevResponse({ ordinal: 0, confidence: 0.9, weakness: 'weak_hook' }) };
      return { action: 'fulfill', body: jevResponse({ ordinal: 1 }) };
    });
    await saveKeyViaOptions(context);
    const page = await openFixture(context);

    await typeDraft(page, draftA);
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
    expect(parked).toHaveLength(1); // draft A's response is held

    // Keep typing WITHOUT clearing: the caret sits at the end of draft A, so the draft becomes B.
    await page.keyboard.press('End');
    await page.keyboard.type(draftB.slice(draftA.length));
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(2);
    await expect(page.getByTestId('overlay-jev-band')).toHaveText('Exceptional'); // B settled first

    parked[0]!.release(); // A's stale response arrives LAST
    await page.waitForTimeout(500); // give the late reply time to (be discarded)
    await expect(page.getByTestId('overlay-jev-band')).toHaveText('Exceptional');
    const jevText = await page.getByTestId('overlay-jev').innerText();
    expect(jevText).not.toContain('Weak hook'); // A's weakness never paints B's result
  });

  test('resets to the empty state when the analyzed draft is cleared (VAL-DRAFT-014)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, 'A draft long enough to be analyzed and then cleared');
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict');

    await page.locator(HOME_COMPOSER).click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await expect(panelOf(page)).toHaveAttribute('data-state', 'empty', { timeout: 5_000 });
    await expect(page.getByTestId('overlay-gauge')).toHaveCount(0); // neither the score...
    await expect(page.getByTestId('overlay-signals')).toHaveCount(0);
    await expect(page.getByTestId('overlay-jev')).toHaveCount(0); // ...nor the verdict may linger
  });

  test('keeps local scoring usable with a Connect Jev prompt when no key exists (VAL-DRAFT-017)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    const page = await openFixture(context);
    const errors = collectErrors(page);
    await typeDraft(page, 'A local-only draft long enough to be scored without a key');
    await expect(panelOf(page)).toHaveAttribute('data-state', 'analyzed', { timeout: 5_000 });

    await expect(page.getByTestId('overlay-gauge')).toHaveAttribute('data-headline-source', 'local');
    await expect(page.getByTestId('overlay-gauge')).toBeVisible();
    await expect(page.getByTestId('overlay-signals')).toContainText('Algorithm signals');
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'no-key');
    await expect(page.getByTestId('overlay-jev-notice')).toContainText('Local signals only');
    await expect(page.getByTestId('overlay-connect-jev')).toHaveText('Connect Jev');
    expect(calls).toHaveLength(0); // no Jev request without a key
    expect(errors).toEqual([]);

    // The prompt opens the extension's Options page through the background.
    const optionsPagePromise = context.waitForEvent('page');
    await page.getByTestId('overlay-connect-jev').click();
    const optionsPage = await optionsPagePromise;
    await expect(optionsPage).toHaveURL(/\/options\.html$/, { timeout: 10_000 });
    await expect(optionsPage.getByTestId('api-key-input')).toBeVisible();
  });

  test('shows an explicit error notice and keeps the local score on every Jev failure variant (VAL-DRAFT-018)', async ({ context }) => {
    const drafts = {
      network: 'Network failure draft: what tool did you drop this year?',
      http: 'HTTP failure draft: the checklist that made my week calmer',
      malformed: 'Malformed failure draft: why I write my hooks last every time',
    } as const;
    const { calls } = await interceptJev(context, ({ state }) => {
      if (state.startsWith(drafts.network)) return { action: 'abort' };
      if (state.startsWith(drafts.http)) return { action: 'status', status: 500, text: 'boom' };
      if (state.startsWith(drafts.malformed)) return { action: 'status', status: 200, text: 'not json' };
      return { action: 'fulfill', body: jevResponse({ ordinal: 3 }) };
    });
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    const errors = collectErrors(page);

    await typeDraft(page, drafts.network);
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'error', { timeout: 10_000 });
    await expect(page.getByTestId('overlay-jev-notice')).toContainText('AI judgment unavailable');
    await expect(page.getByTestId('overlay-jev')).toContainText('Could not reach the AI service.');
    await expect(page.getByTestId('overlay-gauge')).toHaveAttribute('data-headline-source', 'local');

    await typeDraft(page, drafts.http);
    await expect(page.getByTestId('overlay-jev')).toContainText('HTTP 500', { timeout: 10_000 });
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'error');

    await typeDraft(page, drafts.malformed);
    await expect(page.getByTestId('overlay-jev')).toContainText('unreadable response', { timeout: 10_000 });

    // Typing and page interaction remain functional; the local score stayed rendered throughout.
    await expect(page.getByTestId('overlay-gauge')).toBeVisible();
    await expect(page.getByTestId('overlay-signals')).toContainText('Algorithm signals');
    expect(errors).toEqual([]);
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  test('stays local-only without implying AI ran when jevForDrafts is off (VAL-DRAFT-021)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    const options = await saveKeyViaOptions(context); // key PRESENT: the setting, not the key, gates
    await options.getByTestId('pref-jevForDrafts').uncheck();
    await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');
    await options.close();

    const page = await openFixture(context);
    const errors = collectErrors(page);
    await typeDraft(page, 'A draft analyzed while AI for drafts is disabled');
    await expect(panelOf(page)).toHaveAttribute('data-state', 'analyzed', { timeout: 5_000 });
    await expect(page.getByTestId('overlay-gauge')).toHaveAttribute('data-headline-source', 'local');
    await expect(page.getByTestId('overlay-signals')).toContainText('Algorithm signals');
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'off');
    await expect(page.getByTestId('overlay-jev-notice')).toContainText('AI analysis is off in Settings');
    await expect(page.getByTestId('overlay-jev-pending')).toHaveCount(0); // nothing implies AI ran
    await expect(page.getByTestId('overlay-connect-jev')).toHaveCount(0);
    expect(calls).toHaveLength(0); // ZERO requests to api.typesafe.ai
    expect(errors).toEqual([]);
  });

  test('manual Analyze only: no automatic analysis UI or request while autoAnalyze is off (VAL-SETUP-010)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3.44, confidence: 0.65 }) }));
    const options = await saveKeyViaOptions(context);
    await options.getByTestId('pref-autoAnalyze').uncheck();
    await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');
    await options.close();

    const page = await openFixture(context);
    await typeDraft(page, 'A draft typed while autoAnalyze is off');
    await page.waitForTimeout(1_200); // past the debounce: nothing may analyze automatically
    await expect(panelOf(page)).toHaveAttribute('data-state', 'ready');
    await expect(page.getByTestId('overlay-analyze')).toHaveText('Analyze');
    await expect(page.getByTestId('overlay-gauge')).toHaveCount(0); // no score before activation
    expect(calls).toHaveLength(0);

    await page.getByTestId('overlay-analyze').click();
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
    await expect(panelOf(page)).toHaveAttribute('data-state', 'analyzed');
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict');
    await expect(page.getByTestId('overlay-jev-band')).toHaveText('Moderate');
  });
});

test.describe('overlay coexistence and lifecycle', () => {
  test('never interferes with the composer, media attachment or the Post button (VAL-DRAFT-022)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    const errors = collectErrors(page);
    const postButton = page.locator(POST_BUTTON);
    const postDisabledBefore = await postButton.getAttribute('aria-disabled');
    const requestedUrls: string[] = [];
    page.on('request', (request) => requestedUrls.push(request.url()));

    await typeDraft(page, 'A draft typed while checking composer and posting interference');
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict');

    // The overlay is our own host on document.body, never inside the React-managed tree.
    expect(
      await page.evaluate(() => {
        const host = document.querySelector('#amplifyx-overlay-host');
        const reactRoot = document.querySelector('#react-root');
        return host !== null && reactRoot !== null && !reactRoot.contains(host) && host.parentElement === document.body;
      }),
    ).toBe(true);

    // The composer stays focusable and editable with the overlay visible.
    await page.locator(HOME_COMPOSER).click();
    await page.keyboard.type(' more');
    await expect(page.locator(HOME_COMPOSER)).toContainText(/interference more/);

    // The page's media-attachment control still works.
    await page.locator(MEDIA_BUTTON).click();
    await expect(page.locator('[data-testid="attachments"] [data-testid="tweetPhoto"]')).toHaveCount(1);

    // The Post button's enabled state is unchanged, and the overlay does not cover it.
    expect(await postButton.getAttribute('aria-disabled')).toBe(postDisabledBefore);
    const overlayBox = await page.locator(OVERLAY_HOST).boundingBox();
    const postBox = await postButton.boundingBox();
    expect(overlayBox).not.toBeNull();
    expect(postBox).not.toBeNull();
    const overlaps =
      overlayBox!.x < postBox!.x + postBox!.width &&
      postBox!.x < overlayBox!.x + overlayBox!.width &&
      overlayBox!.y < postBox!.y + postBox!.height &&
      postBox!.y < overlayBox!.y + overlayBox!.height;
    expect(overlaps).toBe(false);

    // Nothing was submitted: no post-creation request, no navigation.
    expect(requestedUrls.filter((url) => /statuses\/create|\/compose|\/1\.1\/statuses/.test(url))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('repositions near the composer on window resize and stays inside the viewport without duplicating (VAL-DRAFT-023)', async ({ context }) => {
    await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, 'A draft that stays analyzed across a window resize');
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict', { timeout: 10_000 });

    const withinViewport = async (): Promise<boolean> => {
      const box = await page.locator(OVERLAY_HOST).boundingBox();
      if (!box) return false;
      const { width, height } = page.viewportSize()!;
      return box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height;
    };

    const before = await page.locator(OVERLAY_HOST).boundingBox();
    await page.setViewportSize({ width: 900, height: 700 });
    await expect.poll(withinViewport, { timeout: 5_000 }).toBe(true);
    const after = await page.locator(OVERLAY_HOST).boundingBox();
    expect(after!.x).not.toBe(before!.x); // it followed the narrower centered layout

    await page.setViewportSize({ width: 420, height: 700 }); // narrower than the panel + margins
    await expect.poll(withinViewport, { timeout: 5_000 }).toBe(true);
    const clamped = await page.locator(OVERLAY_HOST).boundingBox();
    expect(clamped!.x).toBeGreaterThanOrEqual(0);

    // Still exactly one overlay host, still usable (the panel keeps its content).
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);
    await expect(page.getByTestId('overlay-gauge')).toBeVisible();
  });

  test('the popup master switch removes and restores the overlay in the open tab without a reload (VAL-SETUP-016)', async ({ context }) => {
    await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, 'A draft analyzed before the master switch is toggled');
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict', { timeout: 10_000 });
    const urlBefore = page.url();

    const popup = await context.newPage();
    await popup.goto(await popupUrl(context));
    await expect(popup.getByTestId('key-indicator')).toBeVisible();
    await popup.getByTestId('master-toggle').click();

    await expect(page.locator(OVERLAY_HOST)).toHaveCount(0, { timeout: 5_000 }); // removed, no reload
    expect(page.url()).toBe(urlBefore);

    await popup.getByTestId('master-toggle').click();
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1, { timeout: 5_000 }); // re-mounted, no duplicate
    expect(page.url()).toBe(urlBefore);

    // Injection works again after re-enabling.
    await typeDraft(page, ' A second draft typed after re-enabling the extension');
    await expect(page.getByTestId('overlay-gauge')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);
  });

  test('a key configured in Options enables the AI verdict on the already-open tab without a reload (VAL-CROSS-002)', async ({ context }) => {
    const { calls } = await interceptJev(context, ({ state }) => {
      if (state.startsWith('Draft two')) {
        return { action: 'fulfill', body: jevResponse({ ordinal: 4, confidence: 0.66, weakness: 'weak_share_trigger' }) };
      }
      return { action: 'fulfill', body: jevResponse({ ordinal: 3 }) };
    });
    const page = await openFixture(context);
    await typeDraft(page, 'Draft one, typed while no key was configured');
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'no-key', { timeout: 5_000 });
    await expect(page.getByTestId('overlay-connect-jev')).toBeVisible();
    expect(calls).toHaveLength(0);

    // Configure the key in Options; the same tab (no reload) picks it up on the NEXT draft.
    await saveKeyViaOptions(context);
    await typeDraft(page, 'Draft two, typed after the key was configured in Options');
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict', { timeout: 10_000 });
    await expect(page.getByTestId('overlay-jev-band')).toHaveText('Strong');
    await expect(page.getByTestId('overlay-gauge')).toHaveAttribute('data-headline-source', 'hybrid');
    expect(calls.length).toBeGreaterThanOrEqual(1); // the post-configuration AI request happened
    expect(page.url()).toContain('localhost:3177'); // same tab, never reloaded
  });

  test('follows SPA navigation: no overlay remains for a dead composer, exactly one for the new view (VAL-DRAFT-004 overlay leg)', async ({ context }) => {
    await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    const page = await openFixture(context);
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);

    await page.locator('a[href*="/status/"]').first().click();
    await expect(page.locator('[data-testid="tweetTextarea_1"]')).toBeVisible();
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1, { timeout: 5_000 }); // exactly one for the reply view

    // The reply draft is analyzed against the reply composer.
    await page.locator('[data-testid="tweetTextarea_1"]').click();
    await page.keyboard.type('Reply draft long enough to analyze');
    await expect(page.getByTestId('overlay-gauge')).toBeVisible({ timeout: 5_000 });
    const snapshotState = await page.locator('#amplifyx-marker-host').getAttribute('data-watcher-composer');
    expect(snapshotState).toBe('tweetTextarea_1');
  });
});

async function readLiveKey(): Promise<string | undefined> {
  if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY;
  try {
    const env = await readFile(path.resolve('.env.local'), 'utf8');
    return /^JEV_API_KEY=(.+)$/m.exec(env)?.[1]?.trim().replace(/^["']|["']$/g, '');
  } catch {
    return undefined;
  }
}

test.describe('score overlay: live Jev smoke', () => {
  test('a real Jev exchange renders a verdict through the full overlay pipeline', async ({ context }) => {
    const liveKey = await readLiveKey();
    if (!liveKey) {
      console.warn('WARNING: JEV_API_KEY is not set; skipping the live Jev score-overlay test.');
      test.skip(true, 'JEV_API_KEY is not set');
      return;
    }
    // No route interception here: this is a real api.typesafe.ai exchange.
    await saveKeyViaOptions(context, liveKey);
    const page = await openFixture(context);
    const errors = collectErrors(page);
    const consoleText: string[] = [];
    page.on('console', (message) => consoleText.push(message.text()));

    await typeDraft(page, 'What is the one tool you stopped using this year, and why?');
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict', { timeout: 30_000 });
    const bandText = await page.getByTestId('overlay-jev-band').innerText();
    expect(['Weak', 'Below avg', 'Moderate', 'Strong', 'Exceptional']).toContain(bandText);
    await expect(page.getByTestId('overlay-jev-confidence')).toHaveText(/Confidence: \d+%/);
    await expect(page.getByTestId('overlay-gauge')).toHaveAttribute('data-headline-source', 'hybrid');
    await expect(page.getByTestId('overlay-signals')).toContainText('Algorithm signals');

    // Key secrecy: neither the page nor the console ever carries the key value.
    const panelText = await page.getByTestId('amplifyx-overlay').innerText();
    expect(panelText).not.toContain(liveKey);
    expect(errors.join('\n')).not.toContain(liveKey);
    expect(consoleText.join('\n')).not.toContain(liveKey);
    expect(errors).toEqual([]);
  });
});
