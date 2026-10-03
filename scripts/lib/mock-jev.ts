import type { IncomingMessage, ServerResponse } from 'node:http';
import { VERIFIED_JEV_RESPONSE } from '../../test/helpers/jev-fixtures';

/**
 * Deterministic Jev mock served by the fixture server at `/__mock/jev`. The Firefox smoke harness
 * redirects the extension's Jev calls here through the e2e endpoint-override seam
 * (src/core/test-hooks.ts) because an event-page background cannot be route-intercepted; the
 * Chromium parity leg uses the same mock so both browsers are driven identically.
 *
 * Behavior is selected per flow by the endpoint's query string (`?behavior=<id>`), so a flow
 * re-seeds storage.local with a new override URL to change the mock's mode. Every accepted
 * request is logged (GET /__mock/jev/calls, reset via POST /__mock/jev/reset) so the harness can
 * assert request counts.
 *
 * Responses carry permissive CORS headers: the extension background holds no host permission for
 * localhost, so the browser applies CORS to these fetches.
 */

/** The mock reply for a successful score+choice exchange (the verified live response shape). */
const OK_BODY = JSON.stringify(VERIFIED_JEV_RESPONSE);

/** One logged mock call: behavior id + arrival time (no draft content — keep evidence lean). */
export interface MockJevCall {
  behavior: string;
  at: number;
}

const callLog: MockJevCall[] = [];
/** Requests served per behavior — the `slow-first` behaviors count with this. */
const servedByBehavior = new Map<string, number>();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function cors(response: ServerResponse, status: number, body: string, contentType = 'application/json'): void {
  response.writeHead(status, {
    'content-type': contentType,
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'cache-control': 'no-store',
  });
  response.end(body);
}

/**
 * Behavior registry. `delayMs` pauses before responding (pending-state sampling); `status` and
 * `body` override the 200/verified exchange (failure states); `slowFirstDelayMs` delays only the
 * FIRST request per (fresh) behavior id — the stale-response flow needs response A to still be in
 * flight when draft B's exchange completes.
 */
const BEHAVIORS: Record<string, { delayMs?: number; status?: number; body?: string; slowFirstDelayMs?: number }> = {
  ok: {},
  'ok-slow-1200': { delayMs: 1200 },
  'http-500': { status: 500, body: JSON.stringify({ error: 'mock server failure' }) },
  'slow-first-3000': { slowFirstDelayMs: 3000 },
};

export async function handleMockJevRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  // Control endpoints (same-origin from the fixture page, so no CORS needed).
  if (url.pathname === '/__mock/jev/calls' && request.method === 'GET') {
    cors(response, 200, JSON.stringify(callLog));
    return;
  }
  if (url.pathname === '/__mock/jev/reset' && request.method === 'POST') {
    callLog.length = 0;
    servedByBehavior.clear();
    cors(response, 204, '');
    return;
  }
  if (request.method === 'OPTIONS') {
    cors(response, 204, '');
    return;
  }
  if (request.method !== 'POST') {
    cors(response, 405, JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  const behaviorId = url.searchParams.get('behavior') ?? 'ok';
  const behavior = BEHAVIORS[behaviorId];
  if (behavior === undefined) {
    cors(response, 400, JSON.stringify({ error: `unknown behavior: ${behaviorId}` }));
    return;
  }

  callLog.push({ behavior: behaviorId, at: Date.now() });
  const served = (servedByBehavior.get(behaviorId) ?? 0) + 1;
  servedByBehavior.set(behaviorId, served);

  const delay = behavior.slowFirstDelayMs !== undefined && served === 1 ? behavior.slowFirstDelayMs : (behavior.delayMs ?? 0);
  if (delay > 0) await sleep(delay);

  cors(response, behavior.status ?? 200, behavior.body ?? OK_BODY);
}
