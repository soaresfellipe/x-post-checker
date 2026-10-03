import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryVerdictCache,
  createJevClient,
  JEV_RATE_LIMIT,
  JEV_RETRY,
  RATE_WINDOW_STORAGE_KEY,
} from '@/core/jev-client';
import { JEV_ENDPOINT } from '@/core/jev-client/transport';
import { createMemoryBackend } from '../helpers/memory-backend';
import { makeDraft } from '../helpers/draft';
import { jevOkResponse } from '../helpers/jev-fixtures';

const KEY = 'test-key-abc123';

/** A 200 whose body stalls until the abort signal fires — the full-response timeout pattern. */
function stalledBodyResponse(_url: string, init: RequestInit): Promise<Response> {
  return new Promise<Response>((resolve) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal?.addEventListener('abort', () =>
          controller.error(new DOMException('The operation was aborted.', 'AbortError')),
        );
      },
    });
    resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
  });
}

function makeClient(overrides: Partial<Parameters<typeof createJevClient>[0]> = {}) {
  return createJevClient({ cache: createMemoryVerdictCache(), ...overrides });
}

describe('JevClient analyzeDraft (VAL-DRAFT-016 request shape)', () => {
  it('posts the rubric request to the verified endpoint under a Bearer key and returns a typed verdict', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jevOkResponse());
    const draft = makeDraft();
    const result = await makeClient({ fetchImpl }).analyzeDraft({ apiKey: KEY, draft });

    // Request shape (the transport owns the headers; the client owns the body):
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(JEV_ENDPOINT);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('jev-latest');
    expect((body.state as string).startsWith(draft.text)).toBe(true);
    expect(Object.keys(body.questions as object).sort()).toEqual(['main_weakness', 'viral_potential']);

    // Typed verdict:
    expect(result).toMatchObject({
      ok: true,
      source: 'fresh',
      mainWeakness: 'not_specific_enough',
      latencyMs: expect.any(Number),
    });
    if (!result.ok) throw new Error('unreachable');
    expect(result.verdict).toMatchObject({ ordinal: 3.44, confidence: 0.65, band: 'moderate' });
    expect(result.verdict.weaknesses).toHaveLength(1);
  });
});

describe('JevClient cache (VAL-DRAFT-015)', () => {
  it('serves the identical draft from cache with zero duplicate network calls', async () => {
    const fetchImpl = vi.fn(async () => jevOkResponse());
    const client = makeClient({ fetchImpl });
    const draft = makeDraft();

    const first = await client.analyzeDraft({ apiKey: KEY, draft });
    const second = await client.analyzeDraft({
      apiKey: KEY,
      draft: { ...draft, capturedAt: draft.capturedAt + 60_000 }, // retyped later, same content
    });

    expect(first).toMatchObject({ ok: true, source: 'fresh' });
    expect(second).toMatchObject({ ok: true, source: 'cache' });
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(second.verdict).toEqual(first.verdict);
    expect(second.mainWeakness).toBe(first.mainWeakness);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fetches again for a materially different draft', async () => {
    const fetchImpl = vi.fn(async () => jevOkResponse());
    const client = makeClient({ fetchImpl });
    await client.analyzeDraft({ apiKey: KEY, draft: makeDraft() });
    await client.analyzeDraft({ apiKey: KEY, draft: makeDraft({ isReply: true }) });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps working when the cache backend rejects writes', async () => {
    const brokenCache = {
      get: async () => undefined,
      set: async () => {
        throw new Error('QUOTA_BYTES quota exceeded');
      },
    };
    const client = createJevClient({ fetchImpl: vi.fn(async () => jevOkResponse()), cache: brokenCache });
    expect(await client.analyzeDraft({ apiKey: KEY, draft: makeDraft() })).toMatchObject({ ok: true });
  });
});

