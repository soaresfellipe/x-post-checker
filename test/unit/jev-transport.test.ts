import { describe, expect, it, vi } from 'vitest';
import { JEV_ENDPOINT, postJevJson } from '@/core/jev-client';

const KEY = 'test-key-abc123';

function deps(overrides: Partial<Parameters<typeof postJevJson>[0]> = {}): Parameters<typeof postJevJson>[0] {
  return { apiKey: KEY, body: { ping: true }, timeoutMs: 25, ...overrides };
}

describe('postJevJson (shared Jev transport)', () => {
  it('posts JSON with the Bearer key and resolves the parsed body with full-response latency', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ model: 'jev-1.13.0' }), { status: 200 }),
    );
    let tick = 0;
    const now = () => [1000, 1237.6, 9999][tick++] ?? 0;

    const result = await postJevJson(deps({ fetchImpl, now }));

    expect(result).toEqual({ ok: true, data: { model: 'jev-1.13.0' }, latencyMs: 238 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(JEV_ENDPOINT);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body as string)).toEqual({ ping: true });
  });

  // The deadline must cover the FULL response: a 200 that stalls after the headers is a timeout,
  // never a hang. M2's JevClient inherits this helper, so the guarantee is pinned here.
  it('times out when headers arrive but the body never completes', async () => {
    const fetchImpl = (_url: string, init: RequestInit): Promise<Response> =>
      new Promise<Response>((resolve) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('The operation was aborted.', 'AbortError')),
            );
          },
        });
        resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
      });

    const result = await postJevJson(deps({ fetchImpl }));
    expect(result).toEqual({ ok: false, failure: { kind: 'timeout' } });
  });

  it('reports an unreachable network as a distinct failure from a timeout', async () => {
    const result = await postJevJson(deps({
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    }));
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ failure: { kind: 'unreachable' } });
  });

  it('reports non-2xx statuses without reading the body', async () => {
    const result = await postJevJson(deps({ fetchImpl: async () => new Response('x', { status: 503 }) }));
    expect(result).toEqual({ ok: false, failure: { kind: 'unexpected-response', status: 503 } });
  });

  it('reports an unparseable 200 body as an unexpected response carrying the status', async () => {
    const result = await postJevJson(deps({ fetchImpl: async () => new Response('not json', { status: 200 }) }));
    expect(result).toEqual({ ok: false, failure: { kind: 'unexpected-response', status: 200 } });
  });

  it('never leaves the abort timer running after the exchange settles', async () => {
    vi.useFakeTimers();
    try {
      const promise = postJevJson(deps({
        fetchImpl: async () => new Response('{"model":"jev-1.13.0"}', { status: 200 }),
      }));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await promise).toMatchObject({ ok: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
