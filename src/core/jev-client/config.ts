/**
 * The one place every Jev client rubric string, retry, rate-limit, timeout and cache parameter
 * lives (AGENTS.md: "Weights/coefficients live in one config module; no magic numbers in logic").
 *
 * The two draft-analysis questions are the VERIFIED working example from
 * research/readiness/dependency-readiness.md (live 200 exchange, 2026-10-02). The criteria arrays
 * and the choice map are copied verbatim; the viral_potential instructions keep the verified
 * wording with the topic clause generalized ("interested in this topic"), because user drafts are
 * not always about productivity. Distilled contract: library/jev-api.md.
 */

export type MainWeaknessId =
  | 'weak_hook'
  | 'not_specific_enough'
  | 'unclear_audience_value'
  | 'weak_share_trigger'
  | 'no_major_weakness';

export interface JevScoreQuestion {
  readonly type: 'score';
  readonly instructions: string;
  readonly criteria: readonly string[];
}

export interface JevChoiceQuestion<ChoiceId extends string = MainWeaknessId> {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: Readonly<Record<ChoiceId, string>>;
}

export const VIRAL_POTENTIAL_QUESTION_ID = 'viral_potential';
export const MAIN_WEAKNESS_QUESTION_ID = 'main_weakness';

/** The verified six-level score rubric for the draft's viral potential (ordinal 0..5). */
export const VIRAL_POTENTIAL_QUESTION: JevScoreQuestion = Object.freeze({
  type: 'score',
  instructions:
    'For an English-language X audience interested in this topic, how likely is this draft to ' +
    'substantially outperform a typical post in engagement? Consider its hook, specificity, ' +
    'usefulness, distinctiveness, and reason to share. This is a heuristic judgment, not a ' +
    'guaranteed prediction.',
  criteria: Object.freeze([
    'Very low: generic or unclear, with no audience value or reason to engage.',
    'Low: limited audience interest; the idea or presentation is mostly generic.',
    'Below average: some useful value, but the hook or share trigger is weak.',
    'Moderate: clear value for a defined audience and a plausible reason to engage.',
    'High: memorable or useful, with a strong reason to reply, save, or share.',
    'Very high: unusually distinctive and compelling, with multiple strong reasons to engage and share.',
  ]),
});

/** The verified choice rubric naming the single most limiting weakness. */
export const MAIN_WEAKNESS_QUESTION: JevChoiceQuestion = Object.freeze({
  type: 'choice',
  instructions: 'Which single weakness most limits this X draft?',
  criteria: Object.freeze({
    weak_hook: 'The opening does not earn attention.',
    not_specific_enough: 'The draft needs a concrete example or actionable detail.',
    unclear_audience_value: 'The intended audience or benefit is unclear.',
    weak_share_trigger: 'There is little reason to reply, save, or share.',
    no_major_weakness: 'No single major weakness stands out.',
  }),
});

/** Both rubric questions, keyed by the ids the verified contract uses on the wire. */
export const DRAFT_ANALYSIS_QUESTIONS = Object.freeze({
  [VIRAL_POTENTIAL_QUESTION_ID]: VIRAL_POTENTIAL_QUESTION,
  [MAIN_WEAKNESS_QUESTION_ID]: MAIN_WEAKNESS_QUESTION,
});

/** Human-readable one-liners for the weakness choices, keyed by the choice ids Jev returns. */
export const WEAKNESS_LABELS: Readonly<Record<MainWeaknessId, string>> = Object.freeze({
  weak_hook: 'Weak hook — the opening does not earn attention.',
  not_specific_enough: 'Not specific enough — needs a concrete example or actionable detail.',
  unclear_audience_value: 'Unclear audience value — the audience or benefit is unclear.',
  weak_share_trigger: 'Weak share trigger — little reason to reply, save, or share.',
  no_major_weakness: 'No single major weakness stands out.',
});

/**
 * Bump when the rubric, the model alias or the state format changes: it is folded into the cache
 * key, so a changed request can never be served an older verdict.
 */
export const DRAFT_RUBRIC_VERSION = 'draft-analysis-rubric-v1';

/** Per-attempt abort deadline for the whole exchange (request -> headers -> full body). */
export const JEV_ANALYSIS_TIMEOUT_MS = 10_000;

/** Transient failures are retried; everything else fails fast with a typed result. */
export const JEV_RETRY = Object.freeze({
  /** Extra attempts after the first, capped: 2 means at most 3 exchanges per analysis. */
  maxRetries: 2,
  /** Delay before retry n (1-indexed); the last value repeats if there are more retries. */
  backoffMs: Object.freeze([250, 500]),
});

