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
import type { PostSnapshot } from '@/core/post-snapshot';
import type { JevVerdict } from '@/core/heuristic-engine';
import {
  JEV_ANALYSIS_TIMEOUT_MS,
  JEV_RATE_LIMIT,
  JEV_RETRY,
  JEV_RETRYABLE_HTTP_STATUSES,
  ANGLE_LABELS,
  type MainWeaknessId,
  type TargetReplyAngle,
} from './config';
import {
  createMemoryVerdictCache,
  createMemoryTargetVerdictCache,
  createMemoryOptimizerCache,
  type JevVerdictCache,
  type TargetCachedVerdict,
  type TargetVerdictCache,
  type OptimizerCachedEntry,
  type OptimizerVerdictCache,
  type VerdictCacheArea,
} from './cache';
import { draftCacheKey, targetCacheKey, optimizerCacheKey } from './hash';
import { buildDraftAnalysisRequest, buildTargetAnalysisRequest } from './request';
import {
  buildDraftJevVerdict,
  buildTargetAngle,
  buildTargetJevVerdict,
  parseDraftAnalysisResponse,
  parseTargetAnalysisResponse,
} from './response';
import { createMemoryRateLimiter, createPersistentRateLimiter, type RateLimiter } from './rate-window';
import { postJevJson } from './transport';
import { buildOptimizerPipeline } from '@/core/optimizer/request';
import { parseOptimizeResponse, type RankedHashtag, type RankedVariant } from '@/core/optimizer/response';

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

/** One target deep-analysis request: the post snapshot plus the caller-read key. */
export interface JevTargetAnalyzeRequest {
  readonly apiKey: string | undefined;
  readonly post: PostSnapshot;
}

/** What a target deep analysis produced: verdict + suggested angle, fresh or cached. */
export interface JevTargetAnalysisSuccess {
  readonly verdict: JevVerdict;
  readonly angle?: TargetReplyAngle;
  /** `fresh` = a real exchange just completed; `cache` = this post's stored verdict was reused. */
  readonly source: 'fresh' | 'cache';
  /** Measured full-exchange latency, fresh results only. */
  readonly latencyMs?: number;
}

export type JevTargetAnalysisResult =
  | ({ ok: true } & JevTargetAnalysisSuccess)
  | { ok: false; failure: JevAnalysisFailure };

/** One draft-optimization request: the draft plus the caller-read key (m4-optimizer). */
export interface JevOptimizeRequest {
  readonly apiKey: string | undefined;
  readonly draft: DraftSnapshot;
}

/** What one draft optimization produced: ranked rewrites + ranked hashtag candidates. */
export interface JevOptimizeSuccess {
  /** Ranked best-first (noul probability desc, generation order on ties). */
  readonly variants: readonly RankedVariant[];
  /** Ranked best-first. */
  readonly hashtags: readonly RankedHashtag[];
  /** `fresh` = a real exchange just completed; `cache` = this draft's stored result was reused. */
  readonly source: 'fresh' | 'cache';
  /** Measured full-exchange latency, fresh results only. */
  readonly latencyMs?: number;
}

export type JevOptimizeResult =
  | ({ ok: true } & JevOptimizeSuccess)
  | { ok: false; failure: JevAnalysisFailure };

/** Injectable retry / rate-limit policy overrides (tests inject deterministic clocks). */
export interface JevClientDeps {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  cache?: JevVerdictCache;
  /** The per-post verdict cache for deep analysis (defaults to in-memory; storage in background). */
  targetCache?: TargetVerdictCache;
  /** The per-draft optimization cache (defaults to in-memory; storage in background). */
  optimizerCache?: OptimizerVerdictCache;
  timeoutMs?: number;
  retry?: { maxRetries?: number; backoffMs?: readonly number[] };
  rateLimit?: { maxRequests?: number; windowMs?: number };
  /**
   * Storage area persisting the rate window (`storage.local` in the background). The window state
   * must survive MV3 service-worker suspension: a restarted worker rehydrates the send count
   * instead of starting from zero, so the configured maximum is never exceeded. When omitted, the
   * window is in-memory only (tests, single-session clients).
   */
  rateWindowArea?: VerdictCacheArea;
}

