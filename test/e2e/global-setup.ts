import { execFileSync } from 'node:child_process';
import { TEST_MODE } from '../../scripts/build-variants';

/** Builds the test-only extension variant (adds the localhost fixture match) before any spec runs. */
export default function globalSetup(): void {
  if (process.env.SKIP_E2E_BUILD === '1') return;
  execFileSync('pnpm', ['exec', 'wxt', 'build', '--mode', TEST_MODE], { stdio: 'inherit' });
}
