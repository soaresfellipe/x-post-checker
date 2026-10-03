/**
 * The one shared Jev POST helper. Every Jev caller (connection test today, the M2 JevClient later)
 * goes through here so the abort deadline provably covers the FULL response: request sent ->
 * headers received -> body fully read. Clearing the deadline after the headers would let a stalled
 * body (200 sent, body never delivered) hang the caller forever.
 */

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** Why a Jev exchange did not produce parsed JSON. */
export type JevTransportFailure =
  | { kind: 'timeout' }
  | { kind: 'unreachable'; cause: unknown }
  | { kind: 'unexpected-response'; status: number };

export type JevPostResult<T> =
  | { ok: true; data: T; latencyMs: number }
  | { ok: false; failure: JevTransportFailure };

export interface PostJevJsonDeps {
  apiKey: string;
  body: unknown;
  /** Abort deadline for the whole exchange, in milliseconds. */
  timeoutMs: number;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
}

/** POSTs `body` to Jev and parses the JSON reply under a single deadline spanning headers AND body. */
export async function postJevJson<T = unknown>(deps: PostJevJsonDeps): Promise<JevPostResult<T>> {
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? (() => performance.now());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  const startedAt = now();

  let response: Response | undefined;
  try {
    response = await fetchImpl(JEV_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(deps.body),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, failure: { kind: 'unexpected-response', status: response.status } };

    // Reading the body under the same signal: an abort here rejects with AbortError, same as an
    // abort before the headers, so a stalled body surfaces as a timeout instead of a hang.
    const data = (await response.json()) as T;
    return { ok: true, data, latencyMs: Math.max(0, Math.round(now() - startedAt)) };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return { ok: false, failure: { kind: 'timeout' } };
    if (response === undefined) return { ok: false, failure: { kind: 'unreachable', cause: error } };
    // Headers arrived but the body could not be read as JSON: an unexpected response, not a hang.
    return { ok: false, failure: { kind: 'unexpected-response', status: response.status } };
  } finally {
    clearTimeout(timer);
  }
}
