/**
 * TargetScorer — reply-target scoring (architecture: "HeuristicEngine (pure, unit-tested)").
 * Reply-target scoring signals"). Pure functions only: PostSnapshot -> TargetScore. No DOM, no
 * storage, no network, no mutation.
 *
 * Eligibility mirrors the x-algorithm pre-score filters: AgeFilter (posts older than 48 hours are
 * removed regardless of engagement) and OONRetweetReplyFilter (replies by authors the viewer does
 * not follow are removed; out-of-network ORIGINALS remain eligible). Ineligible posts headline 0
 * with a single explanatory breakdown entry — they are never reply targets, so no content signal
 * is applied to them at all.
 *
 * Every weight/band/pattern comes from `./config` — this file contains no scoring numbers.
 */
import { parseUrls } from '@/core/draft-snapshot';
import type { PostSnapshot } from '@/core/post-snapshot';
import { BAIT_PATTERNS, HEURISTIC_CONFIG, TARGET_CONFIG } from './config';
import type { SignalDirection, SignalEntry, TargetIneligibilityReason, TargetScore } from './types';

/** Stable breakdown order: eligibility state, momentum, conversation, author, penalties. */
const SIGNAL_IDS = {
  eligibility: 'eligibility',
  velocity: 'velocity',
  replyLikeRatio: 'reply-like-ratio',
  question: 'question',
  verified: 'verified-author',
  depth: 'conversation-depth',
  mutual: 'mutual-follow',
  bait: 'engagement-bait',
} as const;

/** English UI labels, one per signal id. */
const SIGNAL_LABELS: Readonly<Record<keyof typeof SIGNAL_IDS, string>> = {
  eligibility: 'Eligibility',
  velocity: 'Engagement velocity',
  replyLikeRatio: 'Reply:like ratio',
  question: 'Question',
  verified: 'Verified author',
  depth: 'Conversation depth',
  mutual: 'Mutual follow',
  bait: 'Engagement bait',
};

/**
 * Scores one PostSnapshot's reply-target potential into a 0-100 headline plus a per-signal
 * breakdown. Ineligible posts (stale, out-of-network reply) score 0 with the exclusion reason —
 * the badge layer renders nothing for them regardless of the configured threshold.
 */
export function scoreTarget(post: PostSnapshot, now: number = Date.now()): TargetScore {
  const ineligibleReason = ineligibilityOf(post, now);
  if (ineligibleReason !== null) {
    return {
      headline: 0,
      totalPoints: 0,
      eligible: false,
      ineligibleReason,
      signals: [eligibilityEntry(ineligibleReason, post)],
    };
  }

  // Pattern checks run on the text WITHOUT URLs so a "?utm=..." query parameter cannot fake a
  // question and a link slug cannot fake bait phrasing.
  const contentText = stripUrls(post.text);

  const signals: SignalEntry[] = [
    eligibilityEntry(null, post),
    velocitySignal(post),
    replyRatioSignal(post),
    questionSignal(contentText),
    verifiedSignal(post),
    depthSignal(post),
    mutualSignal(post),
    baitSignal(contentText),
  ];

  const totalPoints = signals.reduce((sum, signal) => sum + signal.points, 0);
  return { headline: clampHeadline(totalPoints), totalPoints, eligible: true, signals };
}

/** Points -> headline scale: the same neutral base and clamp as draft scoring. */
function clampHeadline(totalPoints: number): number {
  const { base, min, max } = HEURISTIC_CONFIG.headline;
  return Math.round(Math.min(max, Math.max(min, base + totalPoints)));
}

/**
 * The eligibility gates, in x-algorithm filter order: AgeFilter first, OONRetweetReplyFilter
 * second. `inNetwork: false` on a reply is the honest no-visible-marker extraction, which the
 * source filter treats the same way (replies with missing ancestry data are also removed).
 */
function ineligibilityOf(post: PostSnapshot, now: number): TargetIneligibilityReason | null {
  // AgeFilter on the EXACT publication instant: strict >48h exclusion at ms granularity, so a
  // post 48h+1s old (which rounds to 2880 whole minutes) is still excluded. Snapshots without
  // `publishedAt` (legacy captures) fall back to the whole-minute gate.
  if (post.publishedAt !== undefined) {
    if (now - post.publishedAt > TARGET_CONFIG.recency.maxAgeMs) return 'stale-over-48h';
  } else if (post.ageMinutes > TARGET_CONFIG.recency.maxAgeMinutes) {
    return 'stale-over-48h';
  }
  if (post.isReply && !post.inNetwork) return 'out-of-network-reply';
  return null;
}

function entry(id: keyof typeof SIGNAL_IDS, value: string, points: number, direction?: SignalDirection): SignalEntry {
  return {
    id: SIGNAL_IDS[id],
    label: SIGNAL_LABELS[id],
    value,
    points,
    direction: direction ?? (points > 0 ? 'positive' : points < 0 ? 'negative' : 'neutral'),
    applied: points !== 0,
  };
}

/**
 * The eligibility state line: always present, zero points. For an eligible post it states the age
 * window; for an ineligible post it is the ONLY entry and carries the typed exclusion reason.
 */
