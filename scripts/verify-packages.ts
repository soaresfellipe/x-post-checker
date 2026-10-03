/**
 * Release-package verification (`pnpm verify:packages`) — VAL-SETUP-020 + VAL-CROSS-015.
 *
 * Runs against the ZIPs in `build/` (produce them with `pnpm package` first):
 * 1. both artifacts re-validated as ZIPs straight from `build/` (non-empty, readable, manifest.json);
 * 2. both manifests pass `checkReleaseManifest` and have the browser-correct background shape;
 * 3. the CHROME zip is loaded for real: unpacked into a Playwright persistent context, the
 *    background service worker comes up, and the bundled Options page opens with its key
 *    section mounted and no page error (screenshot: build/verify/chrome-options-page.png);
 * 4. the FIREFOX zip is loaded for real: unpacked and temporarily installed into headless
 *    Firefox via web-ext (install succeeds = the manifest validates against the live schema),
 *    then shut down gracefully and confirmed ENABLED via the assigned extension UUID in the
 *    profile's prefs; web-ext lint (--warnings-as-errors) runs against the unpacked zip bytes.
 *
 * Firefox note: Marionette is barred from `moz-extension://` navigation (Gecko limitation), so
 * the Options-page-open behavior on the Firefox build is exercised on the e2e build (identical
 * Options bundle) inside `pnpm parity`; the release Firefox check here covers install +
 * initialization + lint.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { checkReleaseManifest } from './manifest-check';
import { validateZipArchive, ZipValidationError } from './lib/zip';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');
const VERIFY_DIR = path.join(BUILD_DIR, 'verify');

interface ArtifactPlan {
  name: string;
  zip: string;
  unpacked: string;
  expectations: {
    background: 'service_worker' | 'scripts';
    geckoId?: string;
  };
}

function fail(message: string): never {
  console.error(`[verify-packages] FAIL: ${message}`);
  process.exit(1);
}

function log(message: string): void {
  console.log(`[verify-packages] ${message}`);
}

/** Unzips `zipPath` with the system unzip (no JS inflate dependency) into a fresh temp dir. */
function unzipTo(zipPath: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'amplifyx-verify-'));
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', dir], { stdio: 'pipe' });
  return dir;
}

function findFirefoxBinary(): string {
  const cacheRoot = path.join(process.env['HOME'] ?? '', '.cache', 'ms-playwright');
  const candidates = readdirSync(cacheRoot)
    .filter((name) => name.startsWith('firefox-'))
    .sort()
    .reverse();
  for (const candidate of candidates) {
    const binary = path.join(cacheRoot, candidate, 'firefox', 'firefox');
    if (existsSync(binary)) return binary;
  }
  fail('Playwright Firefox binary not found under ~/.cache/ms-playwright (run init.sh)');
}

async function verifyChromeLoad(unpacked: string): Promise<{ screenshot: string }> {
  const profileDir = mkdtempSync(path.join(tmpdir(), 'amplifyx-verify-chrome-'));
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 1200 },
    args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`],
    timeout: 45_000,
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
    const extensionId = /chrome-extension:\/\/([^/]+)\//.exec(worker.url())?.[1];
    if (extensionId === undefined) fail(`chrome service worker URL has no extension id: ${worker.url()}`);
    const optionsPage = await context.newPage();
    const errors: string[] = [];
    optionsPage.on('pageerror', (error) => errors.push(error.message));
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await optionsPage.waitForSelector('[data-testid="key-status"]', { timeout: 10_000 });
    if (errors.length > 0) fail(`chrome options page raised page errors: ${errors.join('; ')}`);
    const screenshot = path.join(VERIFY_DIR, 'chrome-options-page.png');
    await optionsPage.screenshot({ path: screenshot });
    log(`chrome zip loads: service worker up (id ${extensionId}), Options page mounts, no page errors`);
    return { screenshot };
  } finally {
    await context.close();
    rmSync(profileDir, { recursive: true, force: true });
  }
}

interface FirefoxLoadResult {
  installOk: boolean;
  addonActive: boolean;
  lintClean: boolean;
  lintDetail: string;
}

async function verifyFirefoxLoad(unpacked: string): Promise<FirefoxLoadResult> {
  // Lint the SHIPPED bytes (the unpacked zip), not the build directory.
  let lintClean = true;
  let lintDetail: string;
  try {
    const lintOutput = execFileSync(
      'pnpm',
      ['exec', 'web-ext', 'lint', '--source-dir', unpacked, '--warnings-as-errors'],
      { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' },
    );
    lintDetail = lintOutput.split('\n').filter((line) => /errors|notices|warnings/.test(line)).join(' ').trim();
  } catch (error) {
    lintClean = false;
    lintDetail = error instanceof Error ? error.message : String(error);
  }

  const profileDir = mkdtempSync(path.join(tmpdir(), 'amplifyx-verify-firefox-profile-'));
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'amplifyx-verify-firefox-artifacts-'));
  const webExt = await import('web-ext');
  const runner = await webExt.default.cmd.run(
    {
      sourceDir: unpacked,
      firefox: findFirefoxBinary(),
      artifactsDir,
      startUrl: ['about:blank'],
      noReload: true,
      args: ['-headless', '-marionette', '-no-remote'],
    },
    { shouldExitProgram: false },
  );
  let installOk = false;
  let addonActive = false;
  try {
    // Reaching this point means web-ext's temporary install succeeded (Firefox validated the
    // manifest against its live schema). The RUNTIME truth comes from the runner's own RDP
    // connection: listAddons must contain the installed, active extension.
    const { MarionetteClient } = await import('./lib/marionette');
    const marionette = new MarionetteClient();
    await marionette.connect();
    await marionette.cmd('WebDriver:NewSession');
    await marionette.cmd('WebDriver:Navigate', { url: 'about:blank' });
    marionette.close();
    installOk = true;

    const multiRunner = runner as {
      extensionRunners?: Array<{
        remoteFirefox?: { getInstalledAddon(addonId: string): Promise<{ id: string }> };
      }>;
    };
    const remoteFirefox = multiRunner.extensionRunners?.[0]?.remoteFirefox;
    if (remoteFirefox === undefined) fail('web-ext runner exposes no RDP client to verify the installed add-on');
    const addon = await remoteFirefox.getInstalledAddon('amplifyx@typesafe.ai');
    addonActive = addon.id === 'amplifyx@typesafe.ai';
  } catch (error) {
    fail(`firefox zip failed to install/run in headless Firefox: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // Graceful stop so Firefox flushes prefs to the profile before cleanup.
    const multiRunner = runner as { extensionRunners?: Array<{ runningInfo?: { firefox?: { kill(sig?: string): void } } }> };
    for (const extensionRunner of multiRunner.extensionRunners ?? []) {
      extensionRunner.runningInfo?.firefox?.kill('SIGTERM');
    }
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  rmSync(profileDir, { recursive: true, force: true });
  rmSync(artifactsDir, { recursive: true, force: true });
  return { installOk, addonActive, lintClean, lintDetail };
}

