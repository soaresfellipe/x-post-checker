import type { BrowserContext, Locator, Page, Route } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, FIXTURE_URL, launchExtensionContext, optionsUrl, test } from './extension';
import { FIXTURE_POSTS } from '../fixtures/x-fixture';
import { VERIFIED_JEV_RESPONSE } from '../helpers/jev-fixtures';

/**
 * Cross-surface theming + accessibility sweep (m6-theme-a11y-sweep) — the E2E pins for
 * VAL-THEME-001..004 and VAL-CROSS-016 that the earlier M6 features left unasserted per surface:
 *
 * - VAL-THEME-001: the light/dim/lights-out mapping (and the unknown-color light fallback)
 *   resolves the Design 1b tokens on EVERY surface — status row, expanded block, badge chip,
 *   popover — not just on the hosts.
 * - VAL-THEME-002: a live body-background switch re-themes all surfaces in place: same host
 *   elements, expansion/popover state and draft retained.
 * - VAL-THEME-003: computed WCAG contrast >= 4.5:1 for the text pairs on the RENDERED surfaces in
 *   all three themes (via the a11y text tokens), and yellow (--ok) never renders as text.
 * - VAL-THEME-004: prefers-reduced-motion: reduce stops the pending pulse (static opacity .6)
 *   in the status row and the popover loading state; without the preference the pulse runs.
 * - VAL-DRAFT-046 support: extension buttons >= 28px and tabular-nums on the numbers.
 * - VAL-CROSS-016: the content surfaces are English-only across all exercised states.
 *
 * The Jev key in this spec is SYNTHETIC and every api.typesafe.ai request is intercepted.
 */

const SYNTHETIC_KEY = 'key-theme-a11y-e2e-0001';
const HOME_COMPOSER = '[data-testid="tweetTextarea_0"]';
const OVERLAY_HOST = '#amplifyx-overlay-host';
const BADGE_HOST = '[data-amplifyx-host="badge"]';
const POPOVER_HOST = '#amplifyx-target-popover-host';
const BADGE = '[data-testid="amplifyx-target-badge"]';
const POPOVER = '[data-testid="amplifyx-target-popover"]';
const POST_1 = FIXTURE_POSTS[0]!.id; // ana_builds: badges at fixture load

/** A draft with a POSITIVE signal (question) and NEGATIVE ones (4 hashtags, an external link). */
const DRAFT =
  'Why does every productivity system fail by week three? I replaced mine with one checklist and the results were instant https://example.com/case-study #qa #a11y #ux #dev';

type ThemeName = 'light' | 'dim' | 'lights-out' | 'unknown';

function setTheme(page: Page, theme: ThemeName): Promise<void> {
  return page.evaluate(
    (t: string) => (window as unknown as { __fixtureSetTheme: (t: string) => void }).__fixtureSetTheme(t),
    theme,
  );
}

async function openFixture(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#amplifyx-marker-host')).toHaveAttribute('data-watcher-state', 'watching');
  await expect(page.locator('#amplifyx-marker-host')).toHaveAttribute('data-scanner-state', 'scanning');
  return page;
}

async function saveKeyViaOptions(context: BrowserContext, key: string = SYNTHETIC_KEY): Promise<void> {
  const options = await context.newPage();
  await options.goto(await optionsUrl(context));
  await expect(options.getByTestId('key-status')).not.toBeEmpty();
  await options.getByTestId('api-key-input').fill(key);
  await options.getByTestId('save-key').click();
  await expect(options.getByTestId('key-status')).toHaveAttribute('data-state', 'present');
  await options.close();
}

async function typeDraft(page: Page, text: string): Promise<void> {
  const marker = page.locator('#amplifyx-marker-host');
  const before = Number((await marker.getAttribute('data-watcher-dispatches')) ?? '0');
  await page.locator(HOME_COMPOSER).click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text);
  await expect(marker).toHaveAttribute('data-watcher-dispatches', String(before + 1), { timeout: 15_000 });
}

/** Expands the inline analysis through the row (the only way; VAL-DRAFT-034). */
async function expand(page: Page): Promise<void> {
  await page.getByTestId('amplifyx-overlay-row').click();
  await expect(page.getByTestId('amplifyx-overlay')).toBeVisible();
  await expect(page.getByTestId('amplifyx-overlay')).toHaveAttribute('data-state', 'analyzed', { timeout: 10_000 });
}

