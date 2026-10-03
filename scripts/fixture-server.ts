import { FIXTURE_PORT } from './build-variants';
import { startFixtureServer } from './lib/fixture';

// Standalone fixture server (`pnpm fixture`, port 3177). The parity runner hosts the same server
// in-process via scripts/lib/fixture.ts instead of spawning this.
void startFixtureServer(FIXTURE_PORT).then(() => {
  console.log(`AmplifyX fixture listening on http://localhost:${FIXTURE_PORT}/`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => process.exit(0));
}