describe('JevClient in-flight coalescing (VAL-DRAFT-031)', () => {
  it('coalesces a burst of concurrent analyses of the same draft into one in-flight request', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const client = makeClient({ fetchImpl });
    const draft = makeDraft();

    const results = [
      client.analyzeDraft({ apiKey: KEY, draft }),
      client.analyzeDraft({ apiKey: KEY, draft }),
      client.analyzeDraft({ apiKey: KEY, draft }),
    ];
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    resolveFetch(jevOkResponse());
    const settled = await Promise.all(results);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (const result of settled) {
      expect(result).toMatchObject({ ok: true, source: 'fresh' });
    }
  });

  it('starts a separate request for a different draft while one is in flight', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const client = makeClient({ fetchImpl });
    const inFlight = client.analyzeDraft({ apiKey: KEY, draft: makeDraft() });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const other = client.analyzeDraft({ apiKey: KEY, draft: makeDraft({ isReply: true }) });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    for (const resolve of resolvers) resolve(jevOkResponse());
    expect(await inFlight).toMatchObject({ ok: true });
    expect(await other).toMatchObject({ ok: true });
  });
});

describe('JevClient retry policy (VAL-DRAFT-031)', () => {
  it('retries a transient 503 and succeeds with no user-visible error', async () => {
    const fetchImpl = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response('service unavailable', { status: 503 }))
      .mockResolvedValueOnce(jevOkResponse());
    const sleep = vi.fn(async () => undefined);
    const result = await makeClient({ fetchImpl, sleep }).analyzeDraft({ apiKey: KEY, draft: makeDraft() });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(JEV_RETRY.backoffMs[0]);
  });

  it('retries a transient network failure (unreachable) and succeeds', async () => {
    const fetchImpl = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jevOkResponse());
    const result = await makeClient({ fetchImpl, sleep: async () => undefined }).analyzeDraft({
      apiKey: KEY,
      draft: makeDraft(),
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a timeout (a stalled 200 body) and succeeds', async () => {
    const fetchImpl = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(stalledBodyResponse)
      .mockResolvedValueOnce(jevOkResponse());
    const result = await makeClient({
      fetchImpl,
      sleep: async () => undefined,
      timeoutMs: 20,
    }).analyzeDraft({ apiKey: KEY, draft: makeDraft() });
    expect(result).toMatchObject({ ok: true });
  });

  it('caps retries: an always-503 endpoint fails as a typed http-error after 1+maxRetries attempts', async () => {
    const fetchImpl = vi.fn(async () => new Response('service unavailable', { status: 503 }));
    const sleep = vi.fn(async () => undefined);
    const result = await makeClient({ fetchImpl, sleep }).analyzeDraft({ apiKey: KEY, draft: makeDraft() });

    expect(result).toEqual({ ok: false, failure: { kind: 'http-error', status: 503 } });
    expect(fetchImpl).toHaveBeenCalledTimes(1 + JEV_RETRY.maxRetries);
    expect(sleep).toHaveBeenCalledTimes(JEV_RETRY.maxRetries);
  });

  it('uses the configured backoff sequence between attempts', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response('service unavailable', { status: 503 }));
    const sleep = vi.fn(async (_ms: number) => undefined);
    await makeClient({ fetchImpl, sleep }).analyzeDraft({ apiKey: KEY, draft: makeDraft() });
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([...JEV_RETRY.backoffMs]);
  });

  it('does not retry a definitive non-200 (401) nor a malformed 200', async () => {
    const unauthorized = await makeClient({
      fetchImpl: vi.fn(async () => new Response('denied', { status: 401 })),
      sleep: vi.fn(async () => undefined),
    }).analyzeDraft({ apiKey: KEY, draft: makeDraft() });
    expect(unauthorized).toEqual({ ok: false, failure: { kind: 'http-error', status: 401 } });

    const malformed = await makeClient({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ model: 'jev-1.13.0' }), { status: 200 })),
      sleep: vi.fn(async () => undefined),
    }).analyzeDraft({ apiKey: KEY, draft: makeDraft() });
    expect(malformed).toEqual({ ok: false, failure: { kind: 'malformed' } });
  });

  it('maps a 200 whose body is not JSON at all to the malformed failure', async () => {
    const result = await makeClient({
      fetchImpl: vi.fn(async () => new Response('<html>totally not json</html>', { status: 200 })),
      sleep: vi.fn(async () => undefined),
    }).analyzeDraft({ apiKey: KEY, draft: makeDraft() });
    expect(result).toEqual({ ok: false, failure: { kind: 'malformed' } });
  });

  it('surfaces an all-timeout exchange as a typed network failure after the capped attempts', async () => {
    const fetchImpl = vi.fn(stalledBodyResponse);
    const result = await makeClient({ fetchImpl, sleep: async () => undefined, timeoutMs: 20 }).analyzeDraft({
      apiKey: KEY,
      draft: makeDraft(),
    });
    expect(result).toEqual({ ok: false, failure: { kind: 'network', reason: 'timeout' } });
    expect(fetchImpl).toHaveBeenCalledTimes(1 + JEV_RETRY.maxRetries);
  });
});