/** Types the sweep draft, expands the analysis, opens a badge popover — all surfaces up. */
async function setupAllSurfaces(context: BrowserContext): Promise<Page> {
  const page = await openFixture(context);
  await typeDraft(page, DRAFT);
  // Badge popover first: the popover only closes via its control/Escape (no outside-click lane),
  // so the row click below expands the analysis while the popover stays open — every surface up.
  await expect(page.locator(`${BADGE}[data-amplifyx-post-id="${POST_1}"]`)).toBeVisible();
  await page.locator(`${BADGE}[data-amplifyx-post-id="${POST_1}"]`).click();
  await expect(page.locator(POPOVER)).toBeVisible();
  await expand(page);
  return page;
}

interface SurfaceSpec {
  /** A name for the assertion message. */
  name: string;
  hostSelector: string;
  /** Optional selector INSIDE the host's shadow root (default: the host itself). */
  innerSelector?: string;
}

const SURFACES: SurfaceSpec[] = [
  { name: 'status row', hostSelector: OVERLAY_HOST, innerSelector: '[data-testid="amplifyx-overlay-row"]' },
  { name: 'expanded block', hostSelector: OVERLAY_HOST, innerSelector: '[data-testid="amplifyx-overlay"]' },
  { name: 'badge chip', hostSelector: BADGE_HOST, innerSelector: '[data-testid="amplifyx-target-badge"]' },
  { name: 'popover', hostSelector: POPOVER_HOST, innerSelector: '[data-testid="amplifyx-target-popover"]' },
];

/** The resolved token triple on a surface element (tokens are :host custom properties). */
function surfaceTokens(page: Page, spec: SurfaceSpec): Promise<{ bg: string; fg: string; fg2: string }> {
  return page.evaluate(
    ({ hostSelector, innerSelector }) => {
      const host = document.querySelector(hostSelector);
      const el = (innerSelector ? host?.shadowRoot?.querySelector(innerSelector) : host) ?? null;
      if (!el) return { bg: '', fg: '', fg2: '' };
      const style = getComputedStyle(el);
      return {
        bg: style.getPropertyValue('--bg').trim(),
        fg: style.getPropertyValue('--fg').trim(),
        fg2: style.getPropertyValue('--fg2').trim(),
      };
    },
    { hostSelector: spec.hostSelector, innerSelector: spec.innerSelector ?? null },
  );
}

const EXPECTED_TOKENS = {
  light: { bg: '#ffffff', fg: '#0f1419', fg2: '#536471' },
  dim: { bg: '#15202b', fg: '#f7f9f9', fg2: '#8b98a5' },
  'lights-out': { bg: '#000000', fg: '#e7e9ea', fg2: '#71767b' },
} as const;

