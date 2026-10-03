import { describe, expect, it, vi } from 'vitest';
import { createJevClient } from '../../src/core/jev-client/client';
import {
  ANGLE_LABELS,
  REPLY_ANGLE_QUESTION_ID,
  REPLY_POTENTIAL_QUESTION_ID,
  TARGET_ANALYSIS_QUESTIONS,
  TARGET_RUBRIC_VERSION,
} from '../../src/core/jev-client/config';
import { targetCacheKey } from '../../src/core/jev-client/hash';
import { buildTargetAnalysisRequest, buildTargetAnalysisState } from '../../src/core/jev-client/request';
import { parseTargetAnalysisResponse } from '../../src/core/jev-client/response';
import { createMemoryTargetVerdictCache } from '../../src/core/jev-client/cache';
import { createTargetAnalysisService } from '../../src/core/target-analysis/service';
import type { PostSnapshot } from '../../src/core/post-snapshot';
import type { SettingsStore } from '../../src/core/settings-store';
import type { JevClient } from '../../src/core/jev-client/client';
import type { ReplyAngleId } from '../../src/core/jev-client/config';

/** A realistic snapshot mirroring fixture post 1 (question, verified, in-network, high counts). */
export function makePost(overrides: Partial<PostSnapshot> = {}): PostSnapshot {
  return {
    id: '1800000000000000001',
    text: 'What is the one tool you stopped using this year, and why?',
    authorHandle: 'ana_builds',
    verified: true,
    hasMedia: false,
    isReply: false,
    inNetwork: true,
    ageMinutes: 120,
    likeCount: 310,
    replyCount: 45,
    repostCount: 12,
    url: 'https://x.com/ana_builds/status/1800000000000000001',
    ...overrides,
  };
}

/** A Jev reply in the VERIFIED wire shape, with the target rubric's question ids. */
export function targetJevResponse(score = 4.2, choice = 'share_experience') {
  return {
    model: 'jev-1.13.0',
    answers: {
      [REPLY_POTENTIAL_QUESTION_ID]: {
        type: 'score',
        score,
        confidence: 0.7,
        legend: { '0': 'low', '5': 'high' },
        probabilities: { '4': 0.7 },
      },
      [REPLY_ANGLE_QUESTION_ID]: {
        type: 'choice',
        choice,
        confidence: 0.8,
        probabilities: { [choice]: 0.8 },
      },
    },
    usage: { input_tokens: 500, output_tokens: 60 },
  };
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('target rubric request mapping (VAL-TARGET-017)', () => {
  it('maps a PostSnapshot to the verified wire shape with the target rubric questions', () => {
    const request = buildTargetAnalysisRequest(makePost());
    expect(request.model).toBe('jev-latest');
    expect(Object.keys(request.questions).sort()).toEqual([REPLY_ANGLE_QUESTION_ID, REPLY_POTENTIAL_QUESTION_ID].sort());
    expect(request.questions[REPLY_POTENTIAL_QUESTION_ID]!.type).toBe('score');
    expect(request.questions[REPLY_ANGLE_QUESTION_ID]!.type).toBe('choice');
  });

  it('builds a deterministic state: same snapshot -> identical state; changed inputs -> different state', () => {
    const post = makePost();
    expect(buildTargetAnalysisState(post)).toBe(buildTargetAnalysisState(makePost()));
    expect(buildTargetAnalysisState(post)).toContain(post.text);
    expect(buildTargetAnalysisState(post)).toContain('@ana_builds');
    expect(buildTargetAnalysisState(post)).toContain('45');
    const other = buildTargetAnalysisState(makePost({ replyCount: 46 }));
    expect(other).not.toBe(buildTargetAnalysisState(post));
  });

  it('states the context facts the text cannot reveal (reply, network, verified, media)', () => {
    const state = buildTargetAnalysisState(makePost({ isReply: true, inNetwork: false, verified: false, hasMedia: true }));
    expect(state).toContain('reply');
    expect(state).not.toContain('follows this author');
    expect(state).not.toContain('verified');
    expect(state.toLowerCase()).toContain('image or video');
  });

  it('keys the cache by post id under the target rubric version, disjoint from draft keys', () => {
    expect(targetCacheKey('1800000000000000001')).toBe(`target:${TARGET_RUBRIC_VERSION}:1800000000000000001`);
    expect(targetCacheKey('1')).not.toBe(targetCacheKey('2'));
  });
});

describe('target response parsing (VAL-TARGET-017)', () => {
  it('parses the verified reply shape into a verdict and an angle', () => {
    const parsed = parseTargetAnalysisResponse(targetJevResponse());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.answers.replyPotential.ordinal).toBe(4.2);
    expect(parsed.answers.replyAngle.choice).toBe('share_experience');
  });

  it('rejects malformed replies as typed failures', () => {
    expect(parseTargetAnalysisResponse({}).ok).toBe(false);
    expect(parseTargetAnalysisResponse({ answers: {} }).ok).toBe(false);
    expect(parseTargetAnalysisResponse(targetJevResponse(9)).ok).toBe(false); // ordinal out of range
    expect(parseTargetAnalysisResponse(targetJevResponse(4, 'made_up_angle')).ok).toBe(false);
  });
});

