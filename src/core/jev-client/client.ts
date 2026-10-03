/**
 * JevClient: the stateful draft-analysis client on top of the shared transport. Responsibilities
 * per architecture.md — cache (by draft hash), single in-flight request per unique draft (burst
 * coalescing), retry of transient failures (502/503/504 + network) with capped attempts, a
 * rate-limit guard that never exceeds the configured requests-per-window, and TYPED failure
 * results for every other mode (no key, network, non-200, malformed). It never throws and never
 * exposes the API key in any result.
 *
 * The transport (./transport) is reused unchanged: its abort deadline covers the FULL response
 * (request -> headers -> body), which this client inherits for every attempt.
 */
import type { DraftSnapshot } from '@/core/draft-snapshot';
import type { JevVerdict } from '@/core/heuristic-engine';
import {
  JEV_ANALYSIS_TIMEOUT_MS,
  JEV_RATE_LIMIT,
  JEV_RETRY,
  JEV_RETRYABLE_HTTP_STATUSES,
  type MainWeaknessId,
} from './config';
import { createMemoryVerdictCache, type JevVerdictCache } from './cache';
import { draftCacheKey } from './hash';
import { buildDraftAnalysisRequest } from './request';
import { buildDraftJevVerdict, parseDraftAnalysisResponse } from './response';
import { postJevJson } from './transport';

/** Every way a draft analysis can fail, typed so upstream can degrade locally without try/catch. */
export type JevAnalysisFailure =
  | { kind: 'no-key' }
  | { kind: 'network'; reason: 'unreachable' | 'timeout' }
  | { kind: 'http-error'; status: number }
  | { kind: 'malformed' }
  | { kind: 'rate-limited' };

export interface JevDraftAnalysisSuccess {
  readonly verdict: JevVerdict;
  readonly mainWeakness: MainWeaknessId;
  /** `fresh` = a real exchange just completed; `cache` = an identical draft's verdict was reused. */
  readonly source: 'fresh' | 'cache';
  /** Measured full-exchange latency, fresh results only. */
  readonly latencyMs?: number;
}

export type JevDraftAnalysisResult =
  | ({ ok: true } & JevDraftAnalysisSuccess)
  | { ok: false; failure: JevAnalysisFailure };

export interface JevAnalyzeRequest {
  /** The Jev key, read from the settings store by the caller; the client never stores it. */
  readonly apiKey: string | undefined;
  readonly draft: DraftSnapshot;
}

/** Injectable retry / rate-limit policy overrides (tests inject deterministic clocks). */
export interface JevClientDeps {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  cache?: JevVerdictCache;
  timeoutMs?: number;
  retry?: { maxRetries?: number; backoffMs?: readonly number[] };
  rateLimit?: { maxRequests?: number; windowMs?: number };
}

export interface JevClient {
  analyzeDraft(request: JevAnalyzeRequest): Promise<JevDraftAnalysisResult>;
}

/** Sliding-window limiter: at most `maxRequests` sends in any `windowMs` slice of time. */
class SlidingWindowLimiter {
  private sends: number[] = [];

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  /** Records a send when capacity remains; false means the window is full (typed failure, no wait). */
  tryAcquire(): boolean {
    const at = this.now();
    this.sends = this.sends.filter((sentAt) => at - sentAt < this.windowMs);
    if (this.sends.length >= this.maxRequests) return false;
    this.sends.push(at);
    return true;
  }
}

function delayFor(backoffMs: readonly number[], retryIndex: number): number {
  if (backoffMs.length === 0) return 0;
  return backoffMs[Math.min(retryIndex, backoffMs.length - 1)]!;
}

/**
 * Translates a transport failure into the client's typed failure and marks whether the failure is
 * transient (worth a retry) per the policy: 502/503/504 and network-level errors are transient;
 * definitive statuses, malformed replies and rate-limit denials are final.
 */
