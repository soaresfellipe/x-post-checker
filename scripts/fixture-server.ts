import { createServer } from 'node:http';
import { renderFixtureHtml } from '../test/fixtures/x-fixture';
import { FIXTURE_PORT } from './build-variants';

// Any path serves the home fixture so SPA-style links (/handle/status/id) resolve during E2E.
const server = createServer((request, response) => {
  if (request.url === '/favicon.ico') {
    response.writeHead(204).end();
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(renderFixtureHtml());
});

server.listen(FIXTURE_PORT, '127.0.0.1', () => {
  console.log(`AmplifyX fixture listening on http://localhost:${FIXTURE_PORT}/`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
