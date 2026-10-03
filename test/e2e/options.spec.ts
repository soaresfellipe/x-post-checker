import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page, Route } from '@playwright/test';
import { expect, launchExtensionContext, optionsUrl, test } from './extension';

const SYNTHETIC_KEY = 'test-key-synthetic-0123456789';
const JEV_URL = 'https://api.typesafe.ai/**';

type StorageArea = 'local' | 'sync';

// Only evaluated inside the extension page; this just types the page-side calls.
declare const chrome: {
  storage: Record<
    StorageArea,
    { get(keys: null): Promise<Record<string, unknown>>; set: (...args: unknown[]) => Promise<void> }
  >;
};

async function openOptions(context: BrowserContext): Promise<{ page: Page; logs: string[] }> {
  const page = await context.newPage();
  const logs: string[] = [];
  page.on('console', (message) => logs.push(message.text()));
  page.on('pageerror', (error) => logs.push(error.message));
  await page.goto(await optionsUrl(context));
  await expect(page.getByTestId('key-status')).not.toBeEmpty();
  return { page, logs };
}

function storageSnapshot(page: Page, area: StorageArea): Promise<Record<string, unknown>> {
  return page.evaluate((name) => chrome.storage[name].get(null), area);
}

async function visibleText(page: Page): Promise<string> {
  return page.locator('body').innerText();
}

function expectEnglishOnly(text: string): void {
  // Option copy is plain ASCII apart from the ellipsis used by progress messages.
  expect(text.replace(/…/g, '...')).toMatch(/^[\s!-~]*$/);
}

function jevOk(model = 'jev-1.13.0') {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ model, answers: { connection_check: { type: 'score', score: 2.1, confidence: 0.5 } } }),
  };
}

async function saveKey(page: Page, key: string): Promise<void> {
  await page.getByTestId('api-key-input').fill(key);
  await page.getByTestId('save-key').click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'success');
}

test.describe('options page: key management', () => {
  test('key field is masked, toggles visibility without changing the value, and the privacy disclosure is visible', async ({ context }) => {
    const { page } = await openOptions(context);
    const input = page.getByTestId('api-key-input');
    await expect(input).toHaveAttribute('type', 'password');
    await input.fill(SYNTHETIC_KEY);

    await page.getByTestId('toggle-key-visibility').click();
    await expect(input).toHaveAttribute('type', 'text');
    await expect(input).toHaveValue(SYNTHETIC_KEY);
    await page.getByTestId('toggle-key-visibility').click();
    await expect(input).toHaveAttribute('type', 'password');
    await expect(input).toHaveValue(SYNTHETIC_KEY);

    const disclosure = page.getByTestId('privacy-disclosure');
    await expect(disclosure).toBeVisible();
    await expect(disclosure).toContainText('Draft text is sent to api.typesafe.ai when AI analysis runs');
    await expect(disclosure).toContainText('Timeline scoring is local');
  });

  test('saves the key to storage.local only, with no sync writes and no key in console output', async ({ context }) => {
    const { page, logs } = await openOptions(context);
    await page.evaluate(() => {
      const calls: unknown[] = [];
      (window as unknown as { __syncCalls: unknown[] }).__syncCalls = calls;
      const sync = chrome.storage.sync as unknown as Record<string, (...args: unknown[]) => unknown>;
      for (const method of ['set', 'setAccessLevel', 'remove'] as const) {
        const original = sync[method]!.bind(sync);
        sync[method] = (...args) => {
          calls.push(args);
          return original(...args);
        };
      }
    });

    await saveKey(page, SYNTHETIC_KEY);

    expect((await storageSnapshot(page, 'local')).jevApiKey).toBe(SYNTHETIC_KEY);
    expect(await storageSnapshot(page, 'sync')).toEqual({});
    expect(await page.evaluate(() => (window as unknown as { __syncCalls: unknown[] }).__syncCalls)).toEqual([]);
    expect(await visibleText(page)).not.toContain(SYNTHETIC_KEY);
    expect(await page.getByTestId('api-key-input').inputValue()).toBe('');
    expect(logs.join('\n')).not.toContain(SYNTHETIC_KEY);
  });

  test('reports an error, not success, when the storage write is rejected', async ({ context }) => {
    const { page } = await openOptions(context);
    await page.evaluate(() => {
      chrome.storage.local.set = () => Promise.reject(new Error('QUOTA_BYTES quota exceeded'));
    });
    await page.getByTestId('api-key-input').fill(SYNTHETIC_KEY);
    await page.getByTestId('save-key').click();

    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'error');
    await expect(page.getByTestId('save-status')).toContainText('Could not save');
    await expect(page.getByTestId('save-status')).not.toContainText('API key saved');
    expect((await storageSnapshot(page, 'local')).jevApiKey).toBeUndefined();
    await expect(page.getByTestId('api-key-input')).toHaveValue(SYNTHETIC_KEY);
  });
});

