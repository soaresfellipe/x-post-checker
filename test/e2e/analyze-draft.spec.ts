import type { BrowserContext, Page, Route } from '@playwright/test';
import { expect, FIXTURE_URL, optionsUrl, test } from './extension';
import { VERIFIED_JEV_RESPONSE } from '../helpers/jev-fixtures';

/**
 * Full-stack draft analysis through the REAL background: watcher/extension-page ->
 * message protocol -> AnalyzerService -> JevClient -> (intercepted) api.typesafe.ai. These specs
 * pin VAL-DRAFT-015 (cache) and VAL-DRAFT-016 (verified request shape + key secrecy) before the
 * score overlay exists; the overlay feature renders the same replies later.
 *
 * The Jev key in these tests is SYNTHETIC (it never authenticates anything): requests are
 * intercepted and answered with the verified response, and asserting header equality in-memory is
 * the approved evidence pattern (only redacted traces would ever leave this file).
 */

const SYNTHETIC_KEY = 'key-analyze-e2e-0001';
const HOME_COMPOSER = '[data-testid="tweetTextarea_0"]';
const DRAFT_TEXT =
  'I spent 30 days replacing my complicated productivity system with one daily checklist. I finish more work now, because deciding what not to do matters more than adding another app.';

/** A complete, watcher-shaped DraftSnapshot. */
function e2eDraft(overrides: Record<string, unknown> = {}) {
  return {
    text: DRAFT_TEXT,
    hashtags: [],
    urls: [],
    hasMedia: false,
    isReply: false,
    charCount: DRAFT_TEXT.length,
    capturedAt: 1_700_000_000_000,
    ...overrides,
  };
}

interface CapturedJevCall {
  url: string;
  method: string;
  authorization: string;
  body: string;
}

/**
 * Intercepts every api.typesafe.ai request from ANY context (including the background worker —
 * verified in readiness: context.route reaches the SW fetch in Chromium) and records the calls.
 */
async function interceptJev(context: BrowserContext): Promise<{ calls: CapturedJevCall[] }> {
  const calls: CapturedJevCall[] = [];
  const handler = async (route: Route) => {
    const request = route.request();
    calls.push({
      url: request.url(),
      method: request.method(),
      authorization: (await request.headerValue('authorization')) ?? request.headers()['authorization'] ?? '',
      body: request.postData() ?? '',
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(VERIFIED_JEV_RESPONSE),
    });
  };
  await context.route('https://api.typesafe.ai/**', handler);
  return { calls };
}

/** Opens Options and saves the synthetic key through the real UI + background write path. */
async function saveKeyViaOptions(context: BrowserContext): Promise<Page> {
  const options = await context.newPage();
  await options.goto(await optionsUrl(context));
  await expect(options.getByTestId('key-status')).not.toBeEmpty();
  await options.getByTestId('api-key-input').fill(SYNTHETIC_KEY);
  await options.getByTestId('save-key').click();
  await expect(options.getByTestId('key-status')).toHaveAttribute('data-state', 'present');
  return options;
}

// The options page is an extension context: it can message the background directly, which is how
// the first two specs exercise the pipeline without depending on the (pending) score overlay.
declare const chrome: {
  runtime: { sendMessage(message: unknown): Promise<unknown> };
  storage: { local: { get(keys: string[]): Promise<Record<string, unknown>> } };
};

/** One `analyze-draft` protocol exchange's reply, as the extension page receives it. */
interface AnalyzeReply {
  ok: boolean;
  data?: {
    kind: string;
    local: { headline: number; signals: unknown[] };
    jev?: { ordinal: number; confidence: number; band: string; weaknesses: string[] };
    meta: Record<string, unknown> & { jevStatus: string; headline: number };
  };
}

/** Sends a real `analyze-draft` protocol message from an extension page and returns the reply. */
async function analyzeViaBackground(
  page: Page,
  draft: Record<string, unknown>,
  trigger: 'auto' | 'manual',
): Promise<AnalyzeReply> {
  const reply = await page.evaluate(
    async (payload: { draft: Record<string, unknown>; trigger: 'auto' | 'manual' }) =>
      chrome.runtime.sendMessage({ v: 1, type: 'analyze-draft', payload }),
    { draft, trigger },
  );
  return reply as AnalyzeReply;
}

