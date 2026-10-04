import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, FIXTURE_URL, optionsUrl, popupUrl, test } from './extension';
import { VERIFIED_JEV_RESPONSE } from '../helpers/jev-fixtures';

/**
 * ScoreOverlay E2E on the x.com fixture (fixture-controlled Jev responses via route
 * interception, plus ONE live-API test gated on JEV_API_KEY), M5 COLLAPSED-FIRST model: the
 * compact pill is the only surface while typing, the detail panel appears only after a pill click,
 * and it collapses on Escape, on an outside click (not forwarded to the page) and on any new
 * composer edit. Covers: no UI below the minimum (VAL-DRAFT-005), the collapsed pill showing the
 * headline number alone (VAL-DRAFT-032), pill placement that never occludes composer chrome
 * (VAL-DRAFT-033), click-to-expand with all three sections (VAL-DRAFT-034), Escape collapse
 * (VAL-DRAFT-035), typing collapse (VAL-DRAFT-036), the captured outside click and the native
 * second click (VAL-DRAFT-037), the page staying fully interactive while collapsed (VAL-DRAFT-038),
 * local-before-Jev independence (VAL-DRAFT-006), the six algorithm signals (VAL-DRAFT-007),
 * async verdict addition (VAL-DRAFT-008), the band table (VAL-DRAFT-009), pending state
 * (VAL-DRAFT-010), stale-response discard (VAL-DRAFT-011), clear-to-no-UI reset
 * (VAL-DRAFT-014), Connect Jev with no key (VAL-DRAFT-017), failure degradation
 * (VAL-DRAFT-018), jevForDrafts off (VAL-DRAFT-021), composer/posting non-interference
 * (VAL-DRAFT-022), resize repositioning (VAL-DRAFT-023), autoAnalyze gating only the AI call
 * (VAL-SETUP-010), the master-switch broadcast (VAL-SETUP-016) and settings-without-reload
 * (VAL-CROSS-002).
 */

const SYNTHETIC_KEY = 'key-overlay-e2e-0001';
const HOME_COMPOSER = '[data-testid="tweetTextarea_0"]';
const OVERLAY_HOST = '#amplifyx-overlay-host';
const PILL = 'amplifyx-overlay-pill';
const POST_BUTTON = '[data-testid="tweetButtonInline"]';
const MEDIA_BUTTON = '[data-testid="addMedia"]';
const COUNTER = '[data-testid="charCounter"]';

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

/** The detail panel: it exists ONLY while expanded (there is no always-open host panel). */
const panelOf = (page: Page) => page.getByTestId('amplifyx-overlay');
/** The collapsed pill: the default surface, showing the headline number alone. */
const pillOf = (page: Page) => page.getByTestId(PILL);

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
 * Expands the collapsed panel by clicking the pill — the only way the detail panel comes into
 * existence (VAL-DRAFT-034). Idempotent: an already-expanded panel is returned as-is, so a
 * test may call it after the panel expanded itself through a pill click.
 */
async function expand(page: Page): Promise<void> {
  if ((await panelOf(page).count()) > 0) return;
  await pillOf(page).click();
  await expect(panelOf(page)).toBeVisible();
}

/**
 * Types a draft that keeps the SAME id-testids — the close button reopens the pill in the same
 * composer position (no navigation, no second host) — so a sequential draft in one test is truly
 * independent: a leftover previous draft would change the draft hash and the request state.
 *
 * The old `Control+A` + `Backspace` shortcut CANNOT be used while the panel is expanded: that
 * first click outside the panel is deliberately captured to close it (VAL-DRAFT-037) and never
 * reaches the composer, so it never focuses the editor either. Collapsing first (Escape) puts
 * the composer back in reach, and only then is the clear reliable.
 */
async function typeDraft(page: Page, text: string): Promise<void> {
  if ((await panelOf(page).count()) > 0) await collapse(page);
  await page.locator(HOME_COMPOSER).click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text);
}

/** Collapses the expanded panel with Escape and waits for the pill to come back (VAL-DRAFT-035). */
async function collapse(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(panelOf(page)).toHaveCount(0);
  await expect(pillOf(page)).toBeVisible();
}

