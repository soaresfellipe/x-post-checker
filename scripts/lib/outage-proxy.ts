import { createServer, connect as netConnect, type Server } from 'node:net';

/**
 * The API-outage proxy (VAL-CROSS-010): a loopback HTTP CONNECT proxy that REFUSES the tunnel to
 * api.typesafe.ai while passing any other host through. Launching the browsers with this proxy
 * makes the Jev endpoint genuinely unreachable at the network level — no interception framework
 * involved — so "local scoring survives an outage" is proven against a real failure, in both
 * browsers (Chromium via Playwright's proxy option, Firefox via network.proxy.* prefs).
 *
 * Loopback targets (the fixture on 3177) bypass the proxy in both browsers by default, so the
 * fixture and the Jev mock are unaffected.
 */

export const OUTAGE_PROXY_PORT = 3178;
const BLOCKED_HOST = 'api.typesafe.ai';

export function startOutageProxy(port: number = OUTAGE_PROXY_PORT): Promise<Server> {
  const server = createServer((clientSocket) => {
    // Plain-HTTP proxying never happens in this mission (https-only targets, loopback bypassed);
    // any non-CONNECT traffic is refused the same way the blocked host is.
    clientSocket.end();
  });

  server.on('connect', (request, clientSocket, head) => {
    const [host, port] = request.url?.split(':') ?? [];
    if (host === BLOCKED_HOST) {
      // Refuse the tunnel with a hard RST: the fetch fails at the transport layer immediately
      // (the Jev client's 'network' failure kind). A graceful 502 here hangs Chromium's CONNECT
      // (it keeps waiting), so the refusal must destroy the socket.
      clientSocket.destroy();
      return;
    }
    const upstream = netConnect({ host: host ?? '', port: Number(port ?? 443) }, () => {
      clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.end());
    clientSocket.on('error', () => upstream.destroy());
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