test.describe('options page: test connection (intercepted Jev)', () => {
  test('success shows the returned model and a measured latency, and sends the saved key as Bearer', async ({ context }) => {
    const { page, logs } = await openOptions(context);
    await saveKey(page, SYNTHETIC_KEY);
    let authMatches = false;
    let questionTypes: string[] = [];
    await context.route(JEV_URL, async (route: Route) => {
      const request = route.request();
      authMatches = request.headers().authorization === `Bearer ${SYNTHETIC_KEY}`;
      const body = request.postDataJSON() as { questions: Record<string, { type: string }> };
      questionTypes = Object.values(body.questions).map((q) => q.type);
      await route.fulfill(jevOk('jev-test-9.9'));
    });

    await page.getByTestId('test-connection').click();
    const result = page.getByTestId('test-result');
    await expect(result).toHaveAttribute('data-state', 'success');
    await expect(result).toContainText('jev-test-9.9');
    const latency = Number(/Latency: (\d+) ms/.exec((await result.textContent()) ?? '')?.[1]);
    expect(Number.isFinite(latency) && latency >= 0).toBe(true);
    expect(authMatches).toBe(true);
    expect(questionTypes).toEqual(['score']);
    expect(logs.join('\n')).not.toContain(SYNTHETIC_KEY);
    expectEnglishOnly(await visibleText(page));
  });

  test('an unauthorized response shows an invalid-key failure and keeps the saved key', async ({ context }) => {
    const { page } = await openOptions(context);
    await saveKey(page, SYNTHETIC_KEY);
    await context.route(JEV_URL, (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' }));

    await page.getByTestId('test-connection').click();
    const result = page.getByTestId('test-result');
    await expect(result).toHaveAttribute('data-state', 'invalid-key');
    await expect(result).toContainText('Invalid API key');
    await expect(result).not.toContainText(/Network error|Connected|Latency/);
    expect((await storageSnapshot(page, 'local')).jevApiKey).toBe(SYNTHETIC_KEY);
    await expect(page.getByTestId('test-connection')).toBeEnabled();
    expectEnglishOnly(await visibleText(page));
  });

  test('an unreachable network shows a distinct network failure and keeps the saved key', async ({ context }) => {
    const { page } = await openOptions(context);
    await saveKey(page, SYNTHETIC_KEY);
    await context.route(JEV_URL, (route) => route.abort('connectionrefused'));

    await page.getByTestId('test-connection').click();
    const result = page.getByTestId('test-result');
    await expect(result).toHaveAttribute('data-state', 'network');
    await expect(result).toContainText('Network error');
    await expect(result).not.toContainText(/Invalid API key|Connected|Latency/);
    expect((await storageSnapshot(page, 'local')).jevApiKey).toBe(SYNTHETIC_KEY);
    expectEnglishOnly(await visibleText(page));
  });

  test('a failure after a success replaces the earlier success result', async ({ context }) => {
    const { page } = await openOptions(context);
    await saveKey(page, SYNTHETIC_KEY);
    await context.route(JEV_URL, (route) => route.fulfill(jevOk()));
    await page.getByTestId('test-connection').click();
    await expect(page.getByTestId('test-result')).toHaveAttribute('data-state', 'success');

    await context.unroute(JEV_URL);
    await context.route(JEV_URL, (route) => route.fulfill({ status: 401, body: '{}' }));
    await page.getByTestId('test-connection').click();
    await expect(page.getByTestId('test-result')).toHaveAttribute('data-state', 'invalid-key');
    await expect(page.getByTestId('test-result')).not.toContainText('Latency');
  });

  test('testing without any key explains what to do', async ({ context }) => {
    const { page } = await openOptions(context);
    await page.getByTestId('test-connection').click();
    await expect(page.getByTestId('test-result')).toHaveAttribute('data-state', 'no-key');
    await expect(page.getByTestId('test-result')).toContainText('No API key to test');
  });
});

test.describe('options page: persistence across browser restart', () => {
  test('key presence and every named preference survive closing and reopening the same profile', async () => {
    const profileDir = await mkdtemp(path.join(tmpdir(), 'amplifyx-restart-'));
    try {
      let context = await launchExtensionContext(profileDir);
      let { page } = await openOptions(context);
      await saveKey(page, SYNTHETIC_KEY);
      await page.getByTestId('pref-enabled').uncheck();
      await page.getByTestId('pref-autoAnalyze').uncheck();
      await page.getByTestId('pref-jevForDrafts').uncheck();
      await page.getByTestId('pref-jevForTargets').check();
      await page.getByTestId('pref-minDraftLength').fill('25');
      await page.getByTestId('pref-minDraftLength').blur();
      await expect(page.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');
      await page.getByTestId('pref-targetThreshold').fill('55');
      await page.getByTestId('pref-targetThreshold').blur();
      await expect.poll(async () => (await storageSnapshot(page, 'local')).targetThreshold).toBe(55);
      await context.close();

      context = await launchExtensionContext(profileDir);
      ({ page } = await openOptions(context));
      await expect(page.getByTestId('key-status')).toContainText('API key saved');
      await expect(page.getByTestId('api-key-input')).toHaveAttribute('type', 'password');
      await expect(page.getByTestId('api-key-input')).toHaveValue('');
      expect(await page.content()).not.toContain(SYNTHETIC_KEY);
      await expect(page.getByTestId('pref-enabled')).not.toBeChecked();
      await expect(page.getByTestId('pref-autoAnalyze')).not.toBeChecked();
      await expect(page.getByTestId('pref-jevForDrafts')).not.toBeChecked();
      await expect(page.getByTestId('pref-jevForTargets')).toBeChecked();
      await expect(page.getByTestId('pref-minDraftLength')).toHaveValue('25');
      await expect(page.getByTestId('pref-targetThreshold')).toHaveValue('55');
      expect((await storageSnapshot(page, 'local')).jevApiKey).toBe(SYNTHETIC_KEY);
      await context.close();
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
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

test.describe('options page: live Jev smoke', () => {
  test('Test connection against the real API reports a model id and latency', async ({ context }) => {
    const liveKey = await readLiveKey();
    if (!liveKey) {
      console.warn('WARNING: JEV_API_KEY is not set; skipping the live Jev connection test.');
      test.skip(true, 'JEV_API_KEY is not set');
      return;
    }
    const { page, logs } = await openOptions(context);
    await saveKey(page, liveKey);
    await page.getByTestId('test-connection').click();
    const result = page.getByTestId('test-result');
    await expect(result).toHaveAttribute('data-state', 'success', { timeout: 30_000 });
    await expect(result).toContainText(/Model: jev-/);
    expect(await visibleText(page)).not.toContain(liveKey);
    expect(logs.join('\n')).not.toContain(liveKey);
  });
});
