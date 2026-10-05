import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, FIXTURE_URL, optionsUrl, popupUrl, test } from './extension';
import { VERIFIED_JEV_RESPONSE } from '../helpers/jev-fixtures';

/**
 * ScoreOverlay E2E on the x.com fixture (fixture-controlled Jev responses via route
 * interception, plus ONE live-API test gated on JEV_API_KEY), M6 DESIGN-1B model: while typing,
 * the ONLY extension UI near the composer is the in-flow 36px status row inserted as the
 * immediate preceding sibling of X's `[data-testid="toolBar"]` (the floating pill and its
 * placement math are GONE). Clicking the row expands the analysis INLINE in flow (it pushes the
 * toolbar down, D2: max height + internal scroll), and it collapses on Escape, on any new
 * composer edit and on an outside click that is FORWARDED to the page (the M5 first-click
 * capture exception is removed). Covers: no UI below the minimum (VAL-DRAFT-005), the row's
 * anatomy and local headline while pending (VAL-DRAFT-006, VAL-DRAFT-010, VAL-DRAFT-032),
 * one-click inline expansion with all three sections (VAL-DRAFT-034), the algorithm signals
 * (VAL-DRAFT-007), async verdict (VAL-DRAFT-008), the band table (VAL-DRAFT-009), stale-response
 * discard (VAL-DRAFT-011), clear-to-no-UI reset (VAL-DRAFT-014), Connect Jev with no key
 * (VAL-DRAFT-017), failure degradation (VAL-DRAFT-018), jevForDrafts off (VAL-DRAFT-021),
 * composer/posting non-interference (VAL-DRAFT-022), Escape collapse (VAL-DRAFT-035), typing
 * collapse (VAL-DRAFT-036), the forwarded outside click (VAL-DRAFT-037), the page staying fully
 * interactive while collapsed (VAL-DRAFT-038), toolbar-pushdown geometry (VAL-DRAFT-042),
 * the 36px single-line row (VAL-DRAFT-043), chip cap/ordering/neutral toggle (VAL-DRAFT-044),
 * hybrid headline only at verdict (VAL-DRAFT-045), row accessibility anatomy (VAL-DRAFT-046),
 * autoAnalyze gating only the AI call (VAL-SETUP-010), the master-switch broadcast
 * (VAL-SETUP-016) and settings-without-reload (VAL-CROSS-002).
 */

const SYNTHETIC_KEY = 'key-overlay-e2e-0001';
const HOME_COMPOSER = '[data-testid="tweetTextarea_0"]';
const OVERLAY_HOST = '#amplifyx-overlay-host';
const ROW = 'amplifyx-overlay-row';
const TOOLBAR = '[data-testid="toolBar"]';
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

/** The in-flow status row: the default surface while a draft qualifies (VAL-DRAFT-032). */
const rowOf = (page: Page) => page.getByTestId(ROW);
/** The row's headline score (the hybrid value only once an AI verdict is displayed). */
const headlineOf = (page: Page) => page.getByTestId('overlay-headline');
/** The expanded block: it exists ONLY while expanded (there is no always-open panel). */
const expandedOf = (page: Page) => page.getByTestId('amplifyx-overlay');

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
 * Expands the inline analysis by clicking the status row — the only way the expanded block comes
 * into existence (VAL-DRAFT-034). Idempotent: an already-expanded block is returned as-is, so a
 * test may call it after the block expanded itself through a row click.
 */
async function expand(page: Page): Promise<void> {
  if ((await expandedOf(page).count()) > 0) return;
  await rowOf(page).click();
  await expect(expandedOf(page)).toBeVisible();
}

/**
 * Types a draft that keeps the SAME id-testids — the composer is reused in the same position
 * (no navigation, no second host) — so a sequential draft in one test is truly independent: a
 * leftover previous draft would change the draft hash and the request state.
 *
 * A new user edit collapses the expanded block (VAL-DRAFT-036), so an expanded block is
 * collapsed with Escape first, which puts the composer back in reach, and only then is the
 * clear reliable.
 */
async function typeDraft(page: Page, text: string): Promise<void> {
  if ((await expandedOf(page).count()) > 0) await collapse(page);
  await page.locator(HOME_COMPOSER).click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text);
}

/** Collapses the expanded block with Escape and waits for the row to be the surface again (VAL-DRAFT-035). */
async function collapse(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(expandedOf(page)).toHaveCount(0);
  await expect(rowOf(page)).toBeVisible();
}

