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
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(renderFixtureHtml());
}