/** HTTP statuses treated as transient (feature: "503/network"). 401/403 and others are final. */
export const JEV_RETRYABLE_HTTP_STATUSES: readonly number[] = Object.freeze([502, 503, 504]);

/** Cost guard: never send more than this many Jev requests per sliding window. */
export const JEV_RATE_LIMIT = Object.freeze({ maxRequests: 30, windowMs: 60_000 });

/** Verdict cache capacity, per store: oldest entries are evicted first. */
export const JEV_CACHE_MAX_ENTRIES = 50;

/** The score question's ordinal range: 0..criteria-1 (six criteria levels -> 0..5). */
export const VIRAL_ORDINAL_MAX = VIRAL_POTENTIAL_QUESTION.criteria.length - 1;

/**
 * Reply-target deep analysis rubric (M3, the popover's "Deep analysis" action). Both question
 * types are VERIFIED live (score and choice — library/jev-api.md); the `noul` type is not
 * verified and is deliberately unused here. Like the draft rubric: a heuristic judgment for an
 * English-language X audience, never presented as a prediction.
 */
export type ReplyAngleId =
  | 'add_data'
  | 'share_experience'
  | 'ask_followup'
  | 'respectful_disagreement'
  | 'no_angle';

export const REPLY_POTENTIAL_QUESTION_ID = 'reply_potential';
export const REPLY_ANGLE_QUESTION_ID = 'reply_angle';

/** How worthwhile is replying to THIS post, for an author seeking engagement (ordinal 0..5). */
export const REPLY_POTENTIAL_QUESTION: JevScoreQuestion = Object.freeze({
  type: 'score',
  instructions:
    'For an English-language X audience, how worthwhile is it for another user to reply to this ' +
    'post right now if they want their reply to be seen and to earn engagement? Consider the ' +
    'conversation momentum, the invitation to respond, and how visible a good reply would be. ' +
    'This is a heuristic judgment, not a guaranteed prediction.',
  criteria: Object.freeze([
    'Very low: no visible momentum and nothing invites a reply.',
    'Low: little momentum; a reply would likely go unnoticed.',
    'Below average: some conversation, but replies are not clearly surfaced.',
    'Moderate: an active conversation where a good reply can be seen.',
    'High: strong momentum or a direct invitation; a good reply is likely to be seen.',
    'Very high: exceptional momentum and invitation; an excellent reply opportunity right now.',
  ]),
});

/** The single reply angle most likely to earn engagement on this post. */
export const REPLY_ANGLE_QUESTION: JevChoiceQuestion<ReplyAngleId> = Object.freeze({
  type: 'choice',
  instructions: 'Which single reply angle is most likely to earn engagement on this post?',
  criteria: Object.freeze({
    add_data: 'Add a concrete fact, number, or source that advances the conversation.',
    share_experience: 'Share a short first-hand experience that relates to the post.',
    ask_followup: 'Ask a sharp follow-up question that moves the thread forward.',
    respectful_disagreement: 'Respectfully push back with a clear reason.',
    no_angle: 'No angle stands out; a reply is unlikely to stand out either.',
  }),
});

/** Both target rubric questions, keyed by the ids used on the wire. */
export const TARGET_ANALYSIS_QUESTIONS = Object.freeze({
  [REPLY_POTENTIAL_QUESTION_ID]: REPLY_POTENTIAL_QUESTION,
  [REPLY_ANGLE_QUESTION_ID]: REPLY_ANGLE_QUESTION,
});

/** The popover's reply-angle result: the rubric choice plus its human-readable label. */
export interface TargetReplyAngle {
  readonly choice: ReplyAngleId;
  readonly label: string;
  readonly confidence: number;
}

/** Human-readable one-liners for the angle choices, keyed by the choice ids Jev returns. */
export const ANGLE_LABELS: Readonly<Record<ReplyAngleId, string>> = Object.freeze({
  add_data: 'Add data - a concrete fact, number, or source.',
  share_experience: 'Share a short first-hand experience.',
  ask_followup: 'Ask a sharp follow-up question.',
  respectful_disagreement: 'Respectfully disagree with a clear reason.',
  no_angle: 'No angle stands out.',
});

/**
 * Bump when the target rubric or its state format changes: folded into the target cache key, so
 * a changed request can never be served an older verdict.
 */
export const TARGET_RUBRIC_VERSION = 'target-analysis-rubric-v1';

/** The target score question's ordinal range: 0..criteria-1 (six criteria levels -> 0..5). */
export const REPLY_ORDINAL_MAX = REPLY_POTENTIAL_QUESTION.criteria.length - 1;
