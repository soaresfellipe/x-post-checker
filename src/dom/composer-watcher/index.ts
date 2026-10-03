export { DRAFT_DEBOUNCE_MS, isDraftEligible, type AnalysisTrigger, type DraftSnapshot } from '@/core/draft-snapshot';
export {
  extractDraftSnapshot,
  findComposer,
  findComposerRegion,
  findComposers,
  findReplyToHandle,
  getComposerTestidIndex,
  getComposerText,
  hasVisibleFollowIndicatorForReplyTarget,
} from './extract';
export { createComposerWatcher, describeComposer } from './watcher';
export { stampWatcherDiagnostics } from './diagnostics';
export type {
  AnalysisDispatch,
  ComposerChangeEvent,
  ComposerWatcher,
  ComposerWatcherOptions,
  DraftEvent,
} from './types';