test.describe('cross-surface theming + a11y sweep (m6-theme-a11y-sweep)', () => {
  test('the theme mapping resolves on every surface, with the light fallback for unknown colors (VAL-THEME-001)', async ({ context }) => {
    const page = await setupAllSurfaces(context);

    // light is the default fixture state; then both dark themes; then the unknown fallback.
    for (const theme of ['light', 'dim', 'lights-out'] as const) {
      await setTheme(page, theme);
      const expected = EXPECTED_TOKENS[theme];
      for (const surface of SURFACES) {
        await expect(page.locator(surface.hostSelector).first()).toHaveAttribute('data-theme', theme);
        const tokens = await surfaceTokens(page, surface);
        expect(tokens, `${surface.name} in ${theme}`).toEqual(expected);
      }
    }

    // Unknown body background -> light palette on every surface.
    await setTheme(page, 'unknown');
    for (const surface of SURFACES) {
      await expect(page.locator(surface.hostSelector).first()).toHaveAttribute('data-theme', 'light');
      expect(await surfaceTokens(page, surface), `${surface.name} fallback`).toEqual(EXPECTED_TOKENS.light);
    }
  });

  test('a live theme switch re-themes every surface in place, keeping hosts, expansion and popover (VAL-THEME-002)', async ({ context }) => {
    const page = await setupAllSurfaces(context);
    const headlineBefore = await page.getByTestId('overlay-headline').textContent();

    // Mark the CURRENT host nodes: if any surface remounts, the probe attribute disappears.
    await page.evaluate(
      ({ overlayHost, popoverHost, badgeHost }) => {
        for (const selector of [overlayHost, popoverHost]) {
          const host = document.querySelector(selector) as HTMLElement | null;
          if (host) host.dataset.remountProbe = 'same-node';
        }
        const badge = document.querySelector(badgeHost) as HTMLElement | null;
        if (badge) badge.dataset.remountProbe = 'same-node';
      },
      { overlayHost: OVERLAY_HOST, popoverHost: POPOVER_HOST, badgeHost: BADGE_HOST },
    );

    await setTheme(page, 'dim');
    for (const surface of SURFACES) {
      await expect(page.locator(surface.hostSelector).first()).toHaveAttribute('data-theme', 'dim');
      expect(await surfaceTokens(page, surface)).toEqual(EXPECTED_TOKENS.dim);
    }
    // No remount: the probed elements are the SAME nodes, and all state survived the switch.
    const probes = await page.evaluate(
      ({ overlayHost, popoverHost, badgeHost }) => ({
        overlay: document.querySelector(overlayHost)?.getAttribute('data-remount-probe') ?? null,
        badge: document.querySelector(badgeHost)?.getAttribute('data-remount-probe') ?? null,
        popover: document.querySelector(popoverHost)?.getAttribute('data-remount-probe') ?? null,
      }),
      { overlayHost: OVERLAY_HOST, popoverHost: POPOVER_HOST, badgeHost: BADGE_HOST },
    );
    expect(probes).toEqual({ overlay: 'same-node', badge: 'same-node', popover: 'same-node' });
    await expect(page.getByTestId('amplifyx-overlay')).toBeVisible(); // still expanded
    await expect(page.locator(POPOVER)).toBeVisible(); // popover still open
    await expect(page.getByTestId('overlay-headline')).toHaveText(headlineBefore ?? ''); // draft retained

    // And back live in the same direction X users actually switch.
    await setTheme(page, 'lights-out');
    for (const surface of SURFACES) {
      await expect(page.locator(surface.hostSelector).first()).toHaveAttribute('data-theme', 'lights-out');
      expect(await surfaceTokens(page, surface)).toEqual(EXPECTED_TOKENS['lights-out']);
    }
    await expect(page.getByTestId('amplifyx-overlay')).toBeVisible();
  });

  test('rendered text contrast is >= 4.5:1 on every surface in all themes; yellow is never text (VAL-THEME-003)', async ({ context }) => {
    const page = await setupAllSurfaces(context);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));

    // In-page WCAG audit: resolves the element's computed color against its EFFECTIVE background
    // (translucent tints blended over whatever is actually behind them), theme by theme.
    const audit = async (theme: 'light' | 'dim' | 'lights-out'): Promise<void> => {
      await setTheme(page, theme);
      const results = await page.evaluate(
        ({ OVERLAY_HOST, POPOVER_HOST, BADGE_HOST }) => {
        const parseC = (s: string): [number, number, number, number] | null => {
          const m = s.match(/rgba?\(([^)]+)\)/);
          if (!m) return null;
          const p = m[1]!.split(',').map(Number);
          return [p[0]!, p[1]!, p[2]!, p.length > 3 ? p[3]! : 1];
        };
        const lin = (c: number): number => {
          c /= 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        const lum = (rgb: number[]): number =>
          0.2126 * lin(rgb[0]!) + 0.7152 * lin(rgb[1]!) + 0.0722 * lin(rgb[2]!);
        const contrast = (a: number[], b: number[]): number => {
          const x = lum(a);
          const y = lum(b);
          return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
        };
        const chain = (el: Element): Element[] => {
          const out: Element[] = [];
          let n: Element | null = el;
          while (n) {
            out.push(n);
            const root = n.getRootNode();
            n = root instanceof ShadowRoot ? root.host : n.parentElement;
          }
          return out.reverse();
        };
        const effectiveBg = (el: Element): number[] => {
          let base: number[] | null = null;
          const parts: Array<[number, number, number, number]> = [];
          for (const node of chain(el)) {
            const c = parseC(getComputedStyle(node).backgroundColor);
            if (!c) continue;
            if (base === null) {
              if (c[3] >= 1) base = [c[0], c[1], c[2]];
              continue;
            }
            parts.push(c);
          }
          const acc = base === null ? ([255, 255, 255] as [number, number, number]) : ([base[0], base[1], base[2]] as [number, number, number]);
          for (const [r, g, b, a] of parts) {
            acc[0] = acc[0] * (1 - a) + r * a;
            acc[1] = acc[1] * (1 - a) + g * a;
            acc[2] = acc[2] * (1 - a) + b * a;
          }
          return acc;
        };
        /** contrast of the FIRST matching element's text on its effective background */
        const pairRatio = (hostSelector: string, innerSelector: string): number | null => {
          const el = document.querySelector(hostSelector)?.shadowRoot?.querySelector(innerSelector);
          if (!el) return null;
          const color = parseC(getComputedStyle(el).color);
          if (!color) return null;
          return contrast([color[0]!, color[1]!, color[2]!], effectiveBg(el));
        };

        // Secondary text on the surface background...
        const results: Record<string, number | null> = {
          'row summary (fg2)': pairRatio(OVERLAY_HOST, '[data-testid="overlay-summary"]'),
          'popover caption (fg2)': pairRatio(POPOVER_HOST, '[data-testid="amplifyx-popover-caption"]'),
        };
        // ...the good/weak text pairs on their tints (signal chips in the expanded block and the
        // badge chip), the neutral-toggle pair on the hover surface, and the rows-list points.
        for (const [label, host, inner] of [
          ['positive chip', OVERLAY_HOST, '[data-testid="overlay-chip"][data-direction="positive"]'],
          ['negative chip', OVERLAY_HOST, '[data-testid="overlay-chip"][data-direction="negative"]'],
          ['neutral toggle', OVERLAY_HOST, '[data-testid="overlay-neutral-toggle"]'],
          ['badge chip', BADGE_HOST, '[data-testid="amplifyx-target-badge"]'],
        ] as const) {
          const ratio = pairRatio(host, inner);
          if (ratio !== null) results[label] = ratio;
        }
        const rowsPoints = document
          .querySelector(OVERLAY_HOST)
          ?.shadowRoot?.querySelectorAll('[data-testid="overlay-signal-rows"] [data-direction]');
        if (rowsPoints) {
          let index = 0;
          for (const point of rowsPoints) {
            const color = parseC(getComputedStyle(point).color);
            if (color) results[`rows points ${index}`] = contrast([color[0]!, color[1]!, color[2]!], effectiveBg(point));
            index += 1;
          }
        }

        // Yellow is never a text color: scan every element of every extension shadow root.
        const yellowText: string[] = [];
        const roots = [OVERLAY_HOST, POPOVER_HOST, ...[...document.querySelectorAll(BADGE_HOST)].map(() => BADGE_HOST)];
        for (const hostSelector of new Set(roots)) {
          const shadow = document.querySelector(hostSelector)?.shadowRoot;
          if (!shadow) continue;
          for (const el of shadow.querySelectorAll('*')) {
            if (getComputedStyle(el).color === 'rgb(255, 212, 0)') yellowText.push(`${hostSelector} ${el.tagName}`);
          }
        }
        return { results, yellowText };
        },
        { OVERLAY_HOST, POPOVER_HOST, BADGE_HOST },
      );

      // The required pairs MUST have been sampled (a missing element would otherwise silently
      // shrink the audited set): the chips depend on the draft's positive/negative signals.
      for (const required of [
        'row summary (fg2)',
        'popover caption (fg2)',
        'positive chip',
        'negative chip',
        'badge chip',
      ]) {
        expect(results.results[required], `${required} sampled in ${theme}`).not.toBeUndefined();
      }
      for (const [pair, ratio] of Object.entries(results.results)) {
        expect(ratio, `${pair} in ${theme}`).not.toBeNull();
        expect(ratio as number, `${pair} in ${theme}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(results.yellowText, `yellow text in ${theme}`).toEqual([]);
    };

    for (const theme of ['light', 'dim', 'lights-out'] as const) await audit(theme);
    expect(errors).toEqual([]);
  });

  test('all extension buttons are >= 28px and the numbers render tabular (VAL-DRAFT-046)', async ({ context }) => {
    // The Copy button only exists in the optimizer's done state: stub BOTH exchange kinds.
    await context.route('https://api.typesafe.ai/**', async (route: Route) => {
      const body = route.request().postData() ?? '';
      let parsed: { questions?: Record<string, unknown> } = {};
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        parsed = {};
      }
      const isOptimize = Object.keys(parsed.questions ?? {}).some((id) => id.startsWith('variant_'));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(isOptimize ? OPTIMIZE_RESPONSE : VERIFIED_JEV_RESPONSE),
      });
    });
    await saveKeyViaOptions(context);
    const page = await openFixture(context);
    await typeDraft(page, DRAFT);
    await expand(page);

    const heights = await page.evaluate(
      ({ OVERLAY_HOST }) => {
        const overlay = document.querySelector(OVERLAY_HOST)!.shadowRoot!;
        const measure = (el: Element | null): number => (el ? el.getBoundingClientRect().height : -1);
        return {
          row: measure(overlay.querySelector('[data-testid="amplifyx-overlay-row"]')),
          neutralToggle: measure(overlay.querySelector('[data-testid="overlay-neutral-toggle"]')),
          // The outline action exists only in the IDLE state — running replaces it with the
          // "Stronger hooks" header, so it is measured before the click below.
          optimizeAction: measure(overlay.querySelector('[data-testid="overlay-optimize"]')),
          chipPoints: getComputedStyle(overlay.querySelector('[data-testid="overlay-chip"] .points')!).fontVariantNumeric,
        };
      },
      { OVERLAY_HOST },
    );
    expect(heights.row).toBe(36);
    expect(heights.optimizeAction).toBeGreaterThanOrEqual(28);
    expect(heights.chipPoints).toBe('tabular-nums');
    if (heights.neutralToggle >= 0) expect(heights.neutralToggle).toBeGreaterThanOrEqual(28);

    // Run the optimizer so a Copy button exists (28px via the shared outline-button style).
    await page.getByTestId('overlay-optimize').click();
    await expect(page.getByTestId('overlay-optimizer')).toHaveAttribute('data-optimizer-state', 'done', {
      timeout: 15_000,
    });
    const copyHeight = await page.evaluate(
      ({ OVERLAY_HOST }) =>
        document
          .querySelector(OVERLAY_HOST)!
          .shadowRoot!.querySelector('[data-testid="overlay-optimizer-copy"]')
          ?.getBoundingClientRect().height ?? -1,
      { OVERLAY_HOST },
    );
    expect(copyHeight).toBeGreaterThanOrEqual(28);

    // The done state's hashtag "Add #Tag" links are link-styled buttons too — 28px minimum
    // (VAL-DRAFT-046; M6-SCRUTINY-004).
    const hashtagHeight = await page.evaluate(
      ({ OVERLAY_HOST }) =>
        document
          .querySelector(OVERLAY_HOST)!
          .shadowRoot!.querySelector('[data-testid="overlay-optimizer-hashtag"]')
          ?.getBoundingClientRect().height ?? -1,
      { OVERLAY_HOST },
    );
    expect(hashtagHeight).toBeGreaterThanOrEqual(28);

    // The popover close control: open the popover (the overlay collapses on that outside click —
    // the overlay heights above are already measured).
    await page.locator(`${BADGE}[data-amplifyx-post-id="${POST_1}"]`).click();
    await expect(page.locator(POPOVER)).toBeVisible();
    const closeAndNumerics = await page.evaluate(
      ({ OVERLAY_HOST, POPOVER_HOST, BADGE_HOST }) => {
        const popoverShadow = document.querySelector(POPOVER_HOST)?.shadowRoot;
        const badgeShadow = document.querySelector(BADGE_HOST)?.shadowRoot;
        const overlay = document.querySelector(OVERLAY_HOST)!.shadowRoot!;
        const numeric = (el: Element | null): string => (el ? getComputedStyle(el).fontVariantNumeric : '');
        return {
          popoverClose: popoverShadow?.querySelector('[data-testid="amplifyx-popover-close"]')?.getBoundingClientRect().height ?? -1,
          rowHeadline: numeric(overlay.querySelector('[data-testid="overlay-headline"]')),
          badgeChip: numeric(badgeShadow?.querySelector('[data-testid="amplifyx-target-badge"]') ?? null),
          popoverHeadline: numeric(popoverShadow?.querySelector('[data-testid="amplifyx-popover-local-score"]') ?? null),
        };
      },
      { OVERLAY_HOST, POPOVER_HOST, BADGE_HOST },
    );
    expect(closeAndNumerics.popoverClose).toBeGreaterThanOrEqual(28);

    // tabular-nums on every rendered number surface (chip points were sampled while expanded).
    expect(closeAndNumerics.rowHeadline).toBe('tabular-nums');
    expect(closeAndNumerics.badgeChip).toBe('tabular-nums');
    expect(closeAndNumerics.popoverHeadline).toBe('tabular-nums');
  });

  test('ordinary state-dependent action buttons are >= 28px tall (VAL-DRAFT-046, M6-SCRUTINY-004)', async () => {
    // The link-styled composer actions live in ordinary states the shared fixture above never
    // reaches: no-key (fresh profile), ready (key saved, autoAnalyze off) and error (every Jev
    // exchange fails). Each state gets its OWN isolated context, following the reduced-motion
    // pattern; the done-state hashtag links are covered by the VAL-DRAFT-046 test above.
    const heightOf = (locator: Locator): Promise<number> =>
      locator.evaluate((el) => el.getBoundingClientRect().height);
    const isolated = async <T>(run: (context: BrowserContext) => Promise<T>): Promise<T> => {
      const profile = await mkdtemp(path.join(tmpdir(), 'amplifyx-theme-a11y-'));
      let context: BrowserContext | null = null;
      try {
        context = await launchExtensionContext(profile);
        return await run(context);
      } finally {
        await context?.close();
        await rm(profile, { recursive: true, force: true });
      }
    };

    // no-key Connect Jev (expanding an ordinary no-key draft).
    const connectJev = await isolated(async (context) => {
      const page = await openFixture(context);
      await typeDraft(page, DRAFT);
      await expand(page);
      await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'no-key');
      return heightOf(page.getByTestId('overlay-connect-jev'));
    });
    expect(connectJev).toBeGreaterThanOrEqual(28);

    // ready "Analyze with AI" (key saved, autoAnalyze off — the explicit manual action).
    const analyze = await isolated(async (context) => {
      const options = await context.newPage();
      await options.goto(await optionsUrl(context));
      await expect(options.getByTestId('key-status')).not.toBeEmpty();
      await options.getByTestId('api-key-input').fill(SYNTHETIC_KEY);
      await options.getByTestId('save-key').click();
      await expect(options.getByTestId('key-status')).toHaveAttribute('data-state', 'present');
      await options.getByTestId('pref-autoAnalyze').uncheck();
      await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');
      await options.close();
      const page = await openFixture(context);
      // With autoAnalyze off nothing dispatches, so typeDraft's dispatch-counter wait would
      // never fire — type directly and wait for the row's ready state (the score-overlay
      // VAL-SETUP-010 pattern).
      await page.locator(HOME_COMPOSER).click();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await page.keyboard.type(DRAFT);
      await expect(page.getByTestId('amplifyx-overlay-row')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('amplifyx-overlay-row')).toHaveAttribute('data-jev-state', 'ready', {
        timeout: 15_000,
      });
      await expand(page);
      return heightOf(page.getByTestId('overlay-analyze'));
    });
    expect(analyze).toBeGreaterThanOrEqual(28);

    // AI-error Retry (row's block) and optimizer-error Retry: every Jev exchange fails with
    // HTTP 500 — the AI error rides the auto-analyzed draft, the optimizer error after its
    // action. The two Retry links share a test id, so each is scoped to its section.
    const retries = await isolated(async (context) => {
      await context.route('https://api.typesafe.ai/**', (route: Route) =>
        route.fulfill({ status: 500, contentType: 'text/plain', body: 'stub failure (M6-SCRUTINY-004)' }),
      );
      await saveKeyViaOptions(context);
      const page = await openFixture(context);
      await typeDraft(page, DRAFT);
      await expand(page);
      await expect(page.getByTestId('overlay-jev')).toHaveAttribute('data-jev-state', 'error', {
        timeout: 15_000,
      });
      const aiRetry = page.locator('[data-testid="overlay-jev"]').getByTestId('overlay-retry');
      await expect(aiRetry).toBeVisible();
      const aiRetryHeight = await heightOf(aiRetry);
      await page.getByTestId('overlay-optimize').click();
      await expect(page.getByTestId('overlay-optimizer')).toHaveAttribute('data-optimizer-state', 'error', {
        timeout: 15_000,
      });
      const optimizerRetry = page.locator('[data-testid="overlay-optimizer"]').getByTestId('overlay-retry');
      await expect(optimizerRetry).toBeVisible();
      return { aiRetryHeight, optimizerRetry: await heightOf(optimizerRetry) };
    });
    expect(retries.aiRetryHeight).toBeGreaterThanOrEqual(28);
    expect(retries.optimizerRetry).toBeGreaterThanOrEqual(28);
  });

  test('prefers-reduced-motion stops the pending pulse in the row and the popover (VAL-THEME-004)', async () => {
    // Two ISOLATED contexts: the pulse present without the preference, static under reduce.
    const run = async (
      reducedMotion: 'reduce' | 'no-preference',
    ): Promise<{ rowDot: { animation: string; opacity: string }; popoverDot: { animation: string; opacity: string } }> => {
      const profile = await mkdtemp(path.join(tmpdir(), 'amplifyx-theme-a11y-'));
      let context: BrowserContext | null = null;
      try {
        context = await launchExtensionContext(profile, { reducedMotion });
        let parked = 0;
        await context.route('https://api.typesafe.ai/**', async (route: Route) => {
          parked += 1;
          // Hold BOTH exchange kinds open long enough for the pending states to be read.
          await new Promise((resolve) => setTimeout(resolve, 8_000));
          await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        });
        await saveKeyViaOptions(context, 'key-reduced-motion-e2e');
        // Deep analysis needs jevForTargets enabled (the popover footer would render 'off' and
        // drop the button otherwise — the same setup the badges-popover Deep tests use).
        const options = await context.newPage();
        await options.goto(await optionsUrl(context));
        await options.getByTestId('pref-jevForTargets').check();
        await expect(options.getByTestId('prefs-status')).toHaveAttribute('data-state', 'success');
        await options.close();
        console.log(`[reduced-motion ${reducedMotion}] key saved`);
        const page = await openFixture(context);
        await typeDraft(page, DRAFT);
        const rowDot = page.locator(`${OVERLAY_HOST} .row .ai-dot[data-state='pending']`);
        await expect(rowDot).toBeVisible({ timeout: 15_000 });
        console.log(`[reduced-motion ${reducedMotion}] row pending visible`);

        // The popover's pending dot: Deep analysis on an eligible post, held by the same stub.
        await page.locator(`${BADGE}[data-amplifyx-post-id="${POST_1}"]`).click();
        await page.locator('[data-testid="amplifyx-popover-deep-analysis"]').click();
        const popoverDot = page.locator(`${POPOVER_HOST} .pending .dot`);
        await expect(popoverDot).toBeVisible({ timeout: 15_000 });
        console.log(`[reduced-motion ${reducedMotion}] popover pending visible`);
        expect(parked).toBeGreaterThanOrEqual(2);

        return await page.evaluate(() => {
          const overlay = document.querySelector('#amplifyx-overlay-host')!.shadowRoot!;
          const popoverShadow = document.querySelector('#amplifyx-target-popover-host')!.shadowRoot!;
          const styleOf = (el: Element | null): { animation: string; opacity: string } => {
            if (!el) return { animation: 'missing', opacity: 'missing' };
            const s = getComputedStyle(el);
            return { animation: s.animationName, opacity: s.opacity };
          };
          const rowDot = styleOf(overlay.querySelector('.row .ai-dot[data-state="pending"]'));
          const popoverDot = styleOf(popoverShadow.querySelector('.pending .dot'));
          return { rowDot, popoverDot };
        });
      } finally {
        await context?.close();
        await rm(profile, { recursive: true, force: true });
      }
    };

    const animated = await run('no-preference');
    expect(animated.rowDot.animation).toBe('amplifyx-pulse');
    expect(animated.popoverDot.animation).toBe('amplifyx-popover-pulse');

    const reduced = await run('reduce');
    expect(reduced.rowDot.animation).toBe('none');
    expect(reduced.rowDot.opacity).toBe('0.6');
    expect(reduced.popoverDot.animation).toBe('none');
    expect(reduced.popoverDot.opacity).toBe('0.6');
  });

  test('every content surface is English-only across row, expansion, transitions, badge and popover (VAL-CROSS-016)', async ({ context }) => {
    // Cover the ERROR state too: fail the optimize exchange, keep the draft analysis working.
    await context.route('https://api.typesafe.ai/**', async (route: Route) => {
      const body = route.request().postData() ?? '';
      let parsed: { questions?: Record<string, unknown> } = {};
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        parsed = {};
      }
      const isOptimize = Object.keys(parsed.questions ?? {}).some((id) => id.startsWith('variant_'));
      if (isOptimize) {
        await route.fulfill({ status: 500, contentType: 'text/plain', body: 'stub optimizer failure' });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VERIFIED_JEV_RESPONSE) });
    });
    await saveKeyViaOptions(context);
    const page = await openFixture(context);

    // '~' (velocity/ratio phrasing), '@'/'_' (handles), '›' (neutral toggle), '·' (separators),
    // '…' (ellipsis), '−' (signed points), '×' (close), '⌄' (the row's chevron glyph).
    const english = /^[A-Za-z0-9 .,:;!?%'"()\-–—/+·…#~@_\u203a\u00d7\u2212\u2304\n]*$/;
    const surfaceText = (hostSelector: string, innerSelector: string): Promise<string> =>
      page.evaluate(
        ([host, inner]) => document.querySelector(host)?.shadowRoot?.querySelector(inner)?.textContent ?? '',
        [hostSelector, innerSelector] as const,
      );

    // Collapsed row (state 1) -> expanded (state 2, with rows + error) -> collapsed again (state 3).
    await typeDraft(page, DRAFT);
    const rowText = await surfaceText(OVERLAY_HOST, '[data-testid="amplifyx-overlay-row"]');
    expect(rowText).toMatch(english);

    await expand(page);
    const expandedText = await page.getByTestId('amplifyx-overlay').textContent();
    expect(expandedText).toMatch(english);
    await page.getByTestId('overlay-neutral-toggle').click();
    expect(await page.getByTestId('amplifyx-overlay').textContent()).toMatch(english);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('amplifyx-overlay')).toHaveCount(0);
    expect(await surfaceText(OVERLAY_HOST, '[data-testid="amplifyx-overlay-row"]')).toMatch(english);

    // Badge chip (score only) + hover tooltip + popover (header, chips, footer).
    const badge = page.locator(`${BADGE}[data-amplifyx-post-id="${POST_1}"]`);
    await expect(badge).toBeVisible();
    expect(await surfaceText(BADGE_HOST, '[data-testid="amplifyx-target-badge"]')).toMatch(english);
    await badge.hover();
    expect(await surfaceText(BADGE_HOST, '[data-testid="amplifyx-badge-tooltip"]')).toMatch(english);

    await badge.click();
    await expect(page.locator(POPOVER)).toBeVisible();
    expect(await page.locator(POPOVER).textContent()).toMatch(english);
    await page.keyboard.press('Escape');
    await expect(page.locator(POPOVER)).toHaveCount(0);
  });
});

/** The fixture optimize reply (same ranked noul shape the optimizer E2E verifies live). */
const OPTIMIZE_RESPONSE = {
  model: 'jev-1.13.0',
  answers: {
    variant_question: { type: 'noul', noul: 0.87 },
    variant_number: { type: 'noul', noul: 0.64 },
    variant_claim: { type: 'noul', noul: 0.55 },
    variant_story: { type: 'noul', noul: 0.42 },
    hashtag_0: { type: 'noul', noul: 0.91 },
    hashtag_1: { type: 'noul', noul: 0.8 },
    hashtag_2: { type: 'noul', noul: 0.7 },
    hashtag_3: { type: 'noul', noul: 0.6 },
    hashtag_4: { type: 'noul', noul: 0.5 },
  },
  usage: { input_tokens: 10, output_tokens: 10 },
};