test.describe('analyze-draft pipeline (real background)', () => {
  test('sends the verified Jev request shape, parses a typed verdict, and never exposes the key (VAL-DRAFT-016)', async ({ context }) => {
    const { calls } = await interceptJev(context);
    const options = await saveKeyViaOptions(context);
    const consoleText: string[] = [];
    options.on('console', (message) => consoleText.push(message.text()));

    const reply = await analyzeViaBackground(options, e2eDraft(), 'manual');

    // Typed verdict (VAL-DRAFT-016: "the response is parsed into the expected verdict"):
    expect(reply.ok).toBe(true);
    const data = reply.data!;
    expect(data.kind).toBe('analyzed');
    expect(data.local.headline).toBeGreaterThanOrEqual(0);
    expect(data.local.headline).toBeLessThanOrEqual(100);
    expect(data.local.signals.length).toBeGreaterThan(0);
    expect(data.jev).toMatchObject({ ordinal: 3.44, confidence: 0.65, band: 'moderate' });
    expect(data.jev!.weaknesses).toHaveLength(1);
    expect(data.meta.jevStatus).toBe('ok');
    expect(data.meta.trigger).toBe('manual');
    expect(data.meta.mainWeakness).toBe('not_specific_enough');
    expect(data.meta.headline).toBe(Math.round(0.6 * data.local.headline + 0.4 * ((3.44 / 5) * 100)));

    // The verified request shape, exactly one POST to the systemone endpoint:
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(call.method).toBe('POST');
    expect(call.authorization).toBe(`Bearer ${SYNTHETIC_KEY}`);
    const body = JSON.parse(call.body) as {
      model: string;
      state: string;
      questions: {
        viral_potential: { type: string; criteria: string[]; instructions: string };
        main_weakness: { type: string; criteria: Record<string, string> };
      };
    };
    expect(body.model).toBe('jev-latest');
    expect(body.state.startsWith(DRAFT_TEXT)).toBe(true);
    expect(body.state).toContain('- This is an original post.');
    expect(body.questions.viral_potential.type).toBe('score');
    expect(body.questions.viral_potential.criteria).toHaveLength(6);
    expect(body.questions.viral_potential.instructions).toContain('heuristic judgment');
    expect(body.questions.main_weakness.type).toBe('choice');
    expect(Object.keys(body.questions.main_weakness.criteria).sort()).toEqual([
      'no_major_weakness',
      'not_specific_enough',
      'unclear_audience_value',
      'weak_hook',
      'weak_share_trigger',
    ]);

    // Key secrecy: the reply travels to an extension page; neither it nor the console may
    // contain the key value.
    expect(JSON.stringify(reply)).not.toContain(SYNTHETIC_KEY);
    expect(JSON.stringify(data.meta)).not.toContain(SYNTHETIC_KEY);
    expect(consoleText.join('\n')).not.toContain(SYNTHETIC_KEY);
  });

  test('re-analyzing the identical draft serves the cached verdict with no duplicate network call (VAL-DRAFT-015)', async ({ context }) => {
    const { calls } = await interceptJev(context);
    const options = await saveKeyViaOptions(context);

    const first = await analyzeViaBackground(options, e2eDraft(), 'auto');
    // Identical content captured later (fresh capturedAt, exactly like retyping).
    const second = await analyzeViaBackground(options, e2eDraft({ capturedAt: 1_700_000_009_000 }), 'auto');

    expect(first.data!.meta.jevStatus).toBe('ok');
    expect(second.data!.kind).toBe('analyzed');
    expect(second.data!.meta.jevStatus).toBe('cached');
    expect(second.data!.jev).toEqual(first.data!.jev);
    expect(calls).toHaveLength(1); // the one and only POST to api.typesafe.ai
  });

  test('typing the identical draft twice on the fixture costs one Jev request and records both analyses', async ({ context }) => {
    const { calls } = await interceptJev(context);
    const options = await saveKeyViaOptions(context);

    const readLastAnalysis = () =>
      options.evaluate(() => chrome.storage.local.get(['lastAnalysis'])) as Promise<Record<string, unknown>>;

    const page = await context.newPage();
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#amplifyx-marker-host')).toHaveAttribute('data-watcher-state', 'watching');

    // Type a draft: the watcher dispatches after the debounce, the background analyzes via Jev.
    await page.locator(HOME_COMPOSER).click();
    await page.keyboard.type(DRAFT_TEXT);
    await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);

    const firstRecord = (await readLastAnalysis())['lastAnalysis'] as { at: number; outcome: string };
    expect(firstRecord.outcome).toBe('ok');

    // Delete the draft, then retype the identical text: cache serves the verdict, no new request.
    await page.locator(HOME_COMPOSER).click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(1_000); // the cleared (too short) draft settles without dispatching
    await page.keyboard.type(DRAFT_TEXT);
    await page.waitForTimeout(1_500); // past the debounce: a duplicate request would have fired

    expect(calls).toHaveLength(1);
    const secondRecord = (await readLastAnalysis())['lastAnalysis'] as { at: number; outcome: string };
    expect(secondRecord.outcome).toBe('ok');
    expect(secondRecord.at).toBeGreaterThanOrEqual(firstRecord.at);
  });
});
