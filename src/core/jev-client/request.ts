/**
 * Pure request mapping for draft analysis: DraftSnapshot -> the verified systemone request shape
 * ({model, state, questions}). No network, no storage, no DOM — the transport owns the wire.
 */
import type { DraftSnapshot } from '@/core/draft-snapshot';
import { JEV_MODEL_ALIAS } from './connection-test';
import { DRAFT_ANALYSIS_QUESTIONS } from './config';

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
