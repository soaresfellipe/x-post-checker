import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { renderFixtureHtml } from '../../test/fixtures/x-fixture';
import { FIXTURE_PORT } from '../build-variants';
import { handleMockJevRequest } from './mock-jev';

/**
 * The fixture HTTP server: the local x.com mock plus the Jev mock endpoints the Firefox smoke
 * harness needs (scripts/parity — an event-page background cannot be route-intercepted, so the
 * harness redirects Jev to this server via the e2e endpoint-override seam).
 *
 * Exported as a factory so the parity runner can host it in-process; `pnpm fixture` runs it
 * standalone. Any non-mock path serves the home fixture so SPA-style links (/handle/status/id)
 * resolve during E2E.
 */
export function startFixtureServer(port: number = FIXTURE_PORT): Promise<Server> {
  const server = createServer((request, response) => {
    void route(request, response);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/** Beacons hit by e2e surfaces (e.g. the Options page load proof). Sorted by arrival. */
const beacons: Array<{ surface: string; at: number }> = [];

/** Returns the beacons recorded so far (the parity harness polls this). */
export function getE2eBeacons(): Array<{ surface: string; at: number }> {
  return [...beacons];
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/favicon.ico') {
    response.writeHead(204).end();
    return;
  }
  if (url.pathname === '/__mock/jev' || url.pathname.startsWith('/__mock/jev/')) {
    await handleMockJevRequest(request, response, url);
    return;
  }
  if (url.pathname === '/__e2e/beacon') {
    // A surface announces itself (e.g. `?surface=options`): 204 to the caller, recorded for the harness.
    beacons.push({ surface: url.searchParams.get('surface') ?? 'unknown', at: Date.now() });
    response.writeHead(204, { 'access-control-allow-origin': '*' }).end();
    return;
  }
  if (url.pathname === '/__e2e/beacons') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ beacons: getE2eBeacons() }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  // `?now=<epoch>` pins the posts' rendered timestamps: the parity harness uses one epoch for
  // both browser legs so post ages (and therefore badge scores) are directly comparable.
  const nowParam = Number(url.searchParams.get('now'));
  response.end(renderFixtureHtml(Number.isFinite(nowParam) && nowParam > 0 ? nowParam : Date.now()));
}