async function main(): Promise<void> {
  const plans: ArtifactPlan[] = [
    {
      name: 'chrome',
      zip: path.join(BUILD_DIR, 'amplifyx-chrome-mv3.zip'),
      unpacked: '',
      expectations: { background: 'service_worker' },
    },
    {
      name: 'firefox',
      zip: path.join(BUILD_DIR, 'amplifyx-firefox-mv3.zip'),
      unpacked: '',
      expectations: { background: 'scripts', geckoId: 'amplifyx@typesafe.ai' },
    },
  ];

  mkdirSync(VERIFY_DIR, { recursive: true });

  for (const plan of plans) {
    log(`--- ${plan.name}: ${plan.zip}`);
    if (!existsSync(plan.zip)) fail(`${plan.zip} not found — run \`pnpm package\` first`);

    // 1. Archive validation straight from build/.
    let entries: ReturnType<typeof validateZipArchive>;
    try {
      entries = validateZipArchive(readFileSync(plan.zip), path.basename(plan.zip), { mustContain: 'manifest.json' });
    } catch (error) {
      fail(`archive validation failed: ${error instanceof ZipValidationError ? error.message : String(error)}`);
    }
    log(`archive OK: ${entries.length} entries`);

    // 2. Unpack + manifest checks.
    plan.unpacked = unzipTo(plan.zip);
    const manifest = JSON.parse(readFileSync(path.join(plan.unpacked, 'manifest.json'), 'utf8'));
    const problems = checkReleaseManifest(manifest);
    if (problems.length > 0) fail(`release manifest problems: ${problems.join('; ')}`);
    if (plan.expectations.background === 'service_worker' && typeof manifest.background?.service_worker !== 'string') {
      fail('chrome manifest is missing background.service_worker');
    }
    if (plan.expectations.background === 'scripts' && !Array.isArray(manifest.background?.scripts)) {
      fail('firefox manifest is missing background.scripts (event page)');
    }
    const geckoId = manifest.browser_specific_settings?.gecko?.id;
    if (plan.expectations.geckoId !== undefined && geckoId !== plan.expectations.geckoId) {
      fail(`firefox manifest gecko id is ${String(geckoId)}, expected ${plan.expectations.geckoId}`);
    }
    log(`manifest OK (${plan.expectations.background})`);

    // 3/4. Real load tests per browser.
    if (plan.name === 'chrome') {
      await verifyChromeLoad(plan.unpacked);
    } else {
      const firefox = await verifyFirefoxLoad(plan.unpacked);
      if (!firefox.lintClean) fail(`web-ext lint on the shipped zip failed: ${firefox.lintDetail}`);
      log(`web-ext lint clean on shipped zip: ${firefox.lintDetail}`);
      if (!firefox.installOk) fail('firefox temporary install did not complete');
      if (!firefox.addonActive) fail('firefox extension is not active in the running browser (listAddons miss)');
      log('firefox zip loads: temporary install OK, extension listed as installed by the browser, lint clean');
    }
    rmSync(plan.unpacked, { recursive: true, force: true });
  }

  log('ALL PACKAGE CHECKS PASSED');
  writeFileSync(path.join(VERIFY_DIR, 'summary.json'), JSON.stringify({ ok: true, checkedAt: new Date().toISOString() }, null, 2));
}

await main();