export interface JevClient {
  analyzeDraft(request: JevAnalyzeRequest): Promise<JevDraftAnalysisResult>;
  /** The popover's on-demand "Deep analysis" path: one exchange per post, cached by post id. */
  analyzeTarget(request: JevTargetAnalyzeRequest): Promise<JevTargetAnalysisResult>;
  /**
   * The draft overlay's on-demand "Optimize" path: one noul exchange per draft, cached by the
   * draft's optimizer identity so repeated clicks on an unchanged draft cost zero API calls
   * (VAL-OPT-009). The optimizer service derives the presentation facts on top of this.
   */
  optimizeDraft(request: JevOptimizeRequest): Promise<JevOptimizeResult>;
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
  const targetCache = deps.targetCache ?? createMemoryTargetVerdictCache();
  const optimizerCache = deps.optimizerCache ?? createMemoryOptimizerCache();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = deps.timeoutMs ?? JEV_ANALYSIS_TIMEOUT_MS;
  const maxRetries = deps.retry?.maxRetries ?? JEV_RETRY.maxRetries;
  const backoffMs = deps.retry?.backoffMs ?? JEV_RETRY.backoffMs;
  const maxRequests = deps.rateLimit?.maxRequests ?? JEV_RATE_LIMIT.maxRequests;
  const windowMs = deps.rateLimit?.windowMs ?? JEV_RATE_LIMIT.windowMs;
  // The hard ceiling must survive MV3 service-worker suspension: with a storage area, the window
  // state persists (write-serialized) and a restarted background rehydrates it at client
  // creation, so no restart can admit a request beyond the configured maximum.
  const limiter: RateLimiter = deps.rateWindowArea
    ? createPersistentRateLimiter(deps.rateWindowArea, maxRequests, windowMs, now)
    : createMemoryRateLimiter(maxRequests, windowMs, now);
  // One in-flight promise per unique request identity (draft hash / target post id / optimizer
  // draft): bursts coalesce here, and the entry is removed as soon as the promise settles so a
  // follow-up analysis starts a fresh exchange.
  const inFlight = new Map<string, Promise<JevDraftAnalysisResult | JevTargetAnalysisResult | JevOptimizeResult>>();

  /**
   * The shared transport+retry pipeline. `parse` turns a 200 body into either the caller's
   * success value plus its cache entry, or a parse failure (never retried: the API answered,
   * wrongly). Every transport attempt counts against the rate window.
   */
  async function exchangeWithRetry<S>(
    apiKey: string,
    pipeline: {
      body: unknown;
      cacheKey: string;
      cacheSet: (key: string, entry: never) => Promise<void>;
      parse: (data: unknown) => { ok: true; cacheEntry: unknown; success: S } | { ok: false };
    },
  ): Promise<{ ok: true; success: S; latencyMs: number } | { ok: false; failure: JevAnalysisFailure }> {
    let lastFailure: JevAnalysisFailure | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) await sleep(delayFor(backoffMs, attempt - 1));
      // Every transport attempt counts against the window: a retry is a real API call.
      if (!(await limiter.tryAcquire())) return { ok: false, failure: { kind: 'rate-limited' } };

      const result = await postJevJson({ apiKey, body: pipeline.body, timeoutMs, fetchImpl: deps.fetchImpl, now });
      if (result.ok) {
        const parsed = pipeline.parse(result.data);
        if (!parsed.ok) return { ok: false, failure: { kind: 'malformed' } }; // no retry: the API answered, wrongly
        // A failed cache write never fails the analysis: the verdict is already in hand.
        await pipeline.cacheSet(pipeline.cacheKey, parsed.cacheEntry as never).catch(() => undefined);
        return { ok: true, success: parsed.success, latencyMs: result.latencyMs };
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
      if (existing) return existing as Promise<JevDraftAnalysisResult>; // coalesced: this caller shares the ONE in-flight request

      const promise = exchangeWithRetry<JevDraftAnalysisResult & { ok: true }>(key, {
        body: buildDraftAnalysisRequest(draft),
        cacheKey,
        cacheSet: (key: string, entry: never) => cache.set(key, entry as Parameters<JevVerdictCache['set']>[1]),
        parse: (data) => {
          const parsed = parseDraftAnalysisResponse(data);
          if (!parsed.ok) return { ok: false };
          const mainWeakness = parsed.answers.mainWeakness.choice;
          const entry = { verdict: buildDraftJevVerdict(parsed.answers), mainWeakness, at: now() };
          return {
            ok: true,
            cacheEntry: entry,
            success: { ok: true, verdict: entry.verdict, mainWeakness, source: 'fresh' } as JevDraftAnalysisResult & { ok: true },
          };
        },
      })
        .then((result) =>
          result.ok
            ? ({ ...result.success, latencyMs: result.latencyMs } as JevDraftAnalysisResult)
            : { ok: false, failure: result.failure },
        )
        .finally(() => {
          if (inFlight.get(cacheKey) === promise) inFlight.delete(cacheKey);
        }) as Promise<JevDraftAnalysisResult>;
      inFlight.set(cacheKey, promise);
      return promise;
    },

