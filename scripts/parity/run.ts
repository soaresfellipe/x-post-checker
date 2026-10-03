/**
 * The cross-browser fixture parity runner (`pnpm parity`).
 *
 * One flow registry (flows.ts), two transports, byte-identical in-page driver code in both
 * browsers:
 * - Chromium leg (playwright-e2e recipe): persistent context, `channel: 'chromium'`, e2e test
 *   build loaded via --load-extension, fixture-controlled Jev through the endpoint-override seam.
 * - Firefox leg (web-ext-smoke): web-ext installs the Firefox MV3 e2e build temporarily in
 *   headless Firefox (the readiness-proven path); Marionette drives the same driver code.
 *
 * Both browsers launch with the outage proxy configured, so api.typesafe.ai is genuinely
 * unreachable for the whole run (the non-outage flows never touch it — their Jev calls go to the
 * fixture mock; the outage flows prove the refusal behavior end to end). This also fails any
 * accidental real-API call loudly instead of leaking.
 *
 * Outputs: test-results/parity/<browser>.json + per-flow screenshots, then report.json with the
 * per-flow expectation verdicts and the cross-browser stable-field comparison. Exit 1 on any
 * failure. NOT part of the `pnpm test` gate; run it explicitly (it builds + launches browsers).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import esbuild from 'esbuild';
import { FIXTURE_PORT, TEST_MODE } from '../build-variants';
import { getE2eBeacons, startFixtureServer } from '../lib/fixture';
import { OUTAGE_PROXY_PORT, startOutageProxy } from '../lib/outage-proxy';
import { MarionetteClient } from '../lib/marionette';
import type { FlowOutcome } from './inpage-driver';
import { PARITY_FLOWS, stripVolatile } from './flows';

const ROOT = path.resolve(import.meta.dirname, '../..');
const REPORT_DIR = path.join(ROOT, 'test-results', 'parity');
const CHROME_E2E_DIR = path.join(ROOT, '.output', 'chrome-mv3-e2e');
const FIREFOX_E2E_DIR = path.join(ROOT, '.output', 'firefox-mv3-e2e');
const FIXTURE_URL = `http://localhost:${FIXTURE_PORT}/`;

interface FlowRecord {
  flow: string;
  ok: boolean;
  failure?: string;
  outcome?: FlowOutcome;
  screenshot?: string;
  durationMs: number;
}

interface LegResult {
  browser: 'chrome' | 'firefox';
  flows: FlowRecord[];
  pageErrors: string[];
  /** Options-page load check (VAL-SETUP-020: the page opens without a manifest/runtime error). */
  optionsCheck?: { ok: boolean; detail: string; screenshot?: string };
}

function log(message: string): void {
  console.log(`[parity] ${message}`);
}

function findFirefoxBinary(): string {
  const cacheRoot = path.join(process.env['HOME'] ?? '', '.cache', 'ms-playwright');
  const candidates = readdirSync(cacheRoot)
    .filter((name) => name.startsWith('firefox-'))
    .sort()
    .reverse();
  for (const candidate of candidates) {
    const binary = path.join(cacheRoot, candidate, 'firefox', 'firefox');
    try {
      readdirSync(path.join(cacheRoot, candidate, 'firefox'));
      return binary;
    } catch {
      continue;
    }
  }
  throw new Error('Playwright Firefox binary not found under ~/.cache/ms-playwright (run init.sh)');
}

/**
 * Compiles the in-page driver (typed source, straight `.toString()` would leak the bundler's
 * `__name` helper into the page) into an IIFE exposing `__ampxDriver.fixtureDriverMain`.
 */
