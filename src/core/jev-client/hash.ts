/**
 * The draft cache key: a deterministic 64-bit hex hash of the exact Jev request identity
 * (rubric version + built state). Identical draft + context -> identical state -> identical key,
 * so a re-typed draft is served the cached verdict without a new request. `capturedAt` is
 * deliberately NOT part of the identity, and neither is the follow-state visibility: the request
 * Jev would receive is identical in those cases, so the verdict is too.
 *
 * Hashing (instead of using the draft text as the key) keeps draft content out of both the cache
 * keys in memory and the persisted storage entries — only the verdict is ever stored.
 */
import type { DraftSnapshot } from '@/core/draft-snapshot';
import { DRAFT_RUBRIC_VERSION, TARGET_RUBRIC_VERSION } from './config';
import { buildDraftContextState } from './request';

const FNV_PRIME = 0x01000193;
/** Two independent FNV-1a offset bases -> two 32-bit digests -> one 64-bit hex key. */
const FNV_OFFSET_BASES = [0x811c9dc5, 0x811c6dc5] as const;

function fnv1a32(text: string, offsetBasis: number): string {
  let hash = offsetBasis >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function draftCacheKey(draft: DraftSnapshot): string {
  const identity = `${DRAFT_RUBRIC_VERSION}\n${buildDraftContextState(draft)}`;
  return `${fnv1a32(identity, FNV_OFFSET_BASES[0])}${fnv1a32(identity, FNV_OFFSET_BASES[1])}`;
}

/**
 * The TARGET cache key: the post's stable status id under the target rubric version (VAL-TARGET-020
 * keys the cache PER POST — a close/reopen of the same post's popover is served without another
 * request, a different post pays its own first request). The `target:` prefix keeps these keys
 * disjoint from the draft cache's hash keys in the same storage area. The post id is an opaque
 * numeric token from the status URL, so it needs no hashing to stay out of the way — but the
 * rubric version stays folded in so a rubric change can never serve an older verdict.
 */
export function targetCacheKey(postId: string): string {
  return `target:${TARGET_RUBRIC_VERSION}:${postId}`;
}
