import { describe, expect, it } from 'vitest';
import { isDraftSnapshot } from '@/core/draft-snapshot';
import {
  DRAFT_ANALYSIS_QUESTIONS,
  DRAFT_RUBRIC_VERSION,
  JEV_MODEL_ALIAS,
  MAIN_WEAKNESS_QUESTION_ID,
  VIRAL_POTENTIAL_QUESTION_ID,
  WEAKNESS_LABELS,
} from '@/core/jev-client';
import { buildDraftAnalysisRequest, buildDraftContextState } from '@/core/jev-client/request';
import { draftCacheKey } from '@/core/jev-client/hash';
import { makeDraft } from '../helpers/draft';

/**
 * The VERIFIED working example (research/readiness/dependency-readiness.md) pins the rubric the
 * client must send. The criteria arrays and the choice map are copied verbatim from that exchange;
 * the viral_potential instructions keep the verified wording with the topic clause generalized
 * ("interested in this topic") because user drafts are not always about productivity.
 */
const VERIFIED_VIRAL_POTENTIAL_CRITERIA = [
  'Very low: generic or unclear, with no audience value or reason to engage.',
  'Low: limited audience interest; the idea or presentation is mostly generic.',
  'Below average: some useful value, but the hook or share trigger is weak.',
  'Moderate: clear value for a defined audience and a plausible reason to engage.',
  'High: memorable or useful, with a strong reason to reply, save, or share.',
  'Very high: unusually distinctive and compelling, with multiple strong reasons to engage and share.',
];

const VERIFIED_MAIN_WEAKNESS = {
  type: 'choice',
  instructions: 'Which single weakness most limits this X draft?',
  criteria: {
    weak_hook: 'The opening does not earn attention.',
    not_specific_enough: 'The draft needs a concrete example or actionable detail.',
    unclear_audience_value: 'The intended audience or benefit is unclear.',
    weak_share_trigger: 'There is little reason to reply, save, or share.',
    no_major_weakness: 'No single major weakness stands out.',
  },
} as const;