/**
 * The fixture's click counters as a stable string. The fixture records every click that actually
 * REACHES the page in the bubble phase (an extension surface that stops propagation is invisible
 * here), which is exactly the evidence the collapsed/expanded pointer-discipline tests need.
 */
function fixtureClicks(page: Page): Promise<string> {
  return page.evaluate(
    () => JSON.stringify((window as unknown as Record<string, unknown>)['__fixtureClicks'] ?? {}),
  );
}

function overlaps(
  a: { x: number; y: number; width: number; height: number } | null,
  b: { x: number; y: number; width: number; height: number } | null,
): boolean {
  if (a === null || b === null) return false;
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test.describe('score overlay states', () => {
  test('renders NO extension UI below the minimum length, with no score and no request (VAL-DRAFT-005)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    const page = await openFixture(context);
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(0); // nothing at all without a draft
    await expect(pillOf(page)).toHaveCount(0);
    await expect(page.getByTestId('overlay-empty')).toHaveCount(0); // the balloon is gone

    await typeDraft(page, '123456789'); // 9 raw chars; default minDraftLength is 10
    await page.waitForTimeout(1_200); // past the ~700ms debounce
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(0);
    await expect(pillOf(page)).toHaveCount(0);
    await expect(panelOf(page)).toHaveCount(0);
    expect(calls).toHaveLength(0); // no Jev request for a below-minimum draft
  });

  test('the collapsed pill carries the local headline while Jev is held pending, and expands into both halves (VAL-DRAFT-006, VAL-DRAFT-010, VAL-DRAFT-008)', async ({ context }) => {
    const draft = 'What is the one tool you stopped using this year, and why?';
    const { calls, parked } = await interceptJev(context, ({ state }) =>
      state.startsWith(draft) ? { action: 'park', body: jevResponse({ ordinal: 3.44, confidence: 0.65 }) } : { action: 'fulfill', body: jevResponse({ ordinal: 1 }) },
    );
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, draft);
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
    expect(parked).toHaveLength(1); // the Jev response is deliberately held pending

    // The local 0-100 score renders WITHOUT waiting for Jev — in the collapsed pill, which shows
    // the headline number ALONE and no detail panel at all (VAL-DRAFT-006, VAL-DRAFT-032).
    const pill = pillOf(page);
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText(/^(?:[0-9]|[1-9][0-9]|100)$/);
    await expect(pill).toHaveAttribute('data-headline-source', 'local');
    await expect(pill).toHaveAttribute('data-jev-state', 'pending');
    await expect(panelOf(page)).toHaveCount(0); // the panel does not exist until a pill click
    await expect(page.getByTestId('overlay-gauge')).toHaveCount(0);
    await expect(page.getByTestId('overlay-signals')).toHaveCount(0);

    // One pill click expands the full panel for the same draft, with the AI half pending.
    await expand(page);
    await expect(page.getByTestId('overlay-gauge')).toHaveAttribute('data-headline-source', 'local');
    await expect(page.getByTestId('overlay-headline')).toHaveText(/^(?:[0-9]|[1-9][0-9]|100)$/);
    await expect(page.getByTestId('overlay-signals')).toContainText('Algorithm signals');
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'pending');
    await expect(page.getByTestId('overlay-jev-pending')).toContainText('Analyzing with AI');

    // Release: the verdict is added asynchronously, beside the unchanged local breakdown, in the
    // SAME open panel (a reply is not a user edit, so the panel does not collapse).
    parked[0]!.release();
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict');
    await expect(page.getByTestId('overlay-jev-band')).toHaveText('Moderate');
    await expect(page.getByTestId('overlay-jev-confidence')).toHaveText('Confidence: 65%');
    await expect(page.getByTestId('overlay-gauge')).toHaveAttribute('data-headline-source', 'hybrid');
    await expect(page.getByTestId('overlay-signals')).toContainText('Algorithm signals'); // never relabeled
    await expect(page.getByTestId('overlay-jev')).toContainText('AI judgment');
    await expect(page.getByTestId('overlay-jev-weaknesses')).not.toBeEmpty();

    // Collapsing keeps the pill, now showing the hybrid headline (VAL-DRAFT-035).
    const hybrid = await page.getByTestId('overlay-headline').innerText();
    await collapse(page);
    await expect(pillOf(page)).toHaveText(hybrid);
  });

  test('one pill click expands all three sections for the current draft (VAL-DRAFT-034)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, 'What changed my year? A daily checklist. #focus #systems https://example.com/post');
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
    await expect(pillOf(page)).toBeVisible();
    await expect(panelOf(page)).toHaveCount(0);

    await pillOf(page).click(); // exactly one click
    await expect(panelOf(page)).toBeVisible();
    await expect(panelOf(page)).toHaveAttribute('data-state', 'analyzed');
    await expect(page.getByTestId('overlay-signals')).toBeVisible(); // Algorithm signals
    await expect(page.getByTestId('overlay-jev')).toBeVisible(); // AI judgment
    await expect(page.getByTestId('overlay-optimizer')).toBeVisible(); // Optimizer
    await expect(pillOf(page)).toHaveCount(0); // the pill is replaced by the panel
  });

  test('explains the local score with the six concrete algorithm signals (VAL-DRAFT-007)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    const errors = collectErrors(page);
    await typeDraft(page, 'What changed my year? One daily checklist. #focus #systems https://example.com/post');
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
    await expand(page);

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
      // Typing collapsed the panel: re-expand for this draft's band assertions.
      await expect(panelOf(page)).toHaveCount(0);
      await expand(page);
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
    await expand(page);
    await expect(page.getByTestId('overlay-jev-band')).toHaveText('Exceptional'); // B settled first
    const headlineForB = await page.getByTestId('overlay-headline').innerText();

    parked[0]!.release(); // A's stale response arrives LAST
    await page.waitForTimeout(500); // give the late reply time to (be discarded)
    await expect(page.getByTestId('overlay-jev-band')).toHaveText('Exceptional');
    const jevText = await page.getByTestId('overlay-jev').innerText();
    expect(jevText).not.toContain('Weak hook'); // A's weakness never paints B's result
    // A never overwrites B's collapsed pill headline either (VAL-DRAFT-011, new model).
    await collapse(page);
    await expect(pillOf(page)).toHaveText(headlineForB);
  });

  test('removes every extension surface when the analyzed draft is cleared (VAL-DRAFT-014)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, 'A draft long enough to be analyzed and then cleared');
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
    await expand(page);
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict');

    await page.locator(HOME_COMPOSER).click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    // Neither the pill nor a panel may remain: the composer area is left completely free.
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(0, { timeout: 5_000 });
    await expect(pillOf(page)).toHaveCount(0);
    await expect(panelOf(page)).toHaveCount(0);
    await expect(page.getByTestId('overlay-gauge')).toHaveCount(0);
    await expect(page.getByTestId('overlay-signals')).toHaveCount(0);
    await expect(page.getByTestId('overlay-jev')).toHaveCount(0);
  });

  test('keeps local scoring usable with a Connect Jev prompt when no key exists (VAL-DRAFT-017)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    const page = await openFixture(context);
    const errors = collectErrors(page);
    await typeDraft(page, 'A local-only draft long enough to be scored without a key');
    await expect(pillOf(page)).toBeVisible({ timeout: 5_000 });

    // The pill keeps the local score and implies no AI verdict exists.
    await expect(pillOf(page)).toHaveAttribute('data-headline-source', 'local');
    await expect(pillOf(page)).toHaveAttribute('data-jev-state', 'no-key');
    expect(calls).toHaveLength(0); // no Jev request without a key

    await expand(page);
    await expect(page.getByTestId('overlay-gauge')).toHaveAttribute('data-headline-source', 'local');
    await expect(page.getByTestId('overlay-signals')).toContainText('Algorithm signals');
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'no-key');
    await expect(page.getByTestId('overlay-jev-notice')).toContainText('Local signals only');
    await expect(page.getByTestId('overlay-connect-jev')).toHaveText('Connect Jev');
    expect(calls).toHaveLength(0);
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
    await expand(page);
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'error', { timeout: 10_000 });
    await expect(page.getByTestId('overlay-jev-notice')).toContainText('AI judgment unavailable');
    await expect(page.getByTestId('overlay-jev')).toContainText('Could not reach the AI service.');

    // Every draft in this test ends in the SAME failure state, so the HTTP draft would look
    // settled before its own request is even made. Its Jev request is therefore awaited: the
    // network draft's failure is a separate dispatch (per-draft ownership, VAL-DRAFT-018) and
    // must never be able to satisfy this assertion.
    await typeDraft(page, drafts.http); // typing collapses the panel; the pill stays usable
    await expect(panelOf(page)).toHaveCount(0);
    await expect(pillOf(page)).toBeVisible();
    await expect.poll(() => calls.filter((call) => call.state.startsWith(drafts.http)).length, {
      timeout: 10_000,
    }).toBe(1);
    await expand(page);
    await expect(page.getByTestId('overlay-jev')).toContainText('HTTP 500', { timeout: 10_000 });
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'error');

    await typeDraft(page, drafts.malformed);
    await expect(panelOf(page)).toHaveCount(0);
    await expect.poll(() => calls.filter((call) => call.state.startsWith(drafts.malformed)).length, {
      timeout: 10_000,
    }).toBe(1);
    await expand(page);
    await expect(page.getByTestId('overlay-jev')).toContainText('unreadable response', { timeout: 10_000 });

    // Typing and page interaction remain functional; the local score stayed rendered throughout.
    await expect(page.getByTestId('overlay-signals')).toContainText('Algorithm signals');
    await collapse(page);
    await expect(pillOf(page)).toHaveAttribute('data-jev-state', 'error');
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
    await expect(pillOf(page)).toBeVisible({ timeout: 5_000 });
    await expect(pillOf(page)).toHaveAttribute('data-headline-source', 'local');
    await expect(pillOf(page)).toHaveAttribute('data-jev-state', 'off');

    await expand(page);
    await expect(page.getByTestId('overlay-signals')).toContainText('Algorithm signals');
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'off');
    await expect(page.getByTestId('overlay-jev-notice')).toContainText('AI analysis is off in Settings');
    await expect(page.getByTestId('overlay-jev-pending')).toHaveCount(0); // nothing implies AI ran
    await expect(page.getByTestId('overlay-connect-jev')).toHaveCount(0);
    expect(calls).toHaveLength(0); // ZERO requests to api.typesafe.ai
    expect(errors).toEqual([]);
  });

  test('turning jevForDrafts off reverts an analyzed tab to local-only and late results stay suppressed (VAL-DRAFT-021)', async ({ context }) => {
    const draftA = 'Toggle-off draft one: what made you finally switch editors for good?';
    const draftB = 'Toggle-off draft two: the one habit that made my writing stick was reading aloud';
    const { calls, parked } = await interceptJev(context, ({ state }) => {
      if (state.startsWith(draftB)) {
        return { action: 'park', body: jevResponse({ ordinal: 4.5, confidence: 0.8, weakness: 'no_major_weakness' }) };
      }
      return { action: 'fulfill', body: jevResponse({ ordinal: 3 }) };
    });
    const options = await saveKeyViaOptions(context);
    const page = await openFixture(context);
    const errors = collectErrors(page);

    // Phase 1: the tab shows a settled AI verdict for draft A in the expanded panel.
    await typeDraft(page, draftA);
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
    await expand(page);
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict');
    await expect(page.getByTestId('overlay-gauge')).toHaveAttribute('data-headline-source', 'hybrid');

    // Phase 2: draft B is dispatched and PARKED; typing collapsed the panel, so re-expand while
    // the user then turns AI off from the Options page.
    await typeDraft(page, draftB);
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(2);
    await expand(page);
    // The panel must stay open across an Options-page interaction: the panel lives in the tab,
    // the setting is saved in another page, and a preference change re-renders IN PLACE — it
    // never collapses the panel the user is looking at.
    await options.getByTestId('pref-jevForDrafts').uncheck();
    await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');
    // The panel must still be open here, and reading it is race-free: `toHaveAttribute` retries.
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'off', { timeout: 5_000 });
    await expect(page.getByTestId('overlay-gauge')).toHaveAttribute('data-headline-source', 'local');
    await expect(page.getByTestId('overlay-jev-band')).toHaveCount(0);

    // Phase 3: B's late result arrives — it must NOT re-introduce the verdict. The parked call is
    // a real in-flight request, so waiting for the tab to consume it is the deterministic proof
    // that the reply was processed and discarded, not merely ignored. Every read here retries
    // (`toHaveAttribute`/`toContainText`), and none of them can match the PRE-release state: draft
    // B's band was never rendered (the panel went straight to local-only when AI was switched
    // off), so "Strong" can only appear if the late verdict was actually re-introduced.
    parked[0]!.release();
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'off', { timeout: 10_000 });
    await expect(page.getByTestId('overlay-gauge')).toHaveAttribute('data-headline-source', 'local');
    await expect(page.getByTestId('overlay-jev-pending')).toHaveCount(0);
    await expect(page.getByTestId('overlay-jev')).not.toContainText('Strong');
    await expect(page.getByTestId('overlay-jev-band')).toHaveCount(0);
    // The collapsed pill carries the same verdict state, so the guarantee is also pinned in the
    // DEFAULT surface the user actually sees while typing.
    await collapse(page);
    await expect(pillOf(page)).toHaveAttribute('data-jev-state', 'off');
    await expect(pillOf(page)).toHaveAttribute('data-headline-source', 'local');
    expect(calls).toHaveLength(2); // no NEW AI request ran once the setting was off
    expect(errors).toEqual([]);
  });

  test('autoAnalyze off shows the local pill with zero Jev calls; the in-panel AI action runs exactly one (VAL-SETUP-010)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3.44, confidence: 0.65 }) }));
    const options = await saveKeyViaOptions(context);
    await options.getByTestId('pref-autoAnalyze').uncheck();
    await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');
    await options.close();

    const page = await openFixture(context);
    await typeDraft(page, 'A draft typed while autoAnalyze is off');
    await page.waitForTimeout(1_200); // past the debounce: nothing may analyze automatically

    // The LOCAL score is always computed (no network) and always shown in the collapsed pill.
    await expect(pillOf(page)).toBeVisible();
    await expect(pillOf(page)).toHaveText(/^(?:[0-9]|[1-9][0-9]|100)$/);
    await expect(pillOf(page)).toHaveAttribute('data-jev-state', 'ready'); // nothing is in flight
    expect(calls).toHaveLength(0); // ZERO Jev requests before the action is activated

    await expand(page);
    await expect(page.getByTestId('overlay-signals')).toContainText('Algorithm signals');
    const analyze = page.getByTestId('overlay-analyze');
    await expect(analyze).toHaveText('Analyze with AI');
    expect(calls).toHaveLength(0); // still nothing: the action has not been activated

    // Exactly one Jev analysis on activation, and its verdict renders in the SAME panel.
    await analyze.click();
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict');
    await expect(page.getByTestId('overlay-jev-band')).toHaveText('Moderate');
    expect(calls).toHaveLength(1);
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
    await expand(page);
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
    expect(overlaps(overlayBox, postBox)).toBe(false);

    // Nothing was submitted: no post-creation request, no navigation.
    expect(requestedUrls.filter((url) => /statuses\/create|\/compose|\/1\.1\/statuses/.test(url))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('the collapsed pill never overlaps composer chrome (VAL-DRAFT-033)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, 'A draft whose compact pill is checked against every composer control');
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);

    // Representative viewport sizes, including a small window.
    for (const size of [
      { width: 1280, height: 900 },
      { width: 900, height: 700 },
      { width: 520, height: 640 },
    ]) {
      await page.setViewportSize(size);
      await expect(pillOf(page)).toBeVisible();
      const pill = await pillOf(page).boundingBox();
      const region = await page.locator('[data-testid="toolBar"]').boundingBox();
      const composerBox = await page.locator(HOME_COMPOSER).boundingBox();
      const counterBox = await page.locator(COUNTER).boundingBox();
      const mediaBox = await page.locator(MEDIA_BUTTON).boundingBox();
      const postBox = await page.locator(POST_BUTTON).boundingBox();
      expect(pill).not.toBeNull();

      // Bottom-right of the composer region, adjacent to the counter/Post area.
      expect(pill!.x).toBeGreaterThan(region!.x);
      expect(pill!.x + pill!.width).toBeLessThan(region!.x + region!.width + 1);
      expect(pill!.y + pill!.height).toBeLessThanOrEqual(region!.y + region!.height + 1);
      expect(pill!.y).toBeGreaterThan(region!.y);

      // Zero overlap of the text area, the character counter, the media control and the Post
      // button — and the whole pill stays inside the window.
      for (const control of [composerBox, counterBox, mediaBox, postBox]) {
        expect(overlaps(pill, control), `the pill must not cover ${JSON.stringify(control)}`).toBe(false);
      }
      expect(pill!.x).toBeGreaterThanOrEqual(0);
      expect(pill!.x + pill!.width).toBeLessThanOrEqual(size.width);
    }
  });

  test('Escape collapses the expanded panel and keeps the pill (VAL-DRAFT-035)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, 'A draft whose panel collapses with the Escape key');
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
    await expand(page);
    const headline = await page.getByTestId('overlay-headline').innerText();

    await page.keyboard.press('Escape');
    await expect(panelOf(page)).toHaveCount(0);
    await expect(pillOf(page)).toBeVisible();
    await expect(pillOf(page)).toHaveText(headline); // the pill remains, with the current score
  });

  test('the first outside click collapses the panel without reaching the page; the second behaves natively (VAL-DRAFT-037)', async ({ context }) => {
    await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, 'A draft analyzed before the outside-click collapse is exercised');
    await expect(pillOf(page)).toBeVisible({ timeout: 10_000 });
    await expand(page);

    // The fixture records every click that reaches the PAGE (bubble phase), plus the URL.
    const clicksBefore = await fixtureClicks(page);
    const urlBefore = page.url();

    // Click a page element that lies clear of the expanded panel: the first timeline post.
    const article = page.locator('article[data-testid="tweet"]').first();
    await article.click({ position: { x: 5, y: 5 } });
    await expect(panelOf(page)).toHaveCount(0); // the panel collapsed...
    await expect(pillOf(page)).toBeVisible();
    expect(await fixtureClicks(page)).toBe(clicksBefore); // ...and nothing activated
    expect(page.url()).toBe(urlBefore);

    // The next identical click reaches the page natively.
    await article.click({ position: { x: 5, y: 5 } });
    await expect.poll(async () => (await fixtureClicks(page)) !== clicksBefore).toBe(true);
  });

  test('typing collapses the expanded panel so X popups are never covered (VAL-DRAFT-036)', async ({ context }) => {
    await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, 'A draft analyzed while the user keeps editing the composer');
    await expect(pillOf(page)).toBeVisible({ timeout: 10_000 });
    await expand(page);
    await expect(panelOf(page)).toBeVisible();

    // The FIRST new user edit collapses the panel back to the pill — the deterministic
    // anti-occlusion guarantee behind X's mention/emoji/GIF popups.
    await page.locator(HOME_COMPOSER).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' with one more clause added right now');
    await expect(panelOf(page)).toHaveCount(0, { timeout: 5_000 });
    await expect(pillOf(page)).toBeVisible();
    // The whole space below the composer region is free for the page's own popups.
    const pill = await pillOf(page).boundingBox();
    const region = await page.locator('[data-testid="toolBar"]').boundingBox();
    expect(pill!.y + pill!.height).toBeLessThanOrEqual(region!.y + region!.height + 1);
  });

  test('the collapsed pill leaves the page fully interactive (VAL-DRAFT-038)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, 'A draft whose collapsed pill must not swallow page interaction');
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
    await expect(pillOf(page)).toBeVisible();

    // Page scrolling works over and around the pill: the wheel is the page's own. A short
    // viewport guarantees the fixture timeline overflows, so there is always something to scroll.
    await page.setViewportSize({ width: 900, height: 400 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight))
      .toBe(true);
    await page.mouse.wheel(0, 400);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await page.mouse.wheel(0, -400);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

    // The wheel is still the page's while the panel is EXPANDED too: the panel is anchored to the
    // composer region and never over the timeline, so a wheel over the page scrolls the page.
    await expand(page);
    await page.mouse.wheel(0, 400);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await page.mouse.wheel(0, -400);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await collapse(page);
    await page.setViewportSize({ width: 1280, height: 720 });

    // A native timeline control still reaches the page (the fixture counts it).
    const before = await fixtureClicks(page);
    await page.locator('article[data-testid="tweet"] [data-testid="like"]').first().click();
    await expect.poll(async () => (await fixtureClicks(page)) !== before).toBe(true);

    // The target badge popover still opens from its own button.
    const badge = page.locator('button[data-testid="amplifyx-target-badge"]').first();
    if ((await badge.count()) > 0) {
      await badge.click();
      await expect(page.locator('#amplifyx-target-popover-host [data-testid="amplifyx-target-popover"]')).toBeVisible();
    }
    // The pill is still the only extension surface near the composer throughout.
    await expect(panelOf(page)).toHaveCount(0);
  });

  test('repositions near the composer on window resize and stays inside the viewport without duplicating (VAL-DRAFT-023)', async ({ context }) => {
    await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, 'A draft that stays analyzed across a window resize');
    await expect(pillOf(page)).toBeVisible({ timeout: 10_000 });
    await expand(page);
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict');

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

  test('a panel taller than the viewport caps to the available space with internal scrolling (VAL-DRAFT-023)', async ({ context }) => {
    await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, 'A draft whose analyzed panel is taller than a short viewport allows');
    await expect(pillOf(page)).toBeVisible({ timeout: 10_000 });
    await expand(page);
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict');

    // The review's scenario: a fully analyzed panel in a ~500px-tall window — far more panel
    // than viewport. The overlay must cap to the available space instead of running offscreen.
    await page.setViewportSize({ width: 900, height: 500 });
    const withinViewport = async (): Promise<boolean> => {
      const box = await page.locator(OVERLAY_HOST).boundingBox();
      if (!box) return false;
      const { width, height } = page.viewportSize()!;
      return box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height;
    };
    await expect.poll(withinViewport, { timeout: 5_000 }).toBe(true);

    // The cap engages internal scrolling: the content exceeds the capped box.
    const scrollState = await page.evaluate(() => {
      const panel = document
        .querySelector('#amplifyx-overlay-host')
        ?.shadowRoot?.querySelector('[data-testid="amplifyx-overlay"]');
      if (!panel) return null;
      return {
        clientHeight: panel.clientHeight,
        scrollHeight: panel.scrollHeight,
        overflowY: getComputedStyle(panel).overflowY,
      };
    });
    expect(scrollState).not.toBeNull();
    expect(scrollState!.overflowY).toBe('auto');
    expect(scrollState!.scrollHeight).toBeGreaterThan(scrollState!.clientHeight);

    // Still anchored to the composer: never over the Post button, never duplicated.
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);
    await expect(page.getByTestId('overlay-gauge')).toBeVisible();
    const postBox = await page.locator(POST_BUTTON).boundingBox();
    const overlayBox = await page.locator(OVERLAY_HOST).boundingBox();
    expect(postBox).not.toBeNull();
    expect(overlaps(overlayBox, postBox)).toBe(false);

    // Restoring the height releases the cap.
    await page.setViewportSize({ width: 900, height: 900 });
    await expect.poll(withinViewport, { timeout: 5_000 }).toBe(true);
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);
  });

  test('the expanded panel anchors below the composer furniture row and never covers the counter, media control or Post button (m5-overlay-scroll-reach)', async ({ context }) => {
    await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, 'A draft whose expanded panel must clear every composer control');
    await expect(pillOf(page)).toBeVisible({ timeout: 10_000 });

    // The REAL x.com home-composer nesting (live-verified 2026-10-04): the editor's container
    // parent is a tight text-row wrapper and the furniture row (toolBar) is a SIBLING subtree of
    // the common block — the fixture mirrors it, so these geometry pins guard the real defect:
    // anchored to the tight wrapper, the panel covered the furniture row (measured live).
    for (const size of [
      { width: 1280, height: 900 },
      { width: 900, height: 700 },
    ]) {
      await page.setViewportSize(size);
      await expand(page);
      await expect(page.getByTestId('overlay-gauge')).toBeVisible();
      const panelBox = await panelOf(page).boundingBox();
      const toolBarBox = await page.locator('[data-testid="toolBar"]').boundingBox();
      expect(panelBox).not.toBeNull();
      expect(toolBarBox).not.toBeNull();
      // The panel ANCHORS BELOW the furniture row (its top is at/below the row's bottom edge).
      expect(panelBox!.y).toBeGreaterThanOrEqual(toolBarBox!.y + toolBarBox!.height - 1);
      // Zero overlap with every furniture control, at every size.
      for (const selector of [MEDIA_BUTTON, COUNTER, POST_BUTTON]) {
        const box = await page.locator(selector).boundingBox();
        expect(overlaps(panelBox, box), `the expanded panel must not cover ${selector}`).toBe(false);
      }
    }
  });

  test('the popup master switch removes and restores the overlay in the open tab without a reload (VAL-SETUP-016)', async ({ context }) => {
    await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, 'A draft analyzed before the master switch is toggled');
    await expect(pillOf(page)).toBeVisible({ timeout: 10_000 });
    const urlBefore = page.url();

    const popup = await context.newPage();
    await popup.goto(await popupUrl(context));
    await expect(popup.getByTestId('key-indicator')).toBeVisible();
    await popup.getByTestId('master-toggle').click();

    await expect(page.locator(OVERLAY_HOST)).toHaveCount(0, { timeout: 5_000 }); // removed, no reload
    expect(page.url()).toBe(urlBefore);

    await popup.getByTestId('master-toggle').click();
    expect(page.url()).toBe(urlBefore);

    // Injection works again after re-enabling: the fresh composer starts collapsed, so the pill
    // is the only surface until the user clicks it.
    await typeDraft(page, ' A second draft typed after re-enabling the extension');
    await expect(pillOf(page)).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);
    await expect(panelOf(page)).toHaveCount(0);
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
    await expect(pillOf(page)).toHaveAttribute('data-jev-state', 'no-key', { timeout: 5_000 });
    await expand(page);
    await expect(page.getByTestId('overlay-connect-jev')).toBeVisible();
    expect(calls).toHaveLength(0);

    // Configure the key in Options; the same tab (no reload) picks it up on the NEXT draft. The
    // preference change must not collapse the panel, so the waiting below is on the panel.
    await saveKeyViaOptions(context);
    await typeDraft(page, 'Draft two, typed after the key was configured in Options');
    await expect(panelOf(page)).toHaveCount(0);
    await expand(page);
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict', { timeout: 10_000 });
    await expect(page.getByTestId('overlay-jev-band')).toHaveText('Strong');
    await expect(page.getByTestId('overlay-gauge')).toHaveAttribute('data-headline-source', 'hybrid');
    expect(calls.length).toBeGreaterThanOrEqual(1); // the post-configuration AI request happened
    expect(page.url()).toContain('localhost:3177'); // same tab, never reloaded
  });

  test('follows SPA navigation: no overlay remains for a dead composer, exactly one for the new view (VAL-DRAFT-004 overlay leg)', async ({ context }) => {
    await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    const page = await openFixture(context);
    // Nothing is rendered for a composer with no draft: no score, no extension UI at all.
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(0);
    await typeDraft(page, 'Home draft that makes the home overlay appear');
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1, { timeout: 5_000 });

    await page.locator('a[href*="/status/"]').first().click();
    await expect(page.locator('[data-testid="tweetTextarea_1"]')).toBeVisible();
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(0, { timeout: 5_000 }); // the home view's host is gone

    // The reply draft is scored against the reply composer, collapsed-first like the home one.
    await page.locator('[data-testid="tweetTextarea_1"]').click();
    await page.keyboard.type('Reply draft long enough to analyze');
    await expect(pillOf(page)).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1); // exactly one, for the reply view
    await expect(panelOf(page)).toHaveCount(0);
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
    await expect(pillOf(page)).toBeVisible({ timeout: 30_000 });
    await expand(page);
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
