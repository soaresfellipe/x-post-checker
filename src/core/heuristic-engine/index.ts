/**
 * HeuristicEngine public surface: draft scoring (pure), target scoring (pure), the hybrid headline
 * math and the Jev band mapping. All weights/bands/patterns live in `./config`; types in `./types`.
 */
export * from './config';
export { scoreDraft } from './engine';
export { scoreTarget, isTargetStale, staleTargetScore } from './target-scorer';
export { classifyLink } from './links';
export { JEV_BAND_LABELS, composeHeadline, mapJevBand, toJevVerdict } from './headline';
export type * from './types';
export type { LinkDestination } from './links';
