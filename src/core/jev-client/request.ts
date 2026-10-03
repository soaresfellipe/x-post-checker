/**
 * Pure request mapping for draft analysis: DraftSnapshot -> the verified systemone request shape
 * ({model, state, questions}). No network, no storage, no DOM — the transport owns the wire.
 */
import type { DraftSnapshot } from '@/core/draft-snapshot';
import type { PostSnapshot } from '@/core/post-snapshot';
import { JEV_MODEL_ALIAS } from './connection-test';
import { DRAFT_ANALYSIS_QUESTIONS, TARGET_ANALYSIS_QUESTIONS } from './config';

/**
 * The `state` is the decision situation Jev judges: the draft text first, then a context block
 * naming what the text alone cannot reveal (reply context, attached media). The context block is
 * ALWAYS present so identical drafts always produce byte-identical states — which is what the
 * cache key and the coalescing identity depend on.
 */
export function buildDraftContextState(draft: DraftSnapshot): string {
  const context: string[] = [];
  context.push(
    draft.isReply
      ? draft.replyToHandle
        ? `This is a reply to @${draft.replyToHandle}.`
        : 'This is a reply to another post.'
      : 'This is an original post.',
  );
  if (draft.hasMedia) context.push('An image or video is attached to the post.');

  return [draft.text, '', 'Context:', ...context.map((line) => `- ${line}`)].join('\n');
}

/** The wire request for one draft: verified alias, draft state, and the frozen rubric questions. */
export interface JevDraftAnalysisRequest {
  readonly model: typeof JEV_MODEL_ALIAS;
  readonly state: string;
  readonly questions: typeof DRAFT_ANALYSIS_QUESTIONS;
}

export function buildDraftAnalysisRequest(draft: DraftSnapshot): JevDraftAnalysisRequest {
  return {
    model: JEV_MODEL_ALIAS,
    state: buildDraftContextState(draft),
    questions: DRAFT_ANALYSIS_QUESTIONS,
  };
}

/**
 * The `state` for target deep analysis: the post text first, then a context block with every
 * fact the text alone cannot reveal (author, age, visible engagement, reply/network state).
 * ALWAYS present and deterministic, so identical snapshots produce byte-identical states — the
 * cache key and coalescing identity depend on it. Absent optional counts are stated as not
 * visible, never guessed.
 */
export function buildTargetAnalysisState(post: PostSnapshot): string {
  const context: string[] = [];
  context.push(`Author: @${post.authorHandle}.`);
  context.push(`Posted ${formatTargetAge(post.ageMinutes)} ago.`);
  const counts: string[] = [];
  counts.push(post.replyCount === undefined ? 'replies not visible' : `${post.replyCount} replies`);
  counts.push(post.repostCount === undefined ? 'reposts not visible' : `${post.repostCount} reposts`);
  counts.push(post.likeCount === undefined ? 'likes not visible' : `${post.likeCount} likes`);
  context.push(`Engagement so far: ${counts.join(', ')}.`);
  context.push(post.isReply ? 'This post is a reply inside an existing thread.' : 'This is an original post.');
  if (post.isReply && post.replyToHandle) context.push(`It replies to @${post.replyToHandle}.`);
  if (post.inNetwork) context.push('The viewer follows this author.');
  if (post.verified) context.push('The author is verified.');
  if (post.hasMedia) context.push('An image or video is attached to the post.');

  return [post.text, '', 'Context:', ...context.map((line) => `- ${line}`)].join('\n');
}

/** "90min" under two hours, then whole/half hours — mirrors the scorer's wording, no imports. */
function formatTargetAge(ageMinutes: number): string {
  if (ageMinutes < 120) return `${Math.max(1, Math.round(ageMinutes))}min`;
  const hours = ageMinutes / 60;
  return `${Math.round(hours * 2) / 2}h`;
}

/** The wire request for one post's deep analysis: verified alias, post state, target rubric. */
export interface JevTargetAnalysisRequest {
  readonly model: typeof JEV_MODEL_ALIAS;
  readonly state: string;
  readonly questions: typeof TARGET_ANALYSIS_QUESTIONS;
}

export function buildTargetAnalysisRequest(post: PostSnapshot): JevTargetAnalysisRequest {
  return {
    model: JEV_MODEL_ALIAS,
    state: buildTargetAnalysisState(post),
    questions: TARGET_ANALYSIS_QUESTIONS,
  };
}
