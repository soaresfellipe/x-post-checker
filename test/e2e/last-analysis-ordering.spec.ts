import type { BrowserContext, Route } from '@playwright/test';
import { expect, optionsUrl, popupUrl, test } from './extension';
import { VERIFIED_JEV_RESPONSE } from '../helpers/jev-fixtures';

/**
 * Popup last-analysis ordering (VAL-SETUP-015 integration): the line must reflect the NEWEST
 * analysis outcome. The regression being pinned: an older completion's record landing late (the
 * deliberately delayed older write) must never repaint the newer outcome the popup already
 * shows, while a genuinely newer completion still applies.
 *
 * The newest record is produced by a REAL background analysis (watcher pipeline: analyze-draft
 * message -> AnalyzerService -> intercepted Jev), so the popup line reflects genuine recorded
 * state; the delayed older write is delivered the way an out-of-order completion surfaces: an
 * older-`at` record landing in storage while the popup holds the newer one.
 */

const SYNTHETIC_KEY = 'key-last-analysis-ordering-0001';
const FIVE_MINUTES = 5 * 60_000;

declare const chrome: {
  runtime: { sendMessage(message: unknown): Promise<unknown> };
  storage: {
    local: {
      get(keys: string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
};

function e2eDraft(text: string) {
  return {
    text,
    hashtags: [],
    urls: [],
    hasMedia: false,
    isReply: false,
    charCount: text.length,
    capturedAt: 1_700_000_000_000,
  };
}

const FIRST_DRAFT = e2eDraft(
  'I spent 30 days replacing my complicated productivity system with one daily checklist. I finish more work now.',
);
const SECOND_DRAFT = e2eDraft(
  'Three uncomfortable questions about your spending habits that most people avoid asking until it is too late.',
);

interface AnalyzeReply {
  ok: boolean;
  data?: { kind: string; meta: { jevStatus: string } };
}

/** First api.typesafe.ai call answers with the verified 200; later calls fail with a 500 (final, non-retryable). */
async function interceptJev(context: BrowserContext): Promise<void> {
  let calls = 0;
  await context.route('https://api.typesafe.ai/**', async (route: Route) => {
    calls += 1;
    if (calls === 1) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VERIFIED_JEV_RESPONSE) });
    } else {
      await route.fulfill({ status: 500, contentType: 'text/plain', body: 'internal error' });
    }
  });
}

async function saveKeyViaOptions(context: BrowserContext): Promise<void> {
  const options = await context.newPage();
  await options.goto(await optionsUrl(context));
  await expect(options.getByTestId('key-status')).not.toBeEmpty();
  await options.getByTestId('api-key-input').fill(SYNTHETIC_KEY);
  await options.getByTestId('save-key').click();
  await expect(options.getByTestId('key-status')).toHaveAttribute('data-state', 'present');
}

test.describe('popup last-analysis ordering (newest outcome wins)', () => {
  test('a deliberately delayed older write never regresses the popup line; a newer completion still applies', async ({ context }) => {
    await interceptJev(context);
    await saveKeyViaOptions(context);

    const popup = await context.newPage();
    await popup.goto(await popupUrl(context));
    await expect(popup.getByTestId('last-analysis')).toHaveAttribute('data-state', 'empty');

    // The newest outcome: a REAL analysis completes through the background and is recorded.
    const first = (await popup.evaluate(
      (draft) => chrome.runtime.sendMessage({ v: 1, type: 'analyze-draft', payload: { draft, trigger: 'manual' } }),
      FIRST_DRAFT,
    )) as AnalyzeReply;
    expect(first.ok).toBe(true);
    expect(first.data!.meta.jevStatus).toBe('ok');
    await expect(popup.getByTestId('last-analysis')).toHaveAttribute('data-state', 'ok');
    const newestAt = Number(await popup.getByTestId('last-analysis').getAttribute('data-at'));
    expect(newestAt).toBeGreaterThan(0);

    // The deliberately delayed OLDER write: an out-of-order completion's record lands late.
    await popup.evaluate(
      (olderAt) => chrome.storage.local.set({ lastAnalysis: { at: olderAt, outcome: 'error' } }),
      newestAt - FIVE_MINUTES,
    );

    // The popup keeps reflecting the newest outcome — the older record repaints nothing.
    await expect(popup.getByTestId('last-analysis')).toHaveAttribute('data-state', 'ok');
    await expect(popup.getByTestId('last-analysis')).toHaveAttribute('data-at', String(newestAt));

    // The gate is not a freeze: a genuinely NEWER completion (this one's Jev half fails with the
    // 500) records an error and the popup applies it, agreeing with storage's newest record.
    const second = (await popup.evaluate(
      (draft) => chrome.runtime.sendMessage({ v: 1, type: 'analyze-draft', payload: { draft, trigger: 'manual' } }),
      SECOND_DRAFT,
    )) as AnalyzeReply;
    expect(second.ok).toBe(true); // the analysis completed; its JEV half failed
    expect(second.data!.meta.jevStatus).toBe('failed-http');

    const stored = (await popup.evaluate(() => chrome.storage.local.get(['lastAnalysis']))) as {
      lastAnalysis?: { at: number; outcome: string };
    };
    expect(stored.lastAnalysis!.outcome).toBe('error');
    expect(stored.lastAnalysis!.at).toBeGreaterThan(newestAt);
    await expect(popup.getByTestId('last-analysis')).toHaveAttribute('data-state', 'error');
    await expect(popup.getByTestId('last-analysis')).toHaveAttribute('data-at', String(stored.lastAnalysis!.at));
  });
});