describe('draft analysis request mapping (verified Jev contract)', () => {
  it('builds the request with the jev-latest alias, the draft state, and exactly the two rubric questions', () => {
    const draft = makeDraft();
    const request = buildDraftAnalysisRequest(draft);

    expect(request.model).toBe(JEV_MODEL_ALIAS);
    expect(request.model).toBe('jev-latest');
    expect(request.state).toBe(buildDraftContextState(draft));
    expect(Object.keys(request.questions).sort()).toEqual(
      [MAIN_WEAKNESS_QUESTION_ID, VIRAL_POTENTIAL_QUESTION_ID].sort(),
    );
  });

  it('sends the verified six-level viral_potential score rubric verbatim', () => {
    const question = buildDraftAnalysisRequest(makeDraft()).questions[VIRAL_POTENTIAL_QUESTION_ID];
    expect(question.type).toBe('score');
    // Verbatim from the verified example:
    expect(question.instructions).toContain('English-language X audience');
    expect(question.instructions).toContain('substantially outperform a typical post in engagement');
    expect(question.instructions).toContain('hook, specificity, usefulness, distinctiveness, and reason to share');
    expect(question.instructions.endsWith('This is a heuristic judgment, not a guaranteed prediction.')).toBe(true);
    expect([...question.criteria]).toEqual(VERIFIED_VIRAL_POTENTIAL_CRITERIA);
  });

  it('sends the verified main_weakness choice rubric verbatim', () => {
    const question = buildDraftAnalysisRequest(makeDraft()).questions[MAIN_WEAKNESS_QUESTION_ID];
    expect({ ...question, criteria: { ...question.criteria } }).toEqual(VERIFIED_MAIN_WEAKNESS);
  });

  it('exposes one human-readable label per weakness option, keyed by the choice ids', () => {
    expect(Object.keys(WEAKNESS_LABELS).sort()).toEqual(Object.keys(VERIFIED_MAIN_WEAKNESS.criteria).sort());
    for (const label of Object.values(WEAKNESS_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
      expect(label).toMatch(/[a-z]/i); // English sentence, never a bare machine id
    }
  });

  it('carries a non-empty rubric version so cache keys invalidate when the rubric changes', () => {
    expect(DRAFT_RUBRIC_VERSION.length).toBeGreaterThan(0);
    expect(DRAFT_ANALYSIS_QUESTIONS.viral_potential.criteria).toHaveLength(6);
    expect(Object.keys(DRAFT_ANALYSIS_QUESTIONS.main_weakness.criteria)).toHaveLength(5);
  });
});

describe('draft context state', () => {
  it('states the draft text first, then the context block', () => {
    const state = buildDraftContextState(makeDraft());
    expect(state.startsWith(makeDraft().text)).toBe(true);
    expect(state).toContain('Context:');
  });

  it('declares an original post explicitly', () => {
    expect(buildDraftContextState(makeDraft())).toContain('- This is an original post.');
  });

  it('declares a reply, with the handle only when it is visible', () => {
    expect(buildDraftContextState(makeDraft({ isReply: true }))).toContain('- This is a reply to another post.');
    expect(buildDraftContextState(makeDraft({ isReply: true, replyToHandle: 'typesafe' }))).toContain(
      '- This is a reply to @typesafe.',
    );
  });

  it('mentions attached media, which the text alone cannot reveal', () => {
    const withMedia = buildDraftContextState(makeDraft({ hasMedia: true }));
    expect(withMedia).toContain('- An image or video is attached to the post.');
    expect(buildDraftContextState(makeDraft({ hasMedia: false }))).not.toContain('image or video');
  });
});

describe('draft cache key (VAL-DRAFT-015)', () => {
  it('is a deterministic 64-bit hex hash for the identical draft', () => {
    const draft = makeDraft();
    expect(draftCacheKey(draft)).toBe(draftCacheKey(draft));
    expect(draftCacheKey(draft)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('ignores capturedAt: retyping the identical draft later hits the same key', () => {
    const draft = makeDraft();
    expect(draftCacheKey(makeDraft({ capturedAt: draft.capturedAt + 60_000 }))).toBe(draftCacheKey(draft));
  });

  it('changes when any state-relevant draft field changes', () => {
    const base = draftCacheKey(makeDraft());
    expect(draftCacheKey(makeDraft({ text: `${makeDraft().text} plus more` }))).not.toBe(base);
    expect(draftCacheKey(makeDraft({ isReply: true }))).not.toBe(base);
    expect(draftCacheKey(makeDraft({ hasMedia: true }))).not.toBe(base);
    expect(draftCacheKey(makeDraft({ isReply: true, replyToHandle: 'someone' }))).not.toBe(
      draftCacheKey(makeDraft({ isReply: true, replyToHandle: 'other' })),
    );
  });

  it('is unaffected by follow-state visibility: the Jev request (and so the verdict) never depends on it', () => {
    const unknown = draftCacheKey(makeDraft({ isReply: true }));
    const followed = draftCacheKey(makeDraft({ isReply: true, replyToFollowedByViewer: true }));
    const notFollowed = draftCacheKey(makeDraft({ isReply: true, replyToFollowedByViewer: false }));
    expect(followed).toBe(unknown);
    expect(notFollowed).toBe(unknown);
  });
});

describe('isDraftSnapshot runtime guard (message boundary)', () => {
  it('accepts a complete snapshot, with or without optional fields', () => {
    expect(isDraftSnapshot(makeDraft())).toBe(true);
    expect(isDraftSnapshot(makeDraft({ replyToHandle: 'x', replyToFollowedByViewer: true }))).toBe(true);
  });

  it('rejects partial or malformed payloads', () => {
    expect(isDraftSnapshot(null)).toBe(false);
    expect(isDraftSnapshot('text')).toBe(false);
    expect(isDraftSnapshot({ text: 'only text' })).toBe(false);
    expect(isDraftSnapshot({ ...makeDraft(), hashtags: 'none' })).toBe(false);
    expect(isDraftSnapshot({ ...makeDraft(), charCount: 'many' })).toBe(false);
    expect(isDraftSnapshot({ ...makeDraft(), replyToFollowedByViewer: 'yes' })).toBe(false);
  });
});
