/**
 * ScoreOverlay public surface: the controller (`createScoreOverlay`), the pure view model, the
 * chip selection, the fallback placement math and the UI constants/copy. Mounted by the content
 * script, driven by the composer watcher's events and the analyze-draft replies. M6 (Design 1b):
 * the controller renders the in-flow 36px status row (inserted before the composer's toolBar)
 * until a row click expands the inline analysis block.
 */
export { OVERLAY_HOST_ID, OVERLAY_TESTID, OVERLAY_TESTIDS, OVERLAY_COPY, OVERLAY_PLACEMENT } from './config';
export { OVERLAY_ROW_TESTID } from './config';
export { createScoreOverlay } from './overlay';
export { deriveOverlayView, draftIdentity, failureReason } from './view-model';
export { chipEligible, neutralCount, signalChips, summaryPhrases } from './chips';
export type { SignalChip } from './chips';
export { computeAnchorPosition } from './position';
export type { AnchorPosition, OverlaySize, RegionRect, ScrollOffset, Viewport } from './position';
export type { JevSection, JevSectionState, OverlayView, OverlayViewInputs, ScoreOverlay, ScoreOverlayOptions } from './types';
