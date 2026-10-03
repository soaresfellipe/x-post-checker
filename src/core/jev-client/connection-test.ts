import { JEV_ENDPOINT, postJevJson } from './transport';

export { JEV_ENDPOINT };
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
 * Latency is measured across the full exchange (request sent -> parsed reply) by the shared transport,
 * whose abort deadline covers the whole response: headers AND body read.
 */
export async function runConnectionTest(deps: ConnectionTestDeps): Promise<ConnectionTestResult> {
  const apiKey = deps.apiKey?.trim();
  if (!apiKey) return { status: 'no-key' };
  if (!SENDABLE_KEY.test(apiKey)) return { status: 'invalid-key' };

  const result = await postJevJson<{ model?: unknown }>({
    apiKey,
    body: CONNECTION_TEST_BODY,
    timeoutMs: deps.timeoutMs ?? CONNECTION_TEST_TIMEOUT_MS,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
  });

  if (!result.ok) {
    switch (result.failure.kind) {
      case 'timeout':
        return { status: 'network', reason: 'timeout' };
      case 'unreachable':
        return { status: 'network', reason: 'unreachable' };
      case 'unexpected-response':
        return result.failure.status === 401 || result.failure.status === 403
          ? { status: 'invalid-key', httpStatus: result.failure.status }
          : { status: 'error', httpStatus: result.failure.status };
    }
  }

  const { model } = result.data;
  if (typeof model === 'string' && model.length > 0) {
    return { status: 'ok', model, latencyMs: result.latencyMs };
  }
  return { status: 'error', httpStatus: 200 };
}