describe('JevClient.analyzeTarget (VAL-TARGET-017/020: exactly one call, cached per post)', () => {
  function clientOver(responses: Response[], calls: { count: number }) {
    const queue = [...responses];
    const fetchImpl = vi.fn(() => {
      calls.count += 1;
      return Promise.resolve(queue.shift() ?? jsonResponse(targetJevResponse()));
    });
    return createJevClient({ fetchImpl, targetCache: createMemoryTargetVerdictCache() });
  }

  it('makes exactly one request per post on first Deep analysis and caches by post id', async () => {
    const calls = { count: 0 };
    const client = clientOver([jsonResponse(targetJevResponse())], calls);
    const post = makePost();

    const first = await client.analyzeTarget({ apiKey: 'k', post });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.source).toBe('fresh');
    expect(calls.count).toBe(1);

    const second = await client.analyzeTarget({ apiKey: 'k', post });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.source).toBe('cache');
    expect(calls.count).toBe(1); // cached across close/reopen: no second request
  });

  it('gives a different post its own first request', async () => {
    const calls = { count: 0 };
    const client = clientOver([jsonResponse(targetJevResponse(3)), jsonResponse(targetJevResponse(4))], calls);
    await client.analyzeTarget({ apiKey: 'k', post: makePost() });
    const other = await client.analyzeTarget({ apiKey: 'k', post: makePost({ id: '2' }) });
    expect(calls.count).toBe(2);
    expect(other.ok).toBe(true);
  });

  it('coalesces concurrent activations for the same post into one request', async () => {
    const calls = { count: 0 };
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          calls.count += 1;
          setTimeout(() => resolve(jsonResponse(targetJevResponse())), 5);
        }),
    );
    const client = createJevClient({ fetchImpl, targetCache: createMemoryTargetVerdictCache() });
    const [a, b] = await Promise.all([
      client.analyzeTarget({ apiKey: 'k', post: makePost() }),
      client.analyzeTarget({ apiKey: 'k', post: makePost() }),
    ]);
    expect(calls.count).toBe(1);
    expect(a.ok && b.ok).toBe(true);
  });

  it('fails typed without retrying a definitive 500, and does not cache failures', async () => {
    const calls = { count: 0 };
    const client = clientOver([jsonResponse({ error: 'x' }, 500), jsonResponse(targetJevResponse())], calls);
    const failed = await client.analyzeTarget({ apiKey: 'k', post: makePost() });
    expect(failed).toEqual({ ok: false, failure: { kind: 'http-error', status: 500 } });
    expect(calls.count).toBe(1);

    const retried = await client.analyzeTarget({ apiKey: 'k', post: makePost() });
    expect(retried.ok).toBe(true); // failure was not cached: the retry is a fresh exchange
    expect(calls.count).toBe(2);
  });

  it('keeps draft and target caches independent', async () => {
    const calls = { count: 0 };
    const client = clientOver([jsonResponse(targetJevResponse())], calls);
    const post = makePost();
    await client.analyzeTarget({ apiKey: 'k', post });
    // A DRAFT analysis of similar content must not hit the target cache: it fetches (and the
    // stub returns a target-shaped reply, which the draft parser rejects as malformed — the
    // point here is only that a network call happened).
    await client.analyzeDraft({ apiKey: 'k', draft: { text: post.text, hashtags: [], urls: [], hasMedia: false, isReply: false, charCount: post.text.length, capturedAt: 0 } });
    expect(calls.count).toBe(2);
  });
});