function eligibilityEntry(reason: TargetIneligibilityReason | null, post: PostSnapshot): SignalEntry {
  if (reason === 'stale-over-48h') {
    return {
      ...entry('eligibility', `ineligible: ${formatAge(post.ageMinutes)} old (posts older than 48h are never reply targets)`, 0),
      direction: 'negative',
      applied: true,
    };
  }
  if (reason === 'out-of-network-reply') {
    return {
      ...entry('eligibility', 'ineligible: reply by an author the viewer does not follow (out-of-network replies are filtered)', 0),
      direction: 'negative',
      applied: true,
    };
  }
  return entry('eligibility', `eligible: ${formatAge(post.ageMinutes)} old (within the 48h reply window)`, 0);
}

function velocitySignal(post: PostSnapshot): SignalEntry {
  const counts = [post.likeCount, post.replyCount, post.repostCount];
  if (counts.every((count) => count === undefined)) {
    return entry('velocity', 'engagement counts not visible - velocity not scored (never guessed)', 0);
  }
  const total = counts.reduce<number>((sum, count) => sum + (count ?? 0), 0);
  if (total === 0) return entry('velocity', 'no visible engagement yet', 0);

  // A brand-new post (age clamped at 1 minute) with any engagement is by definition top velocity.
  const perHour = total / (Math.max(post.ageMinutes, 1) / 60);
  const band =
    TARGET_CONFIG.velocityBands.find((candidate) => perHour >= candidate.minPerHour) ??
    TARGET_CONFIG.velocityBands[TARGET_CONFIG.velocityBands.length - 1]!;
  return entry(
    'velocity',
    `${total} engagements in ${formatAge(post.ageMinutes)} (~${formatRate(perHour)}/h - ${band.note})`,
    band.points,
  );
}

function replyRatioSignal(post: PostSnapshot): SignalEntry {
  if (post.replyCount === undefined || post.likeCount === undefined) {
    return entry('replyLikeRatio', 'reply or like count not visible - ratio not scored (never guessed)', 0);
  }
  if (post.replyCount === 0) return entry('replyLikeRatio', 'no replies yet - conversation not started', 0);

  // Replies without likes divide by 1: a reply-only conversation is maximally active, not infinite.
  const ratio = post.replyCount / Math.max(post.likeCount, 1);
  const band =
    TARGET_CONFIG.replyRatioBands.find((candidate) => ratio >= candidate.minRatio) ??
    TARGET_CONFIG.replyRatioBands[TARGET_CONFIG.replyRatioBands.length - 1]!;
  return entry(
    'replyLikeRatio',
    `${post.replyCount} replies / ${post.likeCount} likes (~${formatRate(ratio)} - ${band.note})`,
    band.points,
  );
}

function questionSignal(contentText: string): SignalEntry {
  if (contentText.includes('?')) return entry('question', 'question post (invites replies)', TARGET_CONFIG.weights.question);
  return entry('question', 'no question detected', 0);
}

function verifiedSignal(post: PostSnapshot): SignalEntry {
  return post.verified
    ? entry('verified', 'verified author (small directional modifier)', TARGET_CONFIG.weights.verified)
    : entry('verified', 'not verified', 0);
}

/**
 * Conversation depth: a post that is itself a reply sits inside an existing thread (deeper
 * conversation where a new reply is buried); an original post is the shallow case.
 */
function depthSignal(post: PostSnapshot): SignalEntry {
  if (post.isReply) {
    return entry('depth', 'reply inside an existing thread (deep conversation)', TARGET_CONFIG.weights.deepThreadPenalty);
  }
  return entry('depth', 'original post (shallow conversation)', 0);
}

/**
 * The network boost for original posts ONLY (never applied to replies as targets — mirrors the
 * source filter, which requires the candidate to have no parent). `inNetwork: false` means no
 * visible viewer-follows-author marker: no boost, never guessed.
 */
function mutualSignal(post: PostSnapshot): SignalEntry {
  if (post.isReply) return entry('mutual', 'not applied to replies (reply targets never get the network boost)', 0);
  if (post.inNetwork) {
    return entry('mutual', 'original post by an account the viewer follows (visible)', TARGET_CONFIG.weights.mutualBoost);
  }
  return entry('mutual', 'no visible viewer-follows-author marker - boost not applied (never guessed)', 0);
}

function baitSignal(contentText: string): SignalEntry {
  for (const pattern of BAIT_PATTERNS) {
    const match = pattern.exec(contentText);
    if (match) {
      return entry('bait', `bait pattern: "${match[0].toLowerCase()}"`, TARGET_CONFIG.weights.engagementBait);
    }
  }
  return entry('bait', 'clean', 0);
}

function stripUrls(text: string): string {
  let stripped = text;
  for (const url of parseUrls(text)) stripped = stripped.split(url).join(' ');
  return stripped;
}

/** "90min" under two hours, then whole/half hours ("2h", "43h", "1.5h"). */
function formatAge(ageMinutes: number): string {
  if (ageMinutes < 120) return `${ageMinutes}min`;
  const rounded = Math.round(ageMinutes / 6) / 10;
  return `${rounded}h`;
}

/** Adaptive magnitude: integers above 10, one decimal above 1, two decimals below. */
function formatRate(value: number): string {
  if (value >= 10) return String(Math.round(value));
  if (value >= 1) return String(Math.round(value * 10) / 10);
  return String(Math.round(value * 100) / 100);
}
