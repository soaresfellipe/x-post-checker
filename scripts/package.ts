import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { checkReleaseManifest } from './manifest-check';
import { validateZipArchive } from './lib/zip';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, '.output');
const BUILD_DIR = path.join(ROOT, 'build');

const TARGETS = [
  { name: 'chrome', args: [] as string[], dir: 'chrome-mv3' },
  { name: 'firefox', args: ['-b', 'firefox', '--mv3'], dir: 'firefox-mv3' },
] as const;

function wxtZip(extraArgs: readonly string[]): void {
  execFileSync('pnpm', ['exec', 'wxt', 'zip', ...extraArgs], { cwd: ROOT, stdio: 'inherit' });
}

let failed = false;
rmSync(BUILD_DIR, { recursive: true, force: true });
mkdirSync(BUILD_DIR, { recursive: true });

for (const target of TARGETS) {
  wxtZip(target.args);

  const manifestPath = path.join(OUT_DIR, target.dir, 'manifest.json');
  const problems = checkReleaseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  for (const problem of problems) console.error(`[${target.name}] ${problem}`);
  if (problems.length > 0) failed = true;

  const zipName = `amplifyx-${target.dir}.zip`;
  const zipSource = path.join(OUT_DIR, zipName);
  if (!existsSync(zipSource)) {
    console.error(`[${target.name}] expected ${zipSource} was not produced`);
    failed = true;
    continue;
  }
  copyFileSync(zipSource, path.join(BUILD_DIR, zipName));

  // Artifact validation (VAL-SETUP-019): non-empty, readable as a ZIP, manifest.json inside.
  try {
    const entries = validateZipArchive(readFileSync(path.join(BUILD_DIR, zipName)), zipName, {
      mustContain: 'manifest.json',
    });
    const sizeKb = Math.round(statSync(path.join(BUILD_DIR, zipName)).size / 1024);
    console.log(
      `[${target.name}] archive OK (${sizeKb} KiB, ${entries.length} entries) -> build/${zipName}:`,
      entries.map((entry) => entry.name).join(', '),
    );
  } catch (error) {
    console.error(`[${target.name}] archive validation FAILED:`, error instanceof Error ? error.message : error);
    failed = true;
  }
}

if (failed) process.exit(1);