    async analyzeTarget({ apiKey, post }) {
      const key = apiKey?.trim();
      if (!key) return { ok: false, failure: { kind: 'no-key' } };

      // VAL-TARGET-020: the cache identity is the POST — closing and reopening this post's
      // popover reuses its stored verdict without another request; another post pays its own.
      const cacheKey = targetCacheKey(post.id);
      const cached = await targetCache.get(cacheKey);
      if (cached) {
        return {
          ok: true,
          verdict: cached.verdict,
          ...(cached.angle === undefined
            ? {}
            : { angle: { choice: cached.angle.choice, label: ANGLE_LABELS[cached.angle.choice], confidence: cached.angle.confidence } }),
          source: 'cache',
        };
      }

      const existing = inFlight.get(cacheKey);
      if (existing) return existing as Promise<JevTargetAnalysisResult>;

      const promise = exchangeWithRetry<JevTargetAnalysisResult & { ok: true }>(key, {
        body: buildTargetAnalysisRequest(post),
        cacheKey,
        cacheSet: (key: string, entry: never) => targetCache.set(key, entry as Parameters<TargetVerdictCache['set']>[1]),
        parse: (data) => {
          const parsed = parseTargetAnalysisResponse(data);
          if (!parsed.ok) return { ok: false };
          const verdict = buildTargetJevVerdict(parsed.answers);
          const angle = buildTargetAngle(parsed.answers);
          const entry: TargetCachedVerdict = {
            verdict,
            angle: { choice: angle.choice, confidence: angle.confidence },
            at: now(),
          };
          return {
            ok: true,
            cacheEntry: entry,
            success: { ok: true, verdict, angle, source: 'fresh' } as JevTargetAnalysisResult & { ok: true },
          };
        },
      })
        .then((result) =>
          result.ok
            ? ({ ...result.success, latencyMs: result.latencyMs } as JevTargetAnalysisResult)
            : { ok: false, failure: result.failure },
        )
        .finally(() => {
          if (inFlight.get(cacheKey) === promise) inFlight.delete(cacheKey);
        }) as Promise<JevTargetAnalysisResult>;
      inFlight.set(cacheKey, promise);
      return promise;
    },

    async optimizeDraft({ apiKey, draft }) {
      const key = apiKey?.trim();
      if (!key) return { ok: false, failure: { kind: 'no-key' } };

      // VAL-OPT-009: the cache identity is the DRAFT (under the optimizer rubric version) —
      // repeated Optimize on an unchanged draft reuses this result with zero further API calls.
      const cacheKey = optimizerCacheKey(draft);
      const cached = await optimizerCache.get(cacheKey);
      if (cached) {
        return { ok: true, variants: cached.variants, hashtags: cached.hashtags, source: 'cache' };
      }

      const existing = inFlight.get(cacheKey);
      if (existing) return existing as Promise<JevOptimizeResult>;

      // The variants and hashtag candidates are deterministic pure functions of the draft, so
      // the pipeline (and with it every question id the parser matches on) is identical for
      // identical drafts.
      const pipeline = buildOptimizerPipeline(draft);
      const promise = exchangeWithRetry<JevOptimizeResult & { ok: true }>(key, {
        body: pipeline.request,
        cacheKey,
        cacheSet: (key: string, entry: never) =>
          optimizerCache.set(key, entry as Parameters<OptimizerVerdictCache['set']>[1]),
        parse: (data) => {
          const parsed = parseOptimizeResponse(data, pipeline);
          if (!parsed.ok) return { ok: false };
          const entry: OptimizerCachedEntry = {
            variants: parsed.variants,
            hashtags: parsed.hashtags,
            at: now(),
          };
          return {
            ok: true,
            cacheEntry: entry,
            success: {
              ok: true,
              variants: parsed.variants,
              hashtags: parsed.hashtags,
              source: 'fresh',
            } as JevOptimizeResult & { ok: true },
          };
        },
      })
        .then((result) =>
          result.ok
            ? ({ ...result.success, latencyMs: result.latencyMs } as JevOptimizeResult)
            : { ok: false, failure: result.failure },
        )
        .finally(() => {
          if (inFlight.get(cacheKey) === promise) inFlight.delete(cacheKey);
        }) as Promise<JevOptimizeResult>;
      inFlight.set(cacheKey, promise);
      return promise;
    },
  };
}
