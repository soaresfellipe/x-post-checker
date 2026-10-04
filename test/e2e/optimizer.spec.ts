import type { BrowserContext, Page, Route } from '@playwright/test';
import { expect, FIXTURE_URL, optionsUrl, test } from './extension';
import { VERIFIED_JEV_RESPONSE } from '../helpers/jev-fixtures';

/**
 * Optimizer E2E on the x.com fixture (m4-optimizer): the full flow through the REAL background —
 * overlay "Optimize" action -> message protocol -> OptimizerService -> JevClient -> (intercepted)
 * api.typesafe.ai — with FIXTURE-CONTROLLED `noul` responses (verified live in
 * test/unit/optimizer-noul-live.test.ts) so the presented variant set is deterministic
 * (VAL-OPT-002/003). Covers availability with reasons (VAL-OPT-001), exact-text clipboard copy
 * (VAL-OPT-004) that never touches the composer (VAL-OPT-005), the over-limit flag (VAL-OPT-007),
 * the unchanged-draft single-call cache (VAL-OPT-009), non-blocking failures (VAL-OPT-010), and
 * the English-only optimizer surface (VAL-CROSS-016).
 */

const SYNTHETIC_KEY = 'key-optimizer-e2e-0001';
const HOME_COMPOSER = '[data-testid="tweetTextarea_0"]';
// The fixed known draft: deterministic variants (unit-pinned) and deterministic hashtag
// candidates (system x2, then productivity/complicated/checklist/replaced by length).
const FIXED_DRAFT =
  'I replaced my complicated productivity system with one daily checklist. The system now runs itself.';

interface CapturedJevCall {
  url: string;
  body: string;
  /** True when the request is an OPTIMIZE exchange (variant_ noul questions), not draft analysis. */
  isOptimize: boolean;
}

type JevAnswer = { action: 'fulfill'; body: unknown } | { action: 'status'; status: number; text: string };

/** The fixture noul reply for the optimize exchange: ranked so the presentation cut is visible. */
function noulOptimizeResponse(variantProbabilities: Record<string, number>, hashtagProbabilities: number[]): unknown {
  const answers: Record<string, unknown> = {};
  for (const [id, noul] of Object.entries(variantProbabilities)) answers[id] = { type: 'noul', noul };
  for (const [index, noul] of hashtagProbabilities.entries()) {
    answers[`hashtag_${index}`] = { type: 'noul', noul };
  }
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 10 } };
}

/** Intercepts api.typesafe.ai, answering optimize and analysis exchanges differently. */
async function interceptJev(
  context: BrowserContext,
  respond: (call: { isOptimize: boolean; state: string; index: number }) => JevAnswer,
): Promise<{ calls: CapturedJevCall[] }> {
  const calls: CapturedJevCall[] = [];
  await context.route('https://api.typesafe.ai/**', async (route: Route) => {
    const request = route.request();
    const body = request.postData() ?? '';
    let parsed: { state?: string; questions?: Record<string, unknown> } = {};
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      parsed = {};
    }
    const isOptimize = Object.keys(parsed.questions ?? {}).some((id) => id.startsWith('variant_'));
    const index = calls.length;
    calls.push({ url: request.url(), body, isOptimize });
    const answer = respond({ isOptimize, state: parsed.state ?? '', index });
    if (answer.action === 'status') {
      await route.fulfill({ status: answer.status, contentType: 'text/plain', body: answer.text });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer.body) });
  });
  return { calls };
}

const optimizeCalls = (calls: CapturedJevCall[]): CapturedJevCall[] => calls.filter((call) => call.isOptimize);

/** Ranked so the presentation order is visible: question 0.87, claim 0.55, story 0.42. The
 * number probability (0.64) is unused for the digit-less FIXED_DRAFT (no number variant applies),
 * and with three generated variants none is cut — the max-3 drop rule is pinned in the unit and
 * DOM suites; here the ranked ORDER is the assertion. */
const RANKED_FIXTURE = noulOptimizeResponse(
  { variant_question: 0.87, variant_number: 0.64, variant_claim: 0.55, variant_story: 0.42 },
  [0.91, 0.8, 0.7, 0.6, 0.5],
);

