/**
 * HeuristicEngine draft scoring (architecture: "HeuristicEngine (pure, unit-tested)"). Pure
 * functions only: DraftSnapshot -> LocalScore. No DOM, no storage, no network, no mutation.
 *
 * Every weight/band/pattern comes from `./config` — this file contains no scoring numbers.
 */
import { parseUrls, type DraftSnapshot } from '@/core/draft-snapshot';
import {
  BAIT_PATTERNS,
  DM_SHARE_PATTERNS,
  HEURISTIC_CONFIG,
  LIST_ITEM_PATTERN,
  SHAREABLE_FORMATS,
  STRONG_CLAIM_PATTERNS,
} from './config';
import { classifyLink, linkHost } from './links';
import type { LocalScore, SignalEntry } from './types';

/** Stable breakdown order: scoring floor, content signals, context, penalties. */
const SIGNAL_IDS = {
  baseline: 'baseline',
  replyMagnet: 'reply-magnet',
  copyLink: 'copy-link',
  dmShare: 'share-dm',
  length: 'length',
  hashtags: 'hashtags',
  // Machine id kept as `external-link` (DOM/E2E suites and VAL-DRAFT-007 grouping pin it); the
  // label and value carry the destination truth: only off-platform links are called external.
  links: 'external-link',
  media: 'media',
  replyMutual: 'reply-mutual',
  engagementBait: 'engagement-bait',
  moderation: 'moderation',
} as const;

/** English UI labels, one per signal id. */
const SIGNAL_LABELS: Readonly<Record<keyof typeof SIGNAL_IDS, string>> = {
  baseline: 'Baseline',
  replyMagnet: 'Reply magnet',
  copyLink: 'Shareable format',
  dmShare: 'DM-worthy',
  length: 'Length',
  hashtags: 'Hashtags',
  links: 'Links',
  media: 'Media',
  replyMutual: 'Reply context',
  engagementBait: 'Engagement bait',
  moderation: 'Moderation flags',
};

/**
 * Scores one eligible draft into a 0-100 headline plus a per-signal breakdown. The eligibility
 * gate (minDraftLength) belongs to the watcher/analyzer; this function scores whatever it gets.
 */
export function scoreDraft(snapshot: DraftSnapshot): LocalScore {
  // Pattern checks run on the text WITHOUT URLs so "?utm=..." cannot fake a question and long
  // slugs cannot fake a keyword match. Snapshot urls may be t.co-EXPANDED while `text` keeps the
  // URL as typed, so strip BOTH the as-written tokens and the expanded destinations.
  const contentText = stripUrls(snapshot.text, snapshot.urls);

  const signals: SignalEntry[] = [
    baselineSignal(),
    replyMagnetSignal(contentText),
    copyLinkSignal(contentText),
    dmShareSignal(contentText),
    lengthSignal(snapshot.charCount),
    hashtagSignal(snapshot.hashtags.length),
    linkSignal(snapshot.urls),
    mediaSignal(snapshot.hasMedia),
    replyMutualSignal(snapshot),
    baitSignal(contentText),
    moderationSignal(contentText),
  ];

  const totalPoints = signals.reduce((sum, signal) => sum + signal.points, 0);
  return { headline: clampHeadline(totalPoints), totalPoints, signals };
}

/** Points -> headline scale: neutral base plus the weighted sum, clamped to the 0-100 range. */
function clampHeadline(totalPoints: number): number {
  const { base, min, max } = HEURISTIC_CONFIG.headline;
  return Math.round(Math.min(max, Math.max(min, base + totalPoints)));
}

function entry(signal: keyof typeof SIGNAL_IDS, value: string, points: number): SignalEntry {
  return {
    id: SIGNAL_IDS[signal],
    label: SIGNAL_LABELS[signal],
    value,
    points,
    direction: points > 0 ? 'positive' : points < 0 ? 'negative' : 'neutral',
    applied: points !== 0,
  };
}

function stripUrls(text: string, urls: readonly string[]): string {
  let stripped = text;
  // The as-written tokens re-parsed from `text` cover short forms whose expansion replaced them
  // in `urls`; the exact split/join keeps the strip deterministic for both lists.
  for (const url of [...parseUrls(text), ...urls]) stripped = stripped.split(url).join(' ');
  return stripped;
}

function baselineSignal(): SignalEntry {
  return entry('baseline', 'eligible draft', HEURISTIC_CONFIG.weights.likeBaseline);
}

function replyMagnetSignal(contentText: string): SignalEntry {
  const isQuestion = contentText.includes('?');
  const isStrongClaim = STRONG_CLAIM_PATTERNS.some((pattern) => pattern.test(contentText));
  const { question, strongClaim, maxPoints } = HEURISTIC_CONFIG.replyMagnet;

  if (isQuestion && isStrongClaim) {
    return entry('replyMagnet', 'question + strong claim (capped)', Math.min(question + strongClaim, maxPoints));
  }
  if (isQuestion) return entry('replyMagnet', 'question', question);
  if (isStrongClaim) return entry('replyMagnet', 'strong claim', strongClaim);
  return entry('replyMagnet', 'none detected', 0);
}

function copyLinkSignal(contentText: string): SignalEntry {
  const detected: string[] = [];
  let listLines = 0;
  for (const _match of contentText.matchAll(LIST_ITEM_PATTERN)) {
    listLines += 1;
    if (listLines >= HEURISTIC_CONFIG.detection.minListItems) {
      detected.push('list');
      break;
    }
  }
  for (const format of SHAREABLE_FORMATS) {
    if (format.patterns.some((pattern) => pattern.test(contentText))) detected.push(format.label);
  }
  if (detected.length === 0) return entry('copyLink', 'no shareable format', 0);
  return entry('copyLink', detected.join(', '), HEURISTIC_CONFIG.weights.copyLinkTrigger);
}

