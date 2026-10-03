/**
 * Optimizer public surface: the result contracts, the service (settings gates + presentation
 * derivation over the JevClient's cached noul exchange), the pure variant/hashtag generators,
 * and the X weighted-char math. Wire plumbing (request/response mapping) is shared with the
 * JevClient, which orchestrates the exchange.
 */
export * from './types';
export { createOptimizerService, type OptimizerService, type OptimizerDeps } from './service';
export { generateHookVariants, type GeneratedVariant } from './variants';
export {
  generateHashtagCandidates,
  buildDropAdvice,
  suggestionRationale,
  type HashtagCandidate,
} from './hashtags';
export { weightedLength, isOverXLimit, X_POST_LIMIT, X_URL_WEIGHT } from './char-limit';
export {
  OPTIMIZER_RUBRIC_VERSION,
  OPTIMIZER_MAX_VARIANTS_PRESENTED,
  OPTIMIZER_MAX_HASHTAG_SUGGESTIONS,
  OPTIMIZER_HASHTAG_CANDIDATES,
  VARIANT_LABELS,
} from './config';
export { buildOptimizerPipeline, buildOptimizerState, type OptimizerPipeline } from './request';
export { parseOptimizeResponse, type ParseOptimizeResult } from './response';