describe('JevClient rate-limit guard (VAL-DRAFT-031)', () => {
  it('never exceeds the configured requests-per-window; excess requests fail typed, not by waiting', async () => {
    const fetchImpl = vi.fn(async () => jevOkResponse());
    const now = vi.fn(() => 1_000);
    const client = makeClient({ fetchImpl, now, rateLimit: { maxRequests: 2, windowMs: 1_000 } });

    const first = await client.analyzeDraft({ apiKey: KEY, draft: makeDraft() });
    const second = await client.analyzeDraft({ apiKey: KEY, draft: makeDraft({ isReply: true }) });
    const third = await client.analyzeDraft({
      apiKey: KEY,
      draft: makeDraft({ isReply: true, replyToHandle: 'x' }),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third).toEqual({ ok: false, failure: { kind: 'rate-limited' } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // The window slides: after it passes, capacity returns.
    now.mockReturnValue(2_100);
    const fourth = await client.analyzeDraft({
      apiKey: KEY,
      draft: makeDraft({ isReply: true, replyToHandle: 'y' }),
    });
    expect(fourth.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('caps a concurrent burst of different drafts at the window limit', async () => {
    const fetchImpl = vi.fn(async () => jevOkResponse());
    const client = makeClient({ fetchImpl, rateLimit: { maxRequests: 2, windowMs: 60_000 } });
    const drafts = [
      makeDraft({ isReply: true, replyToHandle: 'a' }),
      makeDraft({ isReply: true, replyToHandle: 'b' }),
      makeDraft({ isReply: true, replyToHandle: 'c' }),
      makeDraft({ isReply: true, replyToHandle: 'd' }),
    ];
    const results = await Promise.all(drafts.map((draft) => client.analyzeDraft({ apiKey: KEY, draft })));

    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(results.filter((result) => !result.ok && result.failure.kind === 'rate-limited')) .toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('counts every transport attempt, including retries, against the window', async () => {
    const fetchImpl = vi.fn(async () => new Response('service unavailable', { status: 503 }));
    const client = makeClient({
      fetchImpl,
      sleep: async () => undefined,
      rateLimit: { maxRequests: 1, windowMs: 60_000 },
    });
    const result = await client.analyzeDraft({ apiKey: KEY, draft: makeDraft() });
    expect(result).toEqual({ ok: false, failure: { kind: 'rate-limited' } });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // the first attempt ran; the retry was denied
  });

  it('exposes the default window policy from the config module', () => {
    expect(JEV_RATE_LIMIT.maxRequests).toBeGreaterThan(0);
    expect(JEV_RATE_LIMIT.windowMs).toBeGreaterThan(0);
  });
});

describe('JevClient persistent rate window (survives service-worker restarts, VAL-DRAFT-031)', () => {
  it('rehydrates the window in a fresh client (simulated MV3 restart): the ceiling still holds', async () => {
    const memory = createMemoryBackend();
    const now = vi.fn(() => 1_000);
    const fetchOk = vi.fn(async () => jevOkResponse());
    const rateLimit = { maxRequests: 2, windowMs: 60_000 };

    const first = createJevClient({ fetchImpl: fetchOk, now, rateLimit, rateWindowArea: memory.backend.area });
    expect(await first.analyzeDraft({ apiKey: KEY, draft: makeDraft() })).toMatchObject({ ok: true });
    expect(await first.analyzeDraft({ apiKey: KEY, draft: makeDraft({ isReply: true }) })).toMatchObject({ ok: true });
    expect(
      await first.analyzeDraft({ apiKey: KEY, draft: makeDraft({ isReply: true, replyToHandle: 'x' }) }),
    ).toEqual({ ok: false, failure: { kind: 'rate-limited' } });

    // The worker is suspended and restarted: a NEW client instance over the SAME storage must
    // inherit the in-window send count instead of starting from zero.
    const restarted = createJevClient({ fetchImpl: fetchOk, now, rateLimit, rateWindowArea: memory.backend.area });
    const result = await restarted.analyzeDraft({
      apiKey: KEY,
      draft: makeDraft({ isReply: true, replyToHandle: 'y' }),
    });
    expect(result).toEqual({ ok: false, failure: { kind: 'rate-limited' } });
    expect(fetchOk).toHaveBeenCalledTimes(2); // no third POST crossed the restarted limiter

    // The window slides: once every persisted stamp leaves the window, capacity returns.
    now.mockReturnValue(1_000 + 60_000);
    expect(
      await restarted.analyzeDraft({ apiKey: KEY, draft: makeDraft({ isReply: true, replyToHandle: 'z' }) }),
    ).toMatchObject({ ok: true });
  });

  it('persists every transport attempt, retries included, across the restart', async () => {
    const memory = createMemoryBackend();
    const now = vi.fn(() => 1_000);
    const fetchImpl = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response('service unavailable', { status: 503 }))
      .mockResolvedValue(jevOkResponse());
    const rateLimit = { maxRequests: 2, windowMs: 60_000 };

    const first = createJevClient({
      fetchImpl,
      now,
      sleep: async () => undefined,
      rateLimit,
      rateWindowArea: memory.backend.area,
    });
    expect(await first.analyzeDraft({ apiKey: KEY, draft: makeDraft() })).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // the 503, then the retry's 200

    // Both attempts (the retry included) were persisted: the restarted client inherits the full
    // window, so the next draft fails rate-limited instead of sneaking in a 3rd real request.
    const restarted = createJevClient({ fetchImpl, now, rateLimit, rateWindowArea: memory.backend.area });
    expect(await restarted.analyzeDraft({ apiKey: KEY, draft: makeDraft({ isReply: true }) })).toEqual({
      ok: false,
      failure: { kind: 'rate-limited' },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('degrades to an empty window when the persisted state is unreadable, and still counts onward', async () => {
    const memory = createMemoryBackend();
    memory.data[RATE_WINDOW_STORAGE_KEY] = 'not-an-array';
    const now = vi.fn(() => 1_000);
    const fetchOk = vi.fn(async () => jevOkResponse());
    const client = createJevClient({
      fetchImpl: fetchOk,
      now,
      rateLimit: { maxRequests: 1, windowMs: 60_000 },
      rateWindowArea: memory.backend.area,
    });
    expect(await client.analyzeDraft({ apiKey: KEY, draft: makeDraft() })).toMatchObject({ ok: true });
    expect(await client.analyzeDraft({ apiKey: KEY, draft: makeDraft({ isReply: true }) })).toEqual({
      ok: false,
      failure: { kind: 'rate-limited' },
    });
  });
});

describe('JevClient typed failures (never throw into the UI)', () => {
  it('returns a typed no-key failure without any network activity', async () => {
    const fetchImpl = vi.fn(async () => jevOkResponse());
    const client = makeClient({ fetchImpl });
    expect(await client.analyzeDraft({ apiKey: undefined, draft: makeDraft() })).toEqual({
      ok: false,
      failure: { kind: 'no-key' },
    });
    expect(await client.analyzeDraft({ apiKey: '   ', draft: makeDraft() })).toEqual({
      ok: false,
      failure: { kind: 'no-key' },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never exposes the API key in any result, success or failure', async () => {
    const SECRET = 'secret-key-never-logged';
    const okClient = makeClient({ fetchImpl: vi.fn(async () => jevOkResponse()) });
    const okResult = await okClient.analyzeDraft({ apiKey: SECRET, draft: makeDraft() });
    expect(JSON.stringify(okResult)).not.toContain(SECRET);

    const failing = makeClient({ fetchImpl: vi.fn(async () => new Response('boom', { status: 500 })) });
    const failure = await failing.analyzeDraft({ apiKey: SECRET, draft: makeDraft() });
    expect(JSON.stringify(failure)).not.toContain(SECRET);
  });
});
