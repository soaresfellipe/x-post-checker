export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL_ALIAS = 'jev-latest';
export const CONNECTION_TEST_TIMEOUT_MS = 15_000;

export type ConnectionTestResult =
  | { status: 'ok'; model: string; latencyMs: number }
  | { status: 'invalid-key'; httpStatus?: number }
  | { status: 'network'; reason: 'unreachable' | 'timeout' }
  | { status: 'error'; httpStatus: number }
  | { status: 'no-key' };

export interface ConnectionTestDeps {
  apiKey: string | undefined;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  timeoutMs?: number;
}

const CONNECTION_TEST_BODY = {
  model: JEV_MODEL_ALIAS,
  state: 'Connection check: "Ship small, learn fast."',
  questions: {
    connection_check: {
      type: 'score',
      instructions: 'Rate how clear this short sentence is.',
      criteria: ['Unclear', 'Somewhat clear', 'Clear'],
    },
  },
};

// Header values must be visible ASCII; anything else makes fetch throw before any request is made.
const SENDABLE_KEY = /^[\x21-\x7E]+$/;

/**
 * One tiny real Jev call that classifies the outcome for the Options page. Results never carry the key.
 * Latency is measured around the fetch call only (request sent -> response headers received).
 */
export async function runConnectionTest(deps: ConnectionTestDeps): Promise<ConnectionTestResult> {
  const apiKey = deps.apiKey?.trim();
  if (!apiKey) return { status: 'no-key' };
  if (!SENDABLE_KEY.test(apiKey)) return { status: 'invalid-key' };

  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? (() => performance.now());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? CONNECTION_TEST_TIMEOUT_MS);

  let response: Response;
  const startedAt = now();
  try {
    response = await fetchImpl(JEV_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(CONNECTION_TEST_BODY),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return { status: 'network', reason: aborted ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Math.max(0, Math.round(now() - startedAt));

  if (response.status === 401 || response.status === 403) {
    return { status: 'invalid-key', httpStatus: response.status };
  }
  if (!response.ok) return { status: 'error', httpStatus: response.status };

  try {
    const body = (await response.json()) as { model?: unknown };
    if (typeof body.model === 'string' && body.model.length > 0) {
      return { status: 'ok', model: body.model, latencyMs };
    }
  } catch {
    // Fall through: an unreadable body is an unexpected response, not a success.
  }
  return { status: 'error', httpStatus: response.status };
}