async function saveKeyViaOptions(context: BrowserContext, key: string = SYNTHETIC_KEY): Promise<void> {
  const options = await context.newPage();
  await options.goto(await optionsUrl(context));
  await expect(options.getByTestId('key-status')).not.toBeEmpty();
  await options.getByTestId('api-key-input').fill(key);
  await options.getByTestId('save-key').click();
  await expect(options.getByTestId('key-status')).toHaveAttribute('data-state', 'present');
  await options.close();
}

async function openFixture(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#amplifyx-marker-host')).toHaveAttribute('data-watcher-state', 'watching');
  return page;
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}

const panelOf = (page: Page) => page.getByTestId('amplifyx-overlay');
const pillOf = (page: Page) => page.getByTestId('amplifyx-overlay-pill');

/**
 * Clears the composer (select-all + backspace) and types `text`, so sequential drafts in one test
 * are independent (a leftover previous draft would change the draft hash and the request state).
 *
 * Collapses first when the panel is open: the first click outside an expanded panel is
 * deliberately captured to close it (VAL-DRAFT-037) and never reaches the composer, so the
 * select-all shortcut only lands once the pill (collapsed state) is the surface again.
 */
async function typeDraft(page: Page, text: string): Promise<void> {
  if ((await panelOf(page).count()) > 0) {
    await page.keyboard.press('Escape');
    await expect(panelOf(page)).toHaveCount(0);
  }
  await page.locator(HOME_COMPOSER).click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text);
}

/**
 * Expands the collapsed panel through the score pill — the only way the detail panel (and with it
 * the Optimizer section) comes into existence in the M5 collapsed-first model (VAL-OPT-001,
 * VAL-DRAFT-034). Idempotent, so a flow may call it again after typing collapsed the panel.
 *
 * It also waits for the panel's own state to reach 'analyzed', so a panel is never read before
 * the watcher's debounced capture (~700ms after typing) has landed.
 */
async function expand(page: Page): Promise<void> {
  if ((await panelOf(page).count()) === 0) {
    await pillOf(page).click();
  }
  await expect(panelOf(page)).toBeVisible();
  await expect(panelOf(page)).toHaveAttribute('data-state', 'analyzed', { timeout: 10_000 });
}

/**
 * Types a draft and waits until ITS capture has landed, so the panel is never read against the
 * PREVIOUS draft.
 *
 * The deterministic signal is the content script's dispatch counter on the marker host: the
 * watcher emits the capture and dispatches in the same step, and the overlay renders from that
 * capture, so the counter reaching +1 proves the new draft is the captured one — its Optimize
 * slot (matched by draft identity) no longer applies, and an early Optimize click could not be
 * served from the old draft's cache (VAL-OPT-009's readiness rule, done once for every flow).
 */
async function typeDraftAndAwaitCapture(page: Page, text: string): Promise<void> {
  const marker = page.locator('#amplifyx-marker-host');
  const before = Number((await marker.getAttribute('data-watcher-dispatches')) ?? '0');
  await typeDraft(page, text);
  await expect(marker).toHaveAttribute('data-watcher-dispatches', String(before + 1), { timeout: 15_000 });
  await expect(panelOf(page)).toHaveCount(0); // typing collapses the panel; only the pill is up
}

/** The fresh capture's optimizer slot: 'idle' — no Optimize result for THIS draft yet. */
async function waitForFreshOptimizer(page: Page): Promise<void> {
  await expect(page.getByTestId('overlay-optimizer')).toHaveAttribute('data-optimizer-state', 'idle', {
    timeout: 10_000,
  });
}