function dmShareSignal(contentText: string): SignalEntry {
  const matched = DM_SHARE_PATTERNS.filter((pattern) => pattern.test(contentText));
  if (matched.length === 0) return entry('dmShare', 'no send-to-a-friend phrasing', 0);
  return entry('dmShare', 'send/share-to-a-friend phrasing', HEURISTIC_CONFIG.weights.shareDmTrigger);
}

function lengthSignal(charCount: number): SignalEntry {
  const band =
    HEURISTIC_CONFIG.lengthBands.find((candidate) => charCount >= candidate.min && charCount <= candidate.max) ??
    HEURISTIC_CONFIG.lengthBands[HEURISTIC_CONFIG.lengthBands.length - 1]!;
  return entry('length', `${charCount} chars (${band.label})`, band.points);
}

function hashtagSignal(count: number): SignalEntry {
  const band =
    HEURISTIC_CONFIG.hashtagBands.find((candidate) => count <= candidate.max) ??
    HEURISTIC_CONFIG.hashtagBands[HEURISTIC_CONFIG.hashtagBands.length - 1]!;
  const noun = count === 1 ? 'hashtag' : 'hashtags';
  return entry('hashtags', `${count} ${noun} - ${band.note}`, band.points);
}

/**
 * The draft link signal (M2 scrutiny round-1 fix): the external-link penalty is a minor negative
 * for OFF-platform destinations ONLY. Links to x.com/twitter.com and their subdomains (status/
 * profile/permalink destinations) keep the viewer on X — no penalty, never labeled external. An
 * unexpanded t.co wrapper exposes no destination, so nothing is guessed: no penalty, and the
 * short URL stands as the value (same never-guess rule as the follow-state signal).
 */
function linkSignal(urls: readonly string[]): SignalEntry {
  if (urls.length === 0) return entry('links', 'none', 0);

  const classified = urls.map((url) => ({ url, destination: classifyLink(url) }));
  const external = classified.filter((link) => link.destination === 'off-platform');
  const onPlatform = classified.filter((link) => link.destination === 'on-platform');
  const unknown = classified.filter((link) => link.destination === 'unknown');

  const parts: string[] = [];
  if (external.length > 0) {
    parts.push(`${external.length} external ${pluralLinks(external.length)} (may reduce reply/share rates)`);
  }
  if (onPlatform.length > 0) {
    parts.push(`${onPlatform.length} on-platform ${pluralLinks(onPlatform.length)} (${onPlatformHosts(onPlatform)})`);
  }
  for (const link of unknown) parts.push(`${link.url} (destination not visible - never guessed)`);

  // One flat minor negative per draft while any off-platform link is present (config comment).
  return entry('links', parts.join('; '), external.length > 0 ? HEURISTIC_CONFIG.weights.externalLink : 0);
}

function pluralLinks(count: number): string {
  return count === 1 ? 'link' : 'links';
}

function onPlatformHosts(links: readonly { url: string }[]): string {
  const hosts = new Set<string>();
  for (const link of links) {
    const host = linkHost(link.url);
    if (host !== null) hosts.add(host);
  }
  return [...hosts].sort().join(', ');
}

function mediaSignal(hasMedia: boolean): SignalEntry {
  return hasMedia
    ? entry('media', 'media attached', HEURISTIC_CONFIG.weights.media)
    : entry('media', 'none', 0);
}

/**
 * The mutual/followed signal for reply drafts. Applied ONLY when `replyToFollowedByViewer` is
 * present in the snapshot — the field means the VIEWER follows the reply target (the DOM showed
 * the follow state) — absent means unknown, never guessed. The labels must state the direction
 * exactly (VAL-DRAFT-019): the overlay renders them verbatim in the breakdown.
 */
function replyMutualSignal(snapshot: DraftSnapshot): SignalEntry {
  if (!snapshot.isReply) return entry('replyMutual', 'not a reply', 0);

  const followed = snapshot.replyToFollowedByViewer;
  if (followed === true) {
    return entry('replyMutual', 'reply to an account the viewer follows (visible)', HEURISTIC_CONFIG.weights.replyMutualBoost);
  }
  if (followed === false) {
    return entry('replyMutual', 'reply to an account the viewer does not follow (visible)', 0);
  }
  return entry('replyMutual', 'reply - follow state not visible, boost not applied (never guessed)', 0);
}

function baitSignal(contentText: string): SignalEntry {
  for (const pattern of BAIT_PATTERNS) {
    const match = pattern.exec(contentText);
    if (match) {
      return entry('engagementBait', `bait pattern: "${match[0].toLowerCase()}"`, HEURISTIC_CONFIG.weights.engagementBait);
    }
  }
  return entry('engagementBait', 'clean', 0);
}

function moderationSignal(contentText: string): SignalEntry {
  const { moderation } = HEURISTIC_CONFIG;
  const flags: string[] = [];
  let points = 0;

  const letters = countMatches(contentText, /\p{L}/gu);
  const uppercase = countMatches(contentText, /\p{Lu}/gu);
  if (letters >= moderation.allCapsMinLetters && uppercase / letters >= moderation.allCapsRatio) {
    flags.push('ALL-CAPS shouting');
    points += moderation.allCapsPoints;
  }
  if (new RegExp(`[!?]{${moderation.punctuationRunLength},}`).test(contentText)) {
    flags.push('excessive punctuation');
    points += moderation.excessivePunctuationPoints;
  }

  if (flags.length === 0) return entry('moderation', 'clean', 0);
  return entry('moderation', flags.join(', '), points);
}

function countMatches(text: string, pattern: RegExp): number {
  let count = 0;
  for (const _match of text.matchAll(pattern)) count += 1;
  return count;
}
