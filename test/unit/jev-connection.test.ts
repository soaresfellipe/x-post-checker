import { describe, expect, it, vi } from 'vitest';
import { JEV_ENDPOINT, runConnectionTest } from '@/core/jev-client';

const KEY = 'test-key-abc123';

function okResponse(model = 'jev-1.13.0') {
  return new Response(
    JSON.stringify({
      model,
      answers: { connection_check: { type: 'score', score: 3.2, confidence: 0.6, legend: {}, probabilities: {} } },
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function clock(...ticks: number[]) {
  const queue = [...ticks];
  return () => queue.shift() ?? 0;
}

describe('runConnectionTest', () => {
  it('posts a tiny score question with the Bearer key and reports model and measured latency', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => okResponse());
    const result = await runConnectionTest({ apiKey: KEY, fetchImpl, now: clock(1000, 1237.6) });

    expect(result).toEqual({ status: 'ok', model: 'jev-1.13.0', latencyMs: 238 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(JEV_ENDPOINT);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('jev-latest');
    expect(Object.values(body.questions)).toHaveLength(1);
    expect((Object.values(body.questions)[0] as { type: string }).type).toBe('score');
  });

  it('never returns a negative latency', async () => {
    const result = await runConnectionTest({ apiKey: KEY, fetchImpl: async () => okResponse(), now: clock(500, 400) });
    expect(result).toMatchObject({ status: 'ok', latencyMs: 0 });
  });

  it.each([401, 403])('maps HTTP %i to invalid-key', async (status) => {
    const result = await runConnectionTest({
      apiKey: KEY,
      fetchImpl: async () => new Response('{"error":"unauthorized"}', { status }),
    });
    expect(result).toEqual({ status: 'invalid-key', httpStatus: status });
  });

  it('maps a thrown fetch to a network failure, distinct from invalid-key', async () => {
    const result = await runConnectionTest({
      apiKey: KEY,
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(result).toEqual({ status: 'network', reason: 'unreachable' });
  });

  it('reports a timeout as a network failure', async () => {
    const fetchImpl = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const result = await runConnectionTest({ apiKey: KEY, fetchImpl, timeoutMs: 20 });
    expect(result).toEqual({ status: 'network', reason: 'timeout' });
  });

  // Regression (VAL-SETUP-006): the timeout must span the FULL response. Headers arriving is not
  // success — a 200 whose body never completes previously cleared the deadline and left the
  // Options page pending forever with a disabled button.
  it('times out when the server sends headers but never a response body', async () => {
    const fetchImpl = (_url: string, init: RequestInit): Promise<Response> =>
      new Promise<Response>((resolve) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            // Mirror real fetch: aborting the signal errors the still-open body stream.
            init.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('The operation was aborted.', 'AbortError')),
            );
          },
        });
        resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
      });

    const result = await runConnectionTest({ apiKey: KEY, fetchImpl, timeoutMs: 25 });
    expect(result).toEqual({ status: 'network', reason: 'timeout' });
  });

  it('reports server errors and rate limits as a distinct service error', async () => {
    const result = await runConnectionTest({ apiKey: KEY, fetchImpl: async () => new Response('x', { status: 503 }) });
    expect(result).toEqual({ status: 'error', httpStatus: 503 });
  });

  it('reports a 200 without a model id as an unexpected response, not success', async () => {
    const result = await runConnectionTest({
      apiKey: KEY,
      fetchImpl: async () => new Response('{"answers":{}}', { status: 200 }),
    });
    expect(result).toEqual({ status: 'error', httpStatus: 200 });
  });

  it('treats a key that cannot be sent as a header as invalid without calling the network', async () => {
    const fetchImpl = vi.fn();
    const result = await runConnectionTest({ apiKey: 'bad key\nwith newline', fetchImpl });
    expect(result.status).toBe('invalid-key');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports no-key when none is available', async () => {
    const fetchImpl = vi.fn();
    expect(await runConnectionTest({ apiKey: '  ', fetchImpl })).toEqual({ status: 'no-key' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never includes the key in any result', async () => {
    const results = await Promise.all([
      runConnectionTest({ apiKey: KEY, fetchImpl: async () => okResponse() }),
      runConnectionTest({ apiKey: KEY, fetchImpl: async () => new Response('', { status: 401 }) }),
      runConnectionTest({
        apiKey: KEY,
        fetchImpl: async () => {
          throw new TypeError(`boom ${KEY}`);
        },
      }),
    ]);
    expect(JSON.stringify(results)).not.toContain(KEY);
  });
});