test.describe('optimizer (m4-optimizer)', () => {
  test('Optimize is enabled for a qualifying draft with a key and hidden for an empty draft (VAL-OPT-001)', async ({ context }) => {
    await interceptJev(context, () => ({ action: 'fulfill', body: VERIFIED_JEV_RESPONSE }));
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    const errors = collectErrors(page);

    // Empty draft: M5 renders NO extension UI at all, so there is no Optimize affordance.
    await expect(page.locator('#amplifyx-overlay-host')).toHaveCount(0);
    await expect(pillOf(page)).toHaveCount(0);
    await expect(page.getByTestId('overlay-optimizer')).toHaveCount(0);

    // Qualifying draft + key: the collapsed pill appears, and one click reveals the enabled
    // Optimize action inside the expanded panel.
    await typeDraft(page, FIXED_DRAFT);
    await expand(page);
    await expect(page.getByTestId('overlay-optimize')).toHaveAttribute('data-state', 'enabled');
    await expect(page.getByTestId('overlay-optimize')).toHaveText('Optimize');
    expect(errors).toEqual([]);
  });

  test('no key renders the disabled state whose guidance points to Options (VAL-OPT-001)', async ({ context }) => {
    await interceptJev(context, () => ({ action: 'fulfill', body: VERIFIED_JEV_RESPONSE }));
    const page = await openFixture(context);
    await typeDraft(page, FIXED_DRAFT);
    await expect(pillOf(page)).toBeVisible();
    await expand(page);

    const section = page.getByTestId('overlay-optimizer');
    await expect(section).toHaveAttribute('data-optimizer-state', 'no-key');
    await expect(page.getByTestId('overlay-optimize')).toHaveAttribute('data-state', 'disabled');
    await expect(page.getByTestId('overlay-optimizer-notice')).toContainText('Connect Jev in Options');
    await expect(page.getByTestId('overlay-optimizer-connect')).toBeVisible();
  });

  test('click -> loading -> deterministic ranked variants and hashtag suggestions (VAL-OPT-002, VAL-OPT-003, VAL-OPT-006)', async ({ context }) => {
    const { calls } = await interceptJev(context, ({ isOptimize }) =>
      isOptimize ? { action: 'fulfill', body: RANKED_FIXTURE } : { action: 'fulfill', body: VERIFIED_JEV_RESPONSE },
    );
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    const errors = collectErrors(page);
    await typeDraft(page, FIXED_DRAFT);
    await expect(pillOf(page)).toBeVisible();
    await expand(page);

    await page.getByTestId('overlay-optimize').click();
    // The fixture replies within milliseconds, so the transient loading state can resolve before
    // an assertion samples it (the pending copy is pinned in the DOM suite with a deferred client);
    // this E2E pins the end-to-end outcomes: success, the ranked list, and the API-call count.
    await expect(page.getByTestId('overlay-optimizer')).toHaveAttribute('data-optimizer-state', 'done');
    // Exactly ONE optimize exchange for this unique draft, after the auto-analyze one.
    await expect.poll(() => optimizeCalls(calls).length, { timeout: 10_000 }).toBe(1);

    // Deterministic ranked order: question (0.87), claim (0.55), story (0.42). The digit-less
    // FIXED_DRAFT generates exactly these three variants (no number lead without digits), so all
    // three present — the assertion is the noul-ranked ORDER, not a cut.
    const items = page.getByTestId('overlay-optimizer-variant');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toHaveAttribute('data-variant-kind', 'question');
    await expect(items.nth(0).getByTestId('overlay-optimizer-variant-text')).toHaveText(
      'What happened when I replaced my complicated productivity system with one daily checklist? The system now runs itself.',
    );
    await expect(items.nth(1)).toHaveAttribute('data-variant-kind', 'claim');
    // The claim hook is the pure reorder: the concluding sentence leads.
    await expect(items.nth(1).getByTestId('overlay-optimizer-variant-text')).toContainText(
      'The system now runs itself. I replaced',
    );
    await expect(items.nth(2)).toHaveAttribute('data-variant-kind', 'story');
    await expect(items.nth(2).getByTestId('overlay-optimizer-variant-text')).toContainText("Here's what happened:");

    // Hashtag suggestions: top three by the fixture's topicality probabilities, each with a
    // one-line rationale naming the draft term (VAL-OPT-006 evidence for the manual review).
    const suggestions = page.getByTestId('overlay-optimizer-hashtag');
    await expect(suggestions).toHaveCount(3);
    await expect(suggestions.nth(0)).toHaveAttribute('data-tag', 'System');
    await expect(suggestions.nth(0)).toContainText('#System');
    await expect(suggestions.nth(0)).toContainText('Comes straight from your draft ("system")');
    await expect(suggestions.nth(1)).toHaveAttribute('data-tag', 'Productivity');
    await expect(suggestions.nth(2)).toHaveAttribute('data-tag', 'Complicated');
    expect(errors).toEqual([]);
  });

  test('copy puts exactly the variant text on the clipboard and the composer is never altered (VAL-OPT-004, VAL-OPT-005)', async ({ context }) => {
    const { calls } = await interceptJev(context, ({ isOptimize }) =>
      isOptimize ? { action: 'fulfill', body: RANKED_FIXTURE } : { action: 'fulfill', body: VERIFIED_JEV_RESPONSE },
    );
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: FIXTURE_URL });
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, FIXED_DRAFT);
    await expect(pillOf(page)).toBeVisible();
    await expand(page);

    await page.getByTestId('overlay-optimize').click();
    const firstCopy = page.getByTestId('overlay-optimizer-copy').first();
    await expect(firstCopy).toBeVisible();
    const expectedText = await page
      .getByTestId('overlay-optimizer-variant-text')
      .first()
      .innerText();

    await firstCopy.click();
    await expect(firstCopy).toHaveText('Copied');
    // EXACT transfer: the clipboard holds the variant text alone — no labels, no extra text.
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(expectedText);

    // VAL-OPT-005: generating and copying never touch the composer text.
    const composerText = await page.locator(HOME_COMPOSER).innerText();
    expect(composerText).toContain(FIXED_DRAFT);
    expect(optimizeCalls(calls)).toHaveLength(1); // no extra exchanges either
  });

  test('repeated Optimize on an unchanged draft costs zero further API calls and renders identically (VAL-OPT-009)', async ({ context }) => {
    const { calls } = await interceptJev(context, ({ isOptimize }) =>
      isOptimize ? { action: 'fulfill', body: RANKED_FIXTURE } : { action: 'fulfill', body: VERIFIED_JEV_RESPONSE },
    );
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, FIXED_DRAFT);
    await expect(pillOf(page)).toBeVisible();
    await expand(page);

    await page.getByTestId('overlay-optimize').click();
    await expect(page.getByTestId('overlay-optimizer')).toHaveAttribute('data-optimizer-state', 'done');
    await expect.poll(() => optimizeCalls(calls).length, { timeout: 10_000 }).toBe(1);
    const firstText = await page.getByTestId('overlay-optimizer-variant-text').first().innerText();

    // Second click on the SAME draft: served by the background's optimizer cache.
    await page.getByTestId('overlay-optimize').click();
    await expect(page.getByTestId('overlay-optimizer')).toHaveAttribute('data-optimizer-state', 'done');
    await expect.poll(() => optimizeCalls(calls).length, { timeout: 10_000 }).toBe(1); // still one
    await expect(page.getByTestId('overlay-optimizer-variant-text').first()).toHaveText(firstText);

    // A CHANGED draft is a new identity and pays its own (second) optimize call. The NEW capture
    // must land before clicking: the watcher's debounce keeps the OLD draft's analysis (and its
    // done-slot) current for ~700ms after typing, and an early Optimize click would (correctly)
    // be served from the old draft's cache. Typing also collapses the panel (M5 collapsed-first),
    // so the flow re-expands it and waits for the optimizer section to flip back to 'idle' — the
    // exact moment the new draft's capture invalidates the old done-slot (draft-identity match).
    // That is the deterministic ready signal.
    await typeDraftAndAwaitCapture(page, `${FIXED_DRAFT} Try it this week.`);
    await expand(page);
    await waitForFreshOptimizer(page);
    await page.getByTestId('overlay-optimize').click();
    await expect(page.getByTestId('overlay-optimizer')).toHaveAttribute('data-optimizer-state', 'done');
    await expect.poll(() => optimizeCalls(calls).length, { timeout: 10_000 }).toBe(2);
  });

  test('over-limit variants are flagged as not ready (VAL-OPT-007)', async ({ context }) => {
    await interceptJev(context, ({ isOptimize }) =>
      isOptimize ? { action: 'fulfill', body: RANKED_FIXTURE } : { action: 'fulfill', body: VERIFIED_JEV_RESPONSE },
    );
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    // A ~270-char two-sentence draft: the story/question scaffolds push past 280 X-weighted.
    const longDraft = `${'Writing threads that people actually finish takes deliberate structure, disciplined editing, and a reason to keep reading every single line you publish online today'}. ${'The draft body continues here so the reorder variant has two sentences to work with and stays deterministic'}.`;
    await typeDraft(page, longDraft);
    await expect(pillOf(page)).toBeVisible();
    await expand(page);

    await page.getByTestId('overlay-optimize').click();
    await expect(page.getByTestId('overlay-optimizer')).toHaveAttribute('data-optimizer-state', 'done');
    await expect.poll(() => page.getByTestId('overlay-optimizer').getAttribute('data-optimizer-state'), { timeout: 10_000 }).toBe('done');

    const items = page.getByTestId('overlay-optimizer-variant');
    await expect(items).toHaveCount(3);
    const overLimit = page.locator('[data-testid="overlay-optimizer-variant"][data-over-limit="true"]');
    await expect(overLimit).toHaveCount(2); // question + story scaffolds push ~270 chars past 280
    await expect(overLimit.first().getByTestId('overlay-optimizer-variant-chars')).toContainText(
      'Over the 280-character limit',
    );
  });

  test('failure is explicit and non-blocking: local score intact, composer usable (VAL-OPT-010)', async ({ context }) => {
    await interceptJev(context, ({ isOptimize }) =>
      isOptimize ? { action: 'status', status: 500, text: 'boom' } : { action: 'fulfill', body: VERIFIED_JEV_RESPONSE },
    );
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    const errors = collectErrors(page);
    await typeDraft(page, FIXED_DRAFT);
    await expect(pillOf(page)).toBeVisible();
    await expand(page);
    await expect(page.getByTestId('overlay-headline')).toBeVisible(); // local score first

    await page.getByTestId('overlay-optimize').click();
    await expect(page.getByTestId('overlay-optimizer')).toHaveAttribute('data-optimizer-state', 'error');
    await expect(page.getByTestId('overlay-optimizer-notice')).toContainText('Optimization failed');
    await expect(page.getByTestId('overlay-optimizer-notice')).toContainText('untouched');
    await expect(page.getByTestId('overlay-optimize')).toHaveAttribute('data-state', 'enabled'); // retry available

    // Non-blocking: local scoring stays fully rendered and the composer keeps working. Typing
    // collapses the panel; the re-expanded 'idle' section proves the NEW draft's capture + local
    // analysis still ran after the failure.
    await expect(page.getByTestId('overlay-headline')).toBeVisible();
    await expect(page.getByTestId('overlay-signals')).toBeVisible();
    await typeDraftAndAwaitCapture(page, 'Typing still works after the failure, which is what matters most here.');
    await expand(page);
    await waitForFreshOptimizer(page);
    await expect(page.getByTestId('overlay-headline')).toBeVisible();
    await expect(page.getByTestId('overlay-signals')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('the optimizer surface is English-only across idle, done, and error states (VAL-CROSS-016)', async ({ context }) => {
    // The FIRST optimize exchange succeeds; later optimize identities fail (explicit error state).
    // The counter counts OPTIMIZE exchanges only — the auto-analysis calls are index-independent.
    let optimizeIndex = 0;
    await interceptJev(context, ({ isOptimize }) => {
      if (!isOptimize) return { action: 'fulfill', body: VERIFIED_JEV_RESPONSE };
      const nth = optimizeIndex;
      optimizeIndex += 1;
      return nth === 0
        ? { action: 'fulfill', body: RANKED_FIXTURE }
        : { action: 'status', status: 500, text: 'boom' };
    });
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    // innerText is multiline (block elements join with \n), so the sweep allows newlines too.
    const english = /^[A-Za-z0-9 .,:;!?%'"()\-–—/+·…#\n]*$/;

    await typeDraft(page, FIXED_DRAFT);
    await expect(pillOf(page)).toBeVisible();
    await expand(page);
    const sectionText = await page.getByTestId('overlay-optimizer').innerText();
    expect(sectionText).toMatch(english);

    await page.getByTestId('overlay-optimize').click();
    await expect(page.getByTestId('overlay-optimizer')).toHaveAttribute('data-optimizer-state', 'done');
    const doneText = await page.getByTestId('overlay-optimizer').innerText();
    expect(doneText).toMatch(english);

    // A second optimize identity fails: the error state is English-only too. Typing collapses the
    // panel, so re-expand and wait for 'idle' — the same readiness rule as VAL-OPT-009.
    await typeDraftAndAwaitCapture(page, 'An English error-state draft that is long enough to analyze fully.');
    await expand(page);
    await waitForFreshOptimizer(page);
    await page.getByTestId('overlay-optimize').click();
    await expect(page.getByTestId('overlay-optimizer')).toHaveAttribute('data-optimizer-state', 'error');
    const errorText = await page.getByTestId('overlay-optimizer').innerText();
    expect(errorText).toMatch(english);
  });

  test('the too-tall expanded panel wheels and trackpads to its very end; the LAST variant Copy is reachable and copies exactly (VAL-DRAFT-039, VAL-OPT-004)', async ({ context }) => {
    const { calls } = await interceptJev(context, ({ isOptimize }) =>
      isOptimize ? { action: 'fulfill', body: RANKED_FIXTURE } : { action: 'fulfill', body: VERIFIED_JEV_RESPONSE },
    );
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: FIXTURE_URL });
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraftAndAwaitCapture(page, FIXED_DRAFT);
    await expand(page);

    // The Optimizer section is the panel's LAST block: its final variant's Copy button is the
    // deepest control the scroll must reach (this round's user complaint, verbatim).
    await page.getByTestId('overlay-optimize').click();
    await expect(page.getByTestId('overlay-optimizer')).toHaveAttribute('data-optimizer-state', 'done');
    await expect.poll(() => optimizeCalls(calls).length, { timeout: 10_000 }).toBe(1);
    const variants = page.getByTestId('overlay-optimizer-variant');
    await expect(variants).toHaveCount(3);

    // Short viewport: the panel must cap to the available space and scroll internally.
    await page.setViewportSize({ width: 900, height: 500 });
    const panelMetrics = async (): Promise<{ scrollTop: number; clientHeight: number; scrollHeight: number } | null> =>
      page.evaluate(() => {
        const panel = document
          .querySelector('#amplifyx-overlay-host')
          ?.shadowRoot?.querySelector('[data-testid="amplifyx-overlay"]');
        if (!panel) return null;
        return { scrollTop: panel.scrollTop, clientHeight: panel.clientHeight, scrollHeight: panel.scrollHeight };
      });
    await expect
      .poll(async () => {
        const m = await panelMetrics();
        return m !== null && m.scrollHeight > m.clientHeight;
      }, { timeout: 5_000 })
      .toBe(true); // the cap engaged: more content than the capped box shows

    // WHEEL pass: notches over the panel's center must be redirected INTO the panel until its
    // very end, while the page beneath stays put (the redirect only yields at the panel's edge).
    const panelBox = await panelOf(page).boundingBox();
    await page.mouse.move(panelBox!.x + panelBox!.width / 2, panelBox!.y + panelBox!.height / 2);
    for (let notch = 0; notch < 25; notch += 1) {
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(60);
      const state = await panelMetrics();
      if (state && state.scrollTop + state.clientHeight >= state.scrollHeight - 1) break;
    }
    const atEnd = await panelMetrics();
    expect(atEnd!.scrollTop + atEnd!.clientHeight).toBeGreaterThanOrEqual(atEnd!.scrollHeight - 1);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    // The LAST variant's Copy button is fully inside the viewport RIGHT NOW — reachable by the
    // scroll alone, not by Playwright's automatic scroll-into-view on click.
    const lastVariant = variants.last();
    await expect(lastVariant).toHaveAttribute('data-variant-kind', 'story');
    const copyBox = await lastVariant.getByTestId('overlay-optimizer-copy').boundingBox();
    expect(copyBox).not.toBeNull();
    expect(copyBox!.y).toBeGreaterThanOrEqual(0);
    expect(copyBox!.y + copyBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);

    // Clicking it copies EXACTLY that variant's text — and the composer is byte-identical
    // (VAL-OPT-004's exact transfer and VAL-OPT-005's untouched composer, at the panel's end).
    const composerBefore = await page.locator(HOME_COMPOSER).innerText();
    const lastText = await lastVariant.getByTestId('overlay-optimizer-variant-text').innerText();
    await lastVariant.getByTestId('overlay-optimizer-copy').click();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(lastText);
    expect(await page.locator(HOME_COMPOSER).innerText()).toBe(composerBefore);

    // TRACKPAD pass: back to the top, then a stream of small low-speed deltas must also carry
    // the panel to its very end (the same wheel pipeline a real trackpad feeds).
    for (let back = 0; back < 12; back += 1) {
      await page.mouse.wheel(0, -400);
    }
    await page.waitForTimeout(120);
    expect((await panelMetrics())!.scrollTop).toBeLessThan(atEnd!.scrollTop); // back at the top
    for (let swipe = 0; swipe < 120; swipe += 1) {
      await page.mouse.wheel(0, 40);
      await page.waitForTimeout(20);
      const m = await panelMetrics();
      if (m && m.scrollTop + m.clientHeight >= m.scrollHeight - 1) break;
    }
    const trackpadEnd = await panelMetrics();
    expect(trackpadEnd!.scrollTop + trackpadEnd!.clientHeight).toBeGreaterThanOrEqual(trackpadEnd!.scrollHeight - 1);
  });
});