async function compileDriver(): Promise<string> {
  const source = readFileSync(path.join(ROOT, 'scripts', 'parity', 'inpage-driver.ts'), 'utf8');
  const result = await esbuild.build({
    stdin: { contents: source, loader: 'ts', resolveDir: path.join(ROOT, 'scripts', 'parity'), sourcefile: 'inpage-driver.ts' },
    bundle: false,
    format: 'iife',
    globalName: '__ampxDriver',
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0]!.text;
}

let driverIife: string | null = null;

/** Serializes the in-page driver for expression evaluation in both transports. */
function driverExpression(flow: string, arg: { seed: Record<string, unknown>; texts: Record<string, string> }): string {
  if (driverIife === null) throw new Error('driver not compiled');
  return `${driverIife}\n__ampxDriver.fixtureDriverMain(${JSON.stringify(flow)}, ${JSON.stringify(arg)})`;
}

function buildExtensions(targets: readonly ('chrome' | 'firefox')[]): void {
  if (targets.includes('chrome')) {
    execFileSync('pnpm', ['exec', 'wxt', 'build', '--mode', TEST_MODE], { cwd: ROOT, stdio: 'inherit' });
  }
  if (targets.includes('firefox')) {
    execFileSync('pnpm', ['exec', 'wxt', 'build', '-b', 'firefox', '--mv3', '--mode', TEST_MODE], { cwd: ROOT, stdio: 'inherit' });
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Chromium leg (playwright-e2e recipe from test/e2e/extension.ts)
// ---------------------------------------------------------------------------

async function runChromeLeg(flows: readonly string[], fixtureEpoch: number): Promise<LegResult> {
  const result: LegResult = { browser: 'chrome', flows: [], pageErrors: [] };
  const profileDir = mkdtempSync(path.join(tmpdir(), 'amplifyx-parity-chrome-'));
  const context: BrowserContext = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 1200 },
    proxy: { server: `http://127.0.0.1:${OUTAGE_PROXY_PORT}`, bypass: 'localhost, 127.0.0.1' },
    args: [`--disable-extensions-except=${CHROME_E2E_DIR}`, `--load-extension=${CHROME_E2E_DIR}`],
    timeout: 45_000,
  });
  try {
    // The extension is initialized when its background service worker is up.
    await (context.serviceWorkers()[0] ?? context.waitForEvent('serviceworker', { timeout: 15_000 }));

    const page = await context.newPage();
    page.on('pageerror', (error) => result.pageErrors.push(`pageerror: ${error.message}`));

    for (const flow of flows) {
      const started = Date.now();
      const parityFlow = PARITY_FLOWS.find((candidate) => candidate.name === flow)!;
      try {
        await page.goto(`${FIXTURE_URL}?now=${fixtureEpoch}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        const outcome = (await page.evaluate(driverExpression(flow, parityFlow.arg))) as FlowOutcome;
        const screenshot = path.join(REPORT_DIR, 'chrome', `${flow}.png`);
        await page.screenshot({ path: screenshot });
        result.flows.push({ flow, ok: true, outcome, screenshot, durationMs: Date.now() - started });
        log(`chrome/${flow}: OK (${Date.now() - started} ms)`);
      } catch (error) {
        const screenshot = path.join(REPORT_DIR, 'chrome', `${flow}-FAILED.png`);
        await page.screenshot({ path: screenshot }).catch(() => undefined);
        result.flows.push({
          flow,
          ok: false,
          failure: error instanceof Error ? error.message : String(error),
          screenshot,
          durationMs: Date.now() - started,
        });
        log(`chrome/${flow}: FAILED — ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Options-page check (VAL-SETUP-020, Chrome): open the bundled page directly in the loaded
    // extension and require its key section to mount without a page error.
    try {
      const workerUrl = context.serviceWorkers()[0]?.url() ?? '';
      const extensionId = /chrome-extension:\/\/([^/]+)\//.exec(workerUrl)?.[1];
      if (extensionId === undefined) throw new Error(`service worker URL has no extension id: ${workerUrl}`);
      const optionsPage = await context.newPage();
      const optionsErrors: string[] = [];
      optionsPage.on('pageerror', (error) => optionsErrors.push(error.message));
      await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await optionsPage.waitForSelector('[data-testid="key-status"]', { timeout: 10_000 });
      const mounted = await optionsPage.evaluate(() => ({
        keyStatus: document.querySelector('[data-testid="key-status"]') !== null,
        headline: document.title,
      }));
      const screenshot = path.join(REPORT_DIR, 'chrome', 'options-page.png');
      await optionsPage.screenshot({ path: screenshot });
      result.optionsCheck = {
        ok: mounted['keyStatus'] === true && optionsErrors.length === 0,
        detail: `mounted: ${JSON.stringify(mounted)}, pageErrors: ${optionsErrors.length === 0 ? 'none' : optionsErrors.join('; ')}`,
        screenshot,
      };
      await optionsPage.close();
      log(`chrome/options-page: ${result.optionsCheck.ok ? 'OK' : 'FAILED'} — ${result.optionsCheck.detail}`);
    } catch (error) {
      result.optionsCheck = { ok: false, detail: error instanceof Error ? error.message : String(error) };
      log(`chrome/options-page: FAILED — ${result.optionsCheck.detail}`);
    }
  } finally {
    await context.close();
    rmSync(profileDir, { recursive: true, force: true });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Firefox leg (web-ext + headless Firefox, driven over Marionette)
// ---------------------------------------------------------------------------

async function runFirefoxLeg(flows: readonly string[], fixtureEpoch: number): Promise<LegResult> {
  const result: LegResult = { browser: 'firefox', flows: [], pageErrors: [] };
  const webExt = await import('web-ext');
  const profileDir = mkdtempSync(path.join(tmpdir(), 'amplifyx-parity-firefox-'));
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'amplifyx-parity-firefox-artifacts-'));
  const runner = await webExt.default.cmd.run(
    {
      sourceDir: FIREFOX_E2E_DIR,
      firefox: findFirefoxBinary(),
      artifactsDir,
      startUrl: ['about:blank'],
      noReload: true,
      args: ['-headless', '-marionette', '-no-remote'],
      pref: {
        'network.proxy.type': 1,
        'network.proxy.http': '127.0.0.1',
        'network.proxy.http_port': OUTAGE_PROXY_PORT,
        'network.proxy.ssl': '127.0.0.1',
        'network.proxy.ssl_port': OUTAGE_PROXY_PORT,
        // The fixture and the Jev mock are loopback services: they must bypass the proxy.
        'network.proxy.no_proxies_on': 'localhost,127.0.0.1',
        'network.proxy.allow_hijacking_localhost': false,
      },
    },
    { shouldExitProgram: false },
  );

  let marionette: MarionetteClient | null = null;
  try {
    marionette = new MarionetteClient();
    await marionette.connect();
    await marionette.cmd('WebDriver:NewSession');
    await marionette.cmd('WebDriver:SetTimeouts', { script: 60_000, pageLoad: 30_000, implicit: 0 });
    await marionette.cmd('WebDriver:SetWindowRect', { width: 1280, height: 1200 });

    for (const flow of flows) {
      const started = Date.now();
      const parityFlow = PARITY_FLOWS.find((candidate) => candidate.name === flow)!;
      try {
        await marionette.cmd('WebDriver:Navigate', { url: `${FIXTURE_URL}?now=${fixtureEpoch}` });
        // The driver's compiled IIFE is a STATEMENT (var __ampxDriver = ...): it must sit on its
        // own line, outside the awaited expression.
        const script =
          `const [done] = arguments;\n` +
          `${driverIife ?? ''}\n` +
          `Promise.resolve(__ampxDriver.fixtureDriverMain(${JSON.stringify(flow)}, ${JSON.stringify(parityFlow.arg)}))` +
          `.then((value) => done(value), (error) => done({ driverError: String(error) }));`;
        const wrapped = await marionette.cmd<{ value?: FlowOutcome }>('WebDriver:ExecuteAsyncScript', { script });
        const outcome = (wrapped['value'] ?? {}) as FlowOutcome;
        if (typeof outcome['driverError'] === 'string') throw new Error(outcome['driverError']);
        const screenshot = path.join(REPORT_DIR, 'firefox', `${flow}.png`);
        const shot = await marionette.cmd<{ value?: string }>('WebDriver:TakeScreenshot');
        if (shot['value'] !== undefined) writeFileSync(screenshot, Buffer.from(shot['value'], 'base64'));
        result.flows.push({ flow, ok: true, outcome, screenshot, durationMs: Date.now() - started });
        log(`firefox/${flow}: OK (${Date.now() - started} ms)`);
      } catch (error) {
        const screenshot = path.join(REPORT_DIR, 'firefox', `${flow}-FAILED.png`);
        try {
          const shot = await marionette.cmd<{ value?: string }>('WebDriver:TakeScreenshot');
          if (shot['value'] !== undefined) writeFileSync(screenshot, Buffer.from(shot['value'], 'base64'));
        } catch {
          // Screenshot best-effort on failure paths.
        }
        result.flows.push({
          flow,
          ok: false,
          failure: error instanceof Error ? error.message : String(error),
          screenshot,
          durationMs: Date.now() - started,
        });
        log(`firefox/${flow}: FAILED — ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Options-page check (VAL-SETUP-020, Firefox): Marionette cannot navigate to extension
    // pages, so the extension's own openOptionsPage API is triggered through the e2e seed and
    // the page announces its successful mount as a fixture beacon.
    try {
      const seedScript =
        `const [done] = arguments;\n` +
        `const timeout = setTimeout(() => done({ ack: false, error: 'seed ack timeout' }), 10000);\n` +
        `window.addEventListener('message', function onAck(e) {\n` +
        `  const d = e.data || {};\n` +
        `  if (d.type === 'amplifyx:e2e-seed-applied' && d.seedId === 'options-open') {\n` +
        `    clearTimeout(timeout); done({ ack: d.ok !== false, error: d.error || null });\n` +
        `  }\n` +
        `});\n` +
        `window.postMessage({ type: 'amplifyx:e2e-seed', seedId: 'options-open', payload: { openOptionsPage: true } }, '*');`;
      await marionette.cmd('WebDriver:Navigate', { url: `${FIXTURE_URL}?now=${fixtureEpoch}` });
      const ack = await marionette.cmd<{ value?: { ack?: boolean; error?: string } }>('WebDriver:ExecuteAsyncScript', { script: seedScript });
      const ackValue = ack['value'] ?? {};
      const beaconDeadline = Date.now() + 20_000;
      let beaconSeen = false;
      while (Date.now() < beaconDeadline) {
        if (getE2eBeacons().some((beacon) => beacon.surface === 'options')) {
          beaconSeen = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const shot = await marionette.cmd<{ value?: string }>('WebDriver:TakeScreenshot');
      const screenshot = path.join(REPORT_DIR, 'firefox', 'options-page.png');
      if (shot['value'] !== undefined) writeFileSync(screenshot, Buffer.from(shot['value'], 'base64'));
      result.optionsCheck = {
        ok: ackValue['ack'] === true && beaconSeen,
        detail: `seed ack: ${JSON.stringify(ackValue)}, options-mount beacon: ${beaconSeen ? 'received' : 'TIMEOUT'}`,
        screenshot,
      };
      log(`firefox/options-page: ${result.optionsCheck.ok ? 'OK' : 'FAILED'} — ${result.optionsCheck.detail}`);
    } catch (error) {
      result.optionsCheck = { ok: false, detail: error instanceof Error ? error.message : String(error) };
      log(`firefox/options-page: FAILED — ${result.optionsCheck.detail}`);
    }
  } finally {
    marionette?.close();
    // Kill the web-ext-spawned Firefox process by its own PID handle.
    const multiRunner = runner as { extensionRunners?: Array<{ runningInfo?: { firefox?: { kill(signal?: string): void } } }> };
    for (const extensionRunner of multiRunner.extensionRunners ?? []) {
      extensionRunner.runningInfo?.firefox?.kill('SIGKILL');
    }
    rmSync(profileDir, { recursive: true, force: true });
    rmSync(artifactsDir, { recursive: true, force: true });
  }
  return result;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const browserArg = (process.argv.find((token) => token.startsWith('--browser=')) ?? '--browser=both').split('=')[1];
  if (browserArg !== 'chrome' && browserArg !== 'firefox' && browserArg !== 'both') {
    throw new Error(`--browser must be chrome, firefox, or both (got: ${String(browserArg)})`);
  }
  const targets: readonly ('chrome' | 'firefox')[] = browserArg === 'both' ? ['chrome', 'firefox'] : [browserArg];
  const compare = browserArg === 'both';

  mkdirSync(path.join(REPORT_DIR, 'chrome'), { recursive: true });
  mkdirSync(path.join(REPORT_DIR, 'firefox'), { recursive: true });

  buildExtensions(targets);

  const fixture = await startFixtureServer(FIXTURE_PORT);
  const proxy = await startOutageProxy(OUTAGE_PROXY_PORT);
  const fixtureEpoch = Date.now();
  driverIife = await compileDriver();

  try {
    const flowNames = PARITY_FLOWS.map((flow) => flow.name);
    const legs: LegResult[] = [];
    if (targets.includes('chrome')) legs.push(await runChromeLeg(flowNames, fixtureEpoch));
    if (targets.includes('firefox')) legs.push(await runFirefoxLeg(flowNames, fixtureEpoch));

    // Per-browser expectations (VAL-DRAFT-025 / VAL-CROSS-010 checks) + page-error scan.
    for (const leg of legs) {
      for (const record of leg.flows) {
        if (!record.ok) continue;
        const parityFlow = PARITY_FLOWS.find((candidate) => candidate.name === record.flow)!;
        const failure = parityFlow.expect(record.outcome!);
        if (failure !== null) {
          record.ok = false;
          record.failure = `expectation: ${failure}`;
          log(`${leg.browser}/${record.flow}: EXPECTATION FAILED — ${failure}`);
        }
      }
    }

    // Cross-browser comparison (VAL-CROSS-009): stable outcome fields must be equal.
    let crossBrowserOk = true;
    if (compare && legs.length === 2) {
      for (const flow of PARITY_FLOWS) {
        const chrome = legs[0]!.flows.find((record) => record.flow === flow.name)!;
        const firefox = legs[1]!.flows.find((record) => record.flow === flow.name)!;
        if (!chrome.ok || !firefox.ok) {
          crossBrowserOk = false;
          log(`cross-browser/${flow.name}: SKIPPED (a leg failed)`);
          continue;
        }
        const left = stripVolatile(chrome.outcome!);
        const right = stripVolatile(firefox.outcome!);
        if (!deepEqual(left, right)) {
          crossBrowserOk = false;
          log(`cross-browser/${flow.name}: OUTCOMES DIFFER\n  chrome:  ${JSON.stringify(left)}\n  firefox: ${JSON.stringify(right)}`);
        } else {
          log(`cross-browser/${flow.name}: equivalent`);
        }
      }
    }

    const optionsChecksOk = legs.every((leg) => leg.optionsCheck?.ok === true);
    const allOk =
      legs.every((leg) => leg.flows.every((record) => record.ok)) &&
      crossBrowserOk &&
      optionsChecksOk &&
      legs.every((leg) => leg.pageErrors.length === 0);
    writeFileSync(
      path.join(REPORT_DIR, 'report.json'),
      JSON.stringify({ ok: allOk, fixtureEpoch, legs, crossBrowserOk }, null, 2),
    );
    log(allOk ? 'ALL PARITY CHECKS PASSED' : 'PARITY CHECKS FAILED (report: test-results/parity/report.json)');
    process.exitCode = allOk ? 0 : 1;
  } finally {
    fixture.close();
    proxy.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