/**
 * The fixture's click counters as a stable string. The fixture records every click that actually
 * REACHES the page in the bubble phase — exactly the evidence the forwarded-outside-click
 * guarantee needs (VAL-DRAFT-037: the first outside click both collapses AND activates).
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

/** Reads a shadow-DOM computed style for an element inside the overlay host. */
async function shadowStyle(page: Page, selector: string, property: string): Promise<string> {
  return page.evaluate(
    ([selector, property]) => {
      const element = document
        .querySelector('#amplifyx-overlay-host')
        ?.shadowRoot?.querySelector<HTMLElement>(selector);
      if (element === null || element === undefined) return '';
      return getComputedStyle(element)[property as keyof CSSStyleDeclaration] as string;
    },
    [selector, property] as const,
  );
}

test.describe('score overlay states', () => {
  test('renders NO extension UI below the minimum length, with no score and no request (VAL-DRAFT-005)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    const page = await openFixture(context);
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(0); // nothing at all without a draft
    await expect(rowOf(page)).toHaveCount(0);
    await expect(page.getByTestId('overlay-empty')).toHaveCount(0); // the balloon is gone

    await typeDraft(page, '123456789'); // 9 raw chars; default minDraftLength is 10
    await page.waitForTimeout(1_200); // past the ~700ms debounce
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(0);
    await expect(rowOf(page)).toHaveCount(0);
    await expect(expandedOf(page)).toHaveCount(0);
    expect(calls).toHaveLength(0); // no Jev request for a below-minimum draft
  });

  test('the row carries the local headline while Jev is held pending, and one click expands the analysis inline (VAL-DRAFT-006, VAL-DRAFT-010, VAL-DRAFT-008, VAL-DRAFT-032)', async ({ context }) => {
    const draft = 'What is the one tool you stopped using this year, and why?';
    const { calls, parked } = await interceptJev(context, ({ state }) =>
      state.startsWith(draft) ? { action: 'park', body: jevResponse({ ordinal: 3.44, confidence: 0.65 }) } : { action: 'fulfill', body: jevResponse({ ordinal: 1 }) },
    );
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, draft);
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
    expect(parked).toHaveLength(1); // the Jev response is deliberately held pending

    // The local 0-100 score renders WITHOUT waiting for Jev — in the in-flow row, which shows
    // the full anatomy and NO expanded block at all (VAL-DRAFT-006, VAL-DRAFT-032).
    const row = rowOf(page);
    await expect(row).toBeVisible();
    await expect(headlineOf(page)).toHaveText(/^(?:[0-9]|[1-9][0-9]|100)$/);
    await expect(row).toHaveAttribute('data-headline-source', 'local');
    await expect(row).toHaveAttribute('data-jev-state', 'pending');
    await expect(row).toContainText('Viral potential');
    await expect(expandedOf(page)).toHaveCount(0); // the block does not exist until a row click
    await expect(page.getByTestId('overlay-signals')).toHaveCount(0);

    // One row click expands the full inline analysis for the same draft, with the AI half pending.
    await expand(page);
    await expect(page.getByTestId('overlay-signals')).toBeVisible(); // the signal chips
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'pending');
    await expect(page.getByTestId('overlay-jev-notice')).toContainText('AI judgment on its way');

    // Release: the verdict is added asynchronously, beside the unchanged local chips, in the
    // SAME open block (a reply is not a user edit, so the block does not collapse).
    parked[0]!.release();
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict');
    await expect(page.getByTestId('overlay-jev-band')).toHaveText('AI · Moderate');
    await expect(page.getByTestId('overlay-jev-try-line')).toContainText('65% confidence');
    // The hybrid headline applies ONLY now that the verdict is displayed (VAL-DRAFT-045).
    await expect(row).toHaveAttribute('data-headline-source', 'hybrid');
    await expect(page.getByTestId('overlay-signals')).toBeVisible(); // never relabeled or removed
    await expect(page.getByTestId('overlay-jev-weakness')).not.toBeEmpty();

    // Collapsing keeps the row, now showing the hybrid headline (VAL-DRAFT-035).
    const hybrid = await headlineOf(page).innerText();
    await collapse(page);
    await expect(headlineOf(page)).toHaveText(hybrid);
  });

  test('one row click expands all three sections for the current draft (VAL-DRAFT-034)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, 'What changed my year? A daily checklist. #focus #systems https://example.com/post');
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
    await expect(rowOf(page)).toBeVisible();
    await expect(expandedOf(page)).toHaveCount(0);

    await rowOf(page).click(); // exactly one click
    await expect(expandedOf(page)).toBeVisible();
    await expect(expandedOf(page)).toHaveAttribute('data-state', 'analyzed');
    await expect(page.getByTestId('overlay-signals')).toBeVisible(); // Algorithm signals chips
    await expect(page.getByTestId('overlay-jev')).toBeVisible(); // AI judgment
    await expect(page.getByTestId('overlay-optimizer')).toBeVisible(); // Stronger hooks
    // The row stays, expanded, and reports the state accessibly (VAL-DRAFT-046).
    await expect(rowOf(page)).toHaveAttribute('aria-expanded', 'true');
  });

  test('explains the local score with the six concrete algorithm signals (VAL-DRAFT-007, VAL-DRAFT-044)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    const errors = collectErrors(page);
    await typeDraft(page, 'What changed my year? One daily checklist. #focus #systems https://example.com/post');
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
    await expand(page);

    // The chips cap at 4 non-zero signals by |points|; the "N neutral ›" toggle reveals the full
    // rows list (ALL signals, plus the verdict's remaining weaknesses/suggestions). The six
    // families are checked across chips ∪ rows: each appears as a chip or in the rows list.
    const toggle = page.getByTestId('overlay-neutral-toggle');
    if ((await toggle.count()) > 0) await toggle.click();
    const union = page.getByTestId('overlay-signals');
    for (const id of ['reply-magnet', 'length', 'hashtags', 'external-link', 'media', 'reply-mutual']) {
      const asChip = await union.locator(`[data-testid="overlay-chip"][data-signal-id="${id}"]`).count();
      const inRows = await union.locator(`li[data-signal-id="${id}"]`).count();
      expect(asChip + inRows, `signal ${id} must appear as a chip or a row`).toBeGreaterThanOrEqual(1);
      expect(asChip).toBeLessThanOrEqual(1);
    }
    // Signed point formatting: positive "+n", negative "−n" (U+2212), never a bare 0 on a chip.
    const chips = page.getByTestId('overlay-chip');
    expect(await chips.count()).toBeLessThanOrEqual(4);
    const chipText = await chips.allInnerTexts();
    for (const text of chipText) expect(text).toMatch(/(?:\+\d+|−\d+)/);
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
      // Typing collapsed the block: re-expand for this draft's band assertions.
      await expect(expandedOf(page)).toHaveCount(0);
      await expand(page);
      await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict');
      await expect(page.getByTestId('overlay-jev-band')).toHaveText(`AI · ${BANDS[index]}`);
      await expect(page.getByTestId('overlay-jev-try-line')).toContainText('71% confidence');
      // The ordinal is never presented as a probability or percentage (no "20%", "40%", ...).
      const ordinalPercent = Math.round((ordinal / 5) * 100);
      const jevText = await page.getByTestId('overlay-jev').innerText();
      expect(jevText).not.toMatch(new RegExp(`(^|[^0-9])${ordinalPercent}([^0-9]|$)`));
      await collapse(page);
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
    await expect(page.getByTestId('overlay-jev-band')).toHaveText('AI · Exceptional'); // B settled first
    const headlineForB = await headlineOf(page).innerText();

    parked[0]!.release(); // A's stale response arrives LAST
    await page.waitForTimeout(500); // give the late reply time to (be discarded)
    await expect(page.getByTestId('overlay-jev-band')).toHaveText('AI · Exceptional');
    const jevText = await page.getByTestId('overlay-jev').innerText();
    expect(jevText).not.toContain('Weak hook'); // A's weakness never paints B's result
    // A never overwrites B's row headline either (VAL-DRAFT-011, new model).
    await collapse(page);
    await expect(headlineOf(page)).toHaveText(headlineForB);
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
    // Neither the row nor the expanded block may remain: the composer area is left completely free.
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(0, { timeout: 5_000 });
    await expect(rowOf(page)).toHaveCount(0);
    await expect(expandedOf(page)).toHaveCount(0);
    await expect(page.getByTestId('overlay-signals')).toHaveCount(0);
    await expect(page.getByTestId('overlay-jev')).toHaveCount(0);
  });

  test('keeps local scoring usable with a Connect Jev prompt when no key exists (VAL-DRAFT-017)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    const page = await openFixture(context);
    const errors = collectErrors(page);
    await typeDraft(page, 'A local-only draft long enough to be scored without a key');
    await expect(rowOf(page)).toBeVisible({ timeout: 5_000 });

    // The row keeps the local score and implies no AI verdict exists.
    await expect(rowOf(page)).toHaveAttribute('data-headline-source', 'local');
    await expect(rowOf(page)).toHaveAttribute('data-jev-state', 'no-key');
    expect(calls).toHaveLength(0); // no Jev request without a key

    await expand(page);
    await expect(headlineOf(page)).toHaveText(/^(?:[0-9]|[1-9][0-9]|100)$/);
    await expect(rowOf(page)).toHaveAttribute('data-headline-source', 'local'); // no hybrid without AI
    await expect(page.getByTestId('overlay-signals')).toBeVisible();
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'no-key');
    await expect(page.getByTestId('overlay-jev-notice')).toContainText('Local signals only.');
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
    await expect(page.getByTestId('overlay-jev-notice')).toContainText('AI unavailable — the');
    await expect(page.getByTestId('overlay-jev')).toContainText('Could not reach the AI service.');
    await expect(page.getByTestId('overlay-retry')).toHaveText('Retry');

    // Every draft in this test ends in the SAME failure state, so the HTTP draft would look
    // settled before its own request is even made. Its Jev request is therefore awaited: the
    // network draft's failure is a separate dispatch (per-draft ownership, VAL-DRAFT-018) and
    // must never be able to satisfy this assertion.
    await typeDraft(page, drafts.http); // typing collapses the block; the row stays usable
    await expect(expandedOf(page)).toHaveCount(0);
    await expect(rowOf(page)).toBeVisible();
    await expect.poll(() => calls.filter((call) => call.state.startsWith(drafts.http)).length, {
      timeout: 10_000,
    }).toBe(1);
    await expand(page);
    await expect(page.getByTestId('overlay-jev')).toContainText('HTTP 500', { timeout: 10_000 });
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'error');

    await typeDraft(page, drafts.malformed);
    await expect(expandedOf(page)).toHaveCount(0);
    await expect.poll(() => calls.filter((call) => call.state.startsWith(drafts.malformed)).length, {
      timeout: 10_000,
    }).toBe(1);
    await expand(page);
    await expect(page.getByTestId('overlay-jev')).toContainText('unreadable response', { timeout: 10_000 });

    // Typing and page interaction remain functional; the local score stayed rendered throughout.
    await expect(page.getByTestId('overlay-signals')).toBeVisible();
    await collapse(page);
    await expect(rowOf(page)).toHaveAttribute('data-jev-state', 'error');
    expect(errors).toEqual([]);
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  test('a failed draft\'s Retry shows the pending state until the retry settles, on both failure paths (VAL-DRAFT-010, M6-SCRUTINY-003)', async ({ context }) => {
    const drafts = {
      result: 'Retry pending draft one: what small habit changed your mornings?',
      transport: 'Retry pending draft two: why does the hook decide everything?',
    };
    // Draft one: the FIRST Jev call fails with an HTTP 500 (a Jev-result failure); its RETRY call
    // is parked (held in flight) until the test releases it. Draft two: the first dispatch burns
    // the Jev client's own 3 transport attempts (all aborted — network errors retry twice),
    // surfacing the transport error; its RETRY call is parked too.
    const counts = new Map<string, number>();
    const { calls, parked } = await interceptJev(context, ({ state }) => {
      const prefix = (Object.values(drafts) as string[]).find((d) => state.startsWith(d));
      if (prefix === undefined) return { action: 'fulfill', body: jevResponse({ ordinal: 3 }) };
      const n = (counts.get(prefix) ?? 0) + 1;
      counts.set(prefix, n);
      if (prefix === drafts.result) {
        return n === 1
          ? { action: 'status', status: 500, text: 'boom' }
          : { action: 'park', body: jevResponse({ ordinal: 4 }) };
      }
      return n <= 3 ? { action: 'abort' } : { action: 'park', body: jevResponse({ ordinal: 3 }) };
    });
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    const errors = collectErrors(page);

    // ---- leg 1: the Jev-result failure path ----
    await typeDraft(page, drafts.result);
    await expand(page);
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'error', { timeout: 10_000 });
    await page.getByTestId('overlay-retry').click();
    // While the retried response is held: pending in row AND block, local score kept, no live Retry.
    await expect(rowOf(page)).toHaveAttribute('data-jev-state', 'pending');
    await expect(rowOf(page)).toHaveAttribute('data-headline-source', 'local');
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'pending');
    await expect(page.getByTestId('overlay-jev-notice')).toContainText('AI judgment on its way');
    await expect(page.getByTestId('overlay-retry')).toHaveCount(0);
    parked[0]!.release();
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict', { timeout: 10_000 });
    await collapse(page);

    // ---- leg 2: the transport-error path ----
    await typeDraft(page, drafts.transport);
    await expect.poll(
      () => calls.filter((call) => call.state.startsWith(drafts.transport)).length,
      { timeout: 10_000 },
    ).toBe(3); // the first dispatch exhausts the client's own retry attempts
    await expand(page);
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'error', { timeout: 10_000 });
    await page.getByTestId('overlay-retry').click();
    await expect(rowOf(page)).toHaveAttribute('data-jev-state', 'pending');
    await expect(rowOf(page)).toHaveAttribute('data-headline-source', 'local');
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'pending');
    await expect(page.getByTestId('overlay-jev-notice')).toContainText('AI judgment on its way');
    await expect(page.getByTestId('overlay-retry')).toHaveCount(0);
    parked[1]!.release();
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict', { timeout: 10_000 });
    expect(errors).toEqual([]);
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
    await expect(rowOf(page)).toBeVisible({ timeout: 5_000 });
    await expect(rowOf(page)).toHaveAttribute('data-headline-source', 'local');
    await expect(rowOf(page)).toHaveAttribute('data-jev-state', 'off');

    await expand(page);
    await expect(page.getByTestId('overlay-signals')).toBeVisible();
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'off');
    await expect(page.getByTestId('overlay-jev-notice')).toContainText('AI analysis is off in Settings.');
    await expect(page.getByTestId('overlay-jev-notice')).toHaveCount(1); // nothing implies AI ran
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

    // Phase 1: the tab shows a settled AI verdict for draft A in the expanded block.
    await typeDraft(page, draftA);
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
    await expand(page);
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict');
    await expect(rowOf(page)).toHaveAttribute('data-headline-source', 'hybrid');

    // Phase 2: draft B is dispatched and PARKED; typing collapsed the block, so re-expand while
    // the user then turns AI off from the Options page.
    await typeDraft(page, draftB);
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(2);
    await expand(page);
    // The block must stay open across an Options-page interaction: the block lives in the tab,
    // the setting is saved in another page, and a preference change re-renders IN PLACE — it
    // never collapses the analysis the user is looking at.
    await options.getByTestId('pref-jevForDrafts').uncheck();
    await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');
    // The block must still be open here, and reading it is race-free: `toHaveAttribute` retries.
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'off', { timeout: 5_000 });
    await expect(rowOf(page)).toHaveAttribute('data-headline-source', 'local');
    await expect(page.getByTestId('overlay-jev-band')).toHaveCount(0);

    // Phase 3: B's late result arrives — it must NOT re-introduce the verdict. The parked call is
    // a real in-flight request, so waiting for the tab to consume it is the deterministic proof
    // that the reply was processed and discarded, not merely ignored. Every read here retries
    // (`toHaveAttribute`/`toContainText`), and none of them can match the PRE-release state: draft
    // B's band was never rendered (the block went straight to local-only when AI was switched
    // off), so "Strong" can only appear if the late verdict was actually re-introduced.
    parked[0]!.release();
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'off', { timeout: 10_000 });
    await expect(rowOf(page)).toHaveAttribute('data-headline-source', 'local');
    await expect(page.getByTestId('overlay-jev')).not.toContainText('Strong');
    await expect(page.getByTestId('overlay-jev-band')).toHaveCount(0);
    // The row carries the same verdict state, so the guarantee is also pinned in the
    // DEFAULT surface the user actually sees while typing.
    await collapse(page);
    await expect(rowOf(page)).toHaveAttribute('data-jev-state', 'off');
    await expect(rowOf(page)).toHaveAttribute('data-headline-source', 'local');
    expect(calls).toHaveLength(2); // no NEW AI request ran once the setting was off
    expect(errors).toEqual([]);
  });

  test('autoAnalyze off shows the local row with zero Jev calls; the Analyze with AI action runs exactly one (VAL-SETUP-010)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3.44, confidence: 0.65 }) }));
    const options = await saveKeyViaOptions(context);
    await options.getByTestId('pref-autoAnalyze').uncheck();
    await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');
    await options.close();

    const page = await openFixture(context);
    await typeDraft(page, 'A draft typed while autoAnalyze is off');
    await page.waitForTimeout(1_200); // past the debounce: nothing may analyze automatically

    // The LOCAL score is always computed (no network) and always shown in the row.
    await expect(rowOf(page)).toBeVisible();
    await expect(headlineOf(page)).toHaveText(/^(?:[0-9]|[1-9][0-9]|100)$/);
    await expect(rowOf(page)).toHaveAttribute('data-jev-state', 'ready'); // nothing is in flight
    expect(calls).toHaveLength(0); // ZERO Jev requests before the action is activated

    await expand(page);
    await expect(page.getByTestId('overlay-signals')).toBeVisible();
    const analyze = page.getByTestId('overlay-analyze');
    await expect(analyze).toHaveText('Analyze with AI');
    expect(calls).toHaveLength(0); // still nothing: the action has not been activated

    // Exactly one Jev analysis on activation, and its verdict renders in the SAME block.
    await analyze.click();
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict');
    await expect(page.getByTestId('overlay-jev-band')).toHaveText('AI · Moderate');
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

    // The host is our own element inserted IN FLOW as the toolBar's preceding sibling — X's own
    // nodes are never moved, modified or wrapped (VAL-DRAFT-041).
    expect(
      await page.evaluate(() => {
        const host = document.querySelector('#amplifyx-overlay-host');
        const toolBar = document.querySelector('[data-testid="toolBar"]');
        const reactRoot = document.querySelector('#react-root');
        return (
          host !== null &&
          toolBar !== null &&
          reactRoot !== null &&
          reactRoot.contains(host) &&
          toolBar.previousElementSibling === host
        );
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

  test('the status row sits in flow before the toolBar as one 36px line at every viewport (VAL-DRAFT-041, VAL-DRAFT-043)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);

    // A short draft and an overlong one: the row's height must stay 36px across both, with the
    // middle summary ellipsis-truncated and never wrapped (VAL-DRAFT-043).
    for (const text of [
      'A short scored draft for the row pin',
      'An overlong scored draft for the row pin that keeps going and keeps going, with a very long winding summary line that must never wrap onto a second row and must be truncated with an ellipsis instead, no matter how many words the user types into the composer, because the row always stays exactly one line tall',
    ]) {
      await typeDraft(page, text);
      await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
      for (const size of [
        { width: 1280, height: 900 },
        { width: 900, height: 700 },
        { width: 520, height: 640 },
      ]) {
        await page.setViewportSize(size);
        // The host is in flow, immediately before the toolBar, in the window's width.
        await expect
          .poll(async () => {
            const box = await rowOf(page).boundingBox();
            return box !== null && box.height === 36 && box.width > 0;
          }, { timeout: 5_000 })
          .toBe(true);
        expect(
          await page.evaluate(() => {
            const host = document.querySelector('#amplifyx-overlay-host');
            const toolBar = document.querySelector('[data-testid="toolBar"]');
            return host !== null && toolBar !== null && toolBar.previousElementSibling === host;
          }),
        ).toBe(true);
        // The summary truncates with ellipsis and never wraps.
        expect(await shadowStyle(page, '.summary', 'overflowX')).toBe('hidden');
        expect(await shadowStyle(page, '.summary', 'whiteSpace')).toBe('nowrap');
        expect(await shadowStyle(page, '.row', 'height')).toBe('36px');
        // Exactly one host, no duplicates.
        await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);
      }
    }
  });

  test('a fallback-mounted row becomes the toolbar sibling when a toolbar appears (VAL-DRAFT-041, M6-SCRUTINY-002)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    const errors = collectErrors(page);

    // Remove the toolbar BEFORE typing: the draft must mount in the absolute fallback.
    await page.evaluate(() => {
      const toolBar = document.querySelector('[data-testid="toolBar"]');
      (window as unknown as Record<string, unknown>)['__toolBarParent'] = toolBar!.parentElement;
      toolBar!.remove();
    });
    await typeDraft(page, 'A draft long enough to mount its row without a toolbar present');
    await expect(rowOf(page)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(OVERLAY_HOST)).toHaveAttribute('data-placement', 'fallback');
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);

    // React inserts a toolbar into the composer region WITHOUT touching the connected host:
    // the SAME host must reconcile to the toolbar's immediate preceding sibling.
    await page.evaluate(() => {
      const toolBar = document.createElement('div');
      toolBar.setAttribute('data-testid', 'toolBar');
      ((window as unknown as Record<string, unknown>)['__toolBarParent'] as HTMLElement).append(toolBar);
    });
    await expect(page.locator(OVERLAY_HOST)).toHaveAttribute('data-placement', 'flow', { timeout: 10_000 });
    const geometry = await page.evaluate(() => {
      const host = document.querySelector('#amplifyx-overlay-host');
      const toolBar = document.querySelector('[data-testid="toolBar"]');
      return {
        isPreviousSibling: toolBar!.previousElementSibling === host,
        sharesParent: host!.parentElement === toolBar!.parentElement,
        hosts: document.querySelectorAll('#amplifyx-overlay-host').length,
        rowVisible: host!.shadowRoot!.querySelector('[data-testid="amplifyx-overlay-row"]') !== null,
      };
    });
    expect(geometry).toEqual({ isPreviousSibling: true, sharesParent: true, hosts: 1, rowVisible: true });
    expect(calls.length).toBe(1); // the reconciliation itself sends no Jev request
    expect(errors).toEqual([]);
  });

  test('Escape collapses the expanded block and keeps the row (VAL-DRAFT-035)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, 'A draft whose analysis collapses with the Escape key');
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
    await expand(page);
    const headline = await headlineOf(page).innerText();

    await page.keyboard.press('Escape');
    await expect(expandedOf(page)).toHaveCount(0);
    await expect(rowOf(page)).toBeVisible();
    await expect(headlineOf(page)).toHaveText(headline); // the row remains, with the current score
  });

  test('the first outside click collapses the block AND reaches the page natively (VAL-DRAFT-037)', async ({ context }) => {
    await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, 'A draft analyzed before the forwarded outside click is exercised');
    await expect(rowOf(page)).toBeVisible({ timeout: 10_000 });
    await expand(page);

    // The fixture records every click that reaches the PAGE (bubble phase), plus the URL.
    const clicksBefore = await fixtureClicks(page);
    const urlBefore = page.url();

    // Click a page element that lies outside the expanded block: the first timeline post. The
    // M5 first-click capture exception is REMOVED: the collapse and the activation happen on
    // the SAME first click.
    const article = page.locator('article[data-testid="tweet"]').first();
    await article.click({ position: { x: 5, y: 5 } });
    await expect(expandedOf(page)).toHaveCount(0); // the block collapsed...
    await expect(rowOf(page)).toBeVisible();
    await expect.poll(async () => (await fixtureClicks(page)) !== clicksBefore).toBe(true); // ...and the page got the click
    expect(page.url()).toBe(urlBefore);

    // The next identical click still reaches the page natively.
    const after = await fixtureClicks(page);
    await article.click({ position: { x: 5, y: 5 } });
    await expect.poll(async () => (await fixtureClicks(page)) !== after).toBe(true);
  });

  test('typing collapses the expanded block so X popups are never covered (VAL-DRAFT-036)', async ({ context }) => {
    await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, 'A draft analyzed while the user keeps editing the composer');
    await expect(rowOf(page)).toBeVisible({ timeout: 10_000 });
    await expand(page);
    await expect(expandedOf(page)).toBeVisible();

    // The FIRST new user edit collapses the block back to the row — the deterministic
    // anti-occlusion guarantee behind X's mention/emoji/GIF popups.
    await page.locator(HOME_COMPOSER).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' with one more clause added right now');
    await expect(expandedOf(page)).toHaveCount(0, { timeout: 5_000 });
    await expect(rowOf(page)).toBeVisible();
  });

  test('the collapsed row leaves the page fully interactive (VAL-DRAFT-038)', async ({ context }) => {
    const { calls } = await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, 'A draft whose collapsed row must not swallow page interaction');
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
    await expect(rowOf(page)).toBeVisible();

    // Page scrolling works over and around the row: the wheel is the page's own. A short
    // viewport guarantees the fixture timeline overflows, so there is always something to scroll.
    await page.setViewportSize({ width: 900, height: 400 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight))
      .toBe(true);
    await page.mouse.wheel(0, 400);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await page.mouse.wheel(0, -400);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

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
    // The row is still the only extension surface near the composer throughout.
    await expect(expandedOf(page)).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  test('activating the row pushes the toolbar down without overlapping composer chrome (VAL-DRAFT-042)', async ({ context }) => {
    await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, 'A draft whose inline expansion must push the toolbar down cleanly');
    await expect(rowOf(page)).toBeVisible({ timeout: 10_000 });

    for (const size of [
      { width: 1280, height: 900 },
      { width: 520, height: 640 }, // a small viewport is part of the contract
    ]) {
      await page.setViewportSize(size);
      const toolBarBefore = await page.locator(TOOLBAR).boundingBox();
      await expand(page);
      await expect(page.getByTestId('overlay-signals')).toBeVisible();

      // The expanded block sits in flow: the toolbar (and Post button) moved DOWN.
      const toolBarAfter = await page.locator(TOOLBAR).boundingBox();
      const blockBox = await expandedOf(page).boundingBox();
      expect(toolBarBefore).not.toBeNull();
      expect(toolBarAfter).not.toBeNull();
      expect(blockBox).not.toBeNull();
      expect(toolBarAfter!.y).toBeGreaterThanOrEqual(toolBarBefore!.y + 40); // pushed below the row+block
      // Zero overlap with every composer control, at every size.
      for (const selector of [HOME_COMPOSER, MEDIA_BUTTON, COUNTER, POST_BUTTON]) {
        const box = await page.locator(selector).boundingBox();
        expect(overlaps(blockBox, box), `the expanded block must not cover ${selector}`).toBe(false);
      }
      // The toolbar stays fully visible and usable below the block.
      expect(toolBarAfter!.y).toBeGreaterThanOrEqual(blockBox!.y + blockBox!.height - 1);
      await collapse(page);
    }
  });

  test('the expanded block caps at its max height and scrolls internally to its end (VAL-DRAFT-039, D2)', async ({ context }) => {
    await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, 'What changed my year? A daily checklist that stuck. #focus #systems #writing https://example.com/post — a draft whose analysis is tall enough to overflow the block budget');
    await expect(rowOf(page)).toBeVisible({ timeout: 10_000 });
    await expand(page);
    await expect(page.getByTestId('overlay-optimizer')).toBeVisible();

    // The D2 mechanism on the real page: the block's max height is the configured budget and it
    // scrolls internally (the full scroll-to-its-end flow is pinned in the optimizer spec).
    expect(await shadowStyle(page, '.expanded', 'maxHeight')).toBe('420px');
    expect(await shadowStyle(page, '.expanded', 'overflowY')).toBe('auto');

    // Still exactly one host, and the toolbar remains a sibling below (in flow, no floating UI).
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);
    expect(
      await page.evaluate(() => {
        const host = document.querySelector('#amplifyx-overlay-host');
        const toolBar = document.querySelector('[data-testid="toolBar"]');
        return host !== null && toolBar !== null && toolBar.previousElementSibling === host;
      }),
    ).toBe(true);
  });

  test('the popup master switch removes and restores the overlay in the open tab without a reload (VAL-SETUP-016)', async ({ context }) => {
    await interceptJev(context, () => ({ action: 'fulfill', body: jevResponse({ ordinal: 3 }) }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, 'A draft analyzed before the master switch is toggled');
    await expect(rowOf(page)).toBeVisible({ timeout: 10_000 });
    const urlBefore = page.url();

    const popup = await context.newPage();
    await popup.goto(await popupUrl(context));
    await expect(popup.getByTestId('key-indicator')).toBeVisible();
    await popup.getByTestId('master-toggle').click();

    await expect(page.locator(OVERLAY_HOST)).toHaveCount(0, { timeout: 5_000 }); // removed, no reload
    expect(page.url()).toBe(urlBefore);

    await popup.getByTestId('master-toggle').click();
    expect(page.url()).toBe(urlBefore);

    // Injection works again after re-enabling: the fresh composer starts collapsed, so the row
    // is the only surface until the user clicks it.
    await typeDraft(page, ' A second draft typed after re-enabling the extension');
    await expect(rowOf(page)).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);
    await expect(expandedOf(page)).toHaveCount(0);
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
    await expect(rowOf(page)).toHaveAttribute('data-jev-state', 'no-key', { timeout: 5_000 });
    await expand(page);
    await expect(page.getByTestId('overlay-connect-jev')).toBeVisible();
    expect(calls).toHaveLength(0);

    // Configure the key in Options; the same tab (no reload) picks it up on the NEXT draft. The
    // preference change must not collapse the block, so the waiting below is on the block.
    await saveKeyViaOptions(context);
    await typeDraft(page, 'Draft two, typed after the key was configured in Options');
    await expect(expandedOf(page)).toHaveCount(0);
    await expand(page);
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict', { timeout: 10_000 });
    await expect(page.getByTestId('overlay-jev-band')).toHaveText('AI · Strong');
    await expect(rowOf(page)).toHaveAttribute('data-headline-source', 'hybrid');
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

    // The reply draft is scored against the reply composer, collapsed-first like the home one
    // (the reply dialog has no toolBar, so the row may use the fallback placement — same anatomy).
    await page.locator('[data-testid="tweetTextarea_1"]').click();
    await page.keyboard.type('Reply draft long enough to analyze');
    await expect(rowOf(page)).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1); // exactly one, for the reply view
    await expect(expandedOf(page)).toHaveCount(0);
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
    await expect(rowOf(page)).toBeVisible({ timeout: 30_000 });
    await expand(page);
    await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'verdict', { timeout: 30_000 });
    const bandText = await page.getByTestId('overlay-jev-band').innerText();
    expect(['AI · Weak', 'AI · Below avg', 'AI · Moderate', 'AI · Strong', 'AI · Exceptional']).toContain(bandText);
    await expect(page.getByTestId('overlay-jev-try-line')).toHaveText(/confidence/);
    await expect(rowOf(page)).toHaveAttribute('data-headline-source', 'hybrid');
    await expect(page.getByTestId('overlay-signals')).toBeVisible();

    // Key secrecy: neither the page nor the console ever carries the key value.
    const blockText = await page.getByTestId('amplifyx-overlay').innerText();
    expect(blockText).not.toContain(liveKey);
    expect(errors.join('\n')).not.toContain(liveKey);
    expect(consoleText.join('\n')).not.toContain(liveKey);
    expect(errors).toEqual([]);
  });
});