function translateTransportFailure(
  failure: { kind: 'timeout' } | { kind: 'unreachable' } | { kind: 'unexpected-response'; status: number },
): { failure: JevAnalysisFailure; transient: boolean } {
  if (failure.kind === 'timeout') return { failure: { kind: 'network', reason: 'timeout' }, transient: true };
  if (failure.kind === 'unreachable') return { failure: { kind: 'network', reason: 'unreachable' }, transient: true };
  if (failure.status === 200) return { failure: { kind: 'malformed' }, transient: false };
  return {
    failure: { kind: 'http-error', status: failure.status },
    transient: JEV_RETRYABLE_HTTP_STATUSES.includes(failure.status),
  };
}

export function createJevClient(deps: JevClientDeps = {}): JevClient {
  const cache = deps.cache ?? createMemoryVerdictCache();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = deps.timeoutMs ?? JEV_ANALYSIS_TIMEOUT_MS;
  const maxRetries = deps.retry?.maxRetries ?? JEV_RETRY.maxRetries;
  const backoffMs = deps.retry?.backoffMs ?? JEV_RETRY.backoffMs;
  const limiter = new SlidingWindowLimiter(
    deps.rateLimit?.maxRequests ?? JEV_RATE_LIMIT.maxRequests,
    deps.rateLimit?.windowMs ?? JEV_RATE_LIMIT.windowMs,
    now,
  );
  // One in-flight promise per unique draft: bursts coalesce here, and the entry is removed as soon
  // as the promise settles so a follow-up analysis starts a fresh exchange.
  const inFlight = new Map<string, Promise<JevDraftAnalysisResult>>();

  async function sendWithRetry(apiKey: string, draft: DraftSnapshot, cacheKey: string): Promise<JevDraftAnalysisResult> {
    const body = buildDraftAnalysisRequest(draft);
    let lastFailure: JevAnalysisFailure | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) await sleep(delayFor(backoffMs, attempt - 1));
      // Every transport attempt counts against the window: a retry is a real API call.
      if (!limiter.tryAcquire()) return { ok: false, failure: { kind: 'rate-limited' } };

      const result = await postJevJson({ apiKey, body, timeoutMs, fetchImpl: deps.fetchImpl, now });
      if (result.ok) {
        const parsed = parseDraftAnalysisResponse(result.data);
        if (!parsed.ok) return { ok: false, failure: { kind: 'malformed' } }; // no retry: the API answered, wrongly
        const mainWeakness = parsed.answers.mainWeakness.choice;
        const entry = { verdict: buildDraftJevVerdict(parsed.answers), mainWeakness, at: now() };
        // A failed cache write never fails the analysis: the verdict is already in hand.
        await cache.set(cacheKey, entry).catch(() => undefined);
        return { ok: true, verdict: entry.verdict, mainWeakness, source: 'fresh', latencyMs: result.latencyMs };
      }

      const translated = translateTransportFailure(result.failure);
      lastFailure = translated.failure;
      if (!translated.transient) return { ok: false, failure: translated.failure };
    }
    return { ok: false, failure: lastFailure ?? { kind: 'network', reason: 'unreachable' } };
  }

  return {
    async analyzeDraft({ apiKey, draft }) {
      const key = apiKey?.trim();
      if (!key) return { ok: false, failure: { kind: 'no-key' } };

      const cacheKey = draftCacheKey(draft);
      const cached = await cache.get(cacheKey);
      if (cached) {
        return { ok: true, verdict: cached.verdict, mainWeakness: cached.mainWeakness, source: 'cache' };
      }

      const existing = inFlight.get(cacheKey);
      if (existing) return existing; // coalesced: this caller shares the ONE in-flight request

      const promise = sendWithRetry(key, draft, cacheKey).finally(() => {
        if (inFlight.get(cacheKey) === promise) inFlight.delete(cacheKey);
      });
      inFlight.set(cacheKey, promise);
      return promise;
    },
  };
}