describe('TargetAnalysisService (VAL-SETUP-012: AI off keeps targets local)', () => {
  function storeOver(settings: Record<string, unknown>, apiKey?: string): SettingsStore {
    return {
      getSettings: async () => ({
        enabled: true,
        autoAnalyze: true,
        jevForDrafts: true,
        jevForTargets: false,
        minDraftLength: 10,
        targetThreshold: 70,
        ...settings,
      }) as ReturnType<SettingsStore['getSettings']> extends Promise<infer T> ? T : never,
      getApiKey: async () => apiKey,
    } as unknown as SettingsStore;
  }

  function jevOver(calls: { count: number }): JevClient {
    return {
      analyzeDraft: async () => {
        throw new Error('not used');
      },
      analyzeTarget: async () => {
        calls.count += 1;
        return {
          ok: true as const,
          verdict: { ordinal: 4, confidence: 0.7, band: 'strong' as const, strengths: [], weaknesses: [], suggestions: [] },
          source: 'fresh' as const,
          latencyMs: 10,
        };
      },
      optimizeDraft: async () => {
        throw new Error('not used');
      },
    };
  }

  it('refuses with {kind: unavailable} and zero client calls when jevForTargets is off', async () => {
    const calls = { count: 0 };
    const service = createTargetAnalysisService({ store: storeOver({ jevForTargets: false }, 'k'), jev: jevOver(calls) });
    expect(await service.analyzeTarget(makePost())).toEqual({ kind: 'unavailable' });
    expect(calls.count).toBe(0);
  });

  it('refuses with {kind: disabled} when the master switch is off, and {kind: no-key} without a key', async () => {
    const calls = { count: 0 };
    const jev = jevOver(calls);
    const off = createTargetAnalysisService({ store: storeOver({ enabled: false, jevForTargets: true }, 'k'), jev });
    expect(await off.analyzeTarget(makePost())).toEqual({ kind: 'disabled' });
    const noKey = createTargetAnalysisService({ store: storeOver({ jevForTargets: true }), jev });
    expect(await noKey.analyzeTarget(makePost())).toEqual({ kind: 'no-key' });
    expect(calls.count).toBe(0);
  });

  it('calls the client with the key when enabled and maps the verdict through', async () => {
    const calls = { count: 0 };
    const service = createTargetAnalysisService({ store: storeOver({ jevForTargets: true }, 'k'), jev: jevOver(calls) });
    const result = await service.analyzeTarget(makePost());
    expect(result.kind).toBe('analyzed');
    if (result.kind === 'analyzed') {
      expect(result.verdict.band).toBe('strong');
      expect(result.source).toBe('fresh');
    }
    expect(calls.count).toBe(1);
  });

  it('maps client failures to a typed error result', async () => {
    const jev: JevClient = {
      analyzeDraft: async () => {
        throw new Error('not used');
      },
      analyzeTarget: async () => ({ ok: false as const, failure: { kind: 'http-error' as const, status: 401 } }),
      optimizeDraft: async () => {
        throw new Error('not used');
      },
    };
    const service = createTargetAnalysisService({ store: storeOver({ jevForTargets: true }, 'k'), jev });
    expect(await service.analyzeTarget(makePost())).toEqual({
      kind: 'error',
      failure: { kind: 'http-error', status: 401 },
    });
  });
});

describe('target rubric config sanity', () => {
  it('labels every angle id in English and freezes the question set', () => {
    for (const id of Object.keys(TARGET_ANALYSIS_QUESTIONS[REPLY_ANGLE_QUESTION_ID]!.criteria) as ReplyAngleId[]) {
      expect(ANGLE_LABELS[id]).toMatch(/^[A-Za-z]/);
    }
    expect(Object.isFrozen(TARGET_ANALYSIS_QUESTIONS)).toBe(true);
  });
});
