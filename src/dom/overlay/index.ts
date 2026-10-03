/**
 * ScoreOverlay public surface: the controller (`createScoreOverlay`), the pure view model, the
 * placement math and the UI constants/copy. Mounted by the content script next to the marker,
 * driven by the composer watcher's events and the analyze-draft replies.
 */
export { OVERLAY_HOST_ID, OVERLAY_TESTID, OVERLAY_TESTIDS, OVERLAY_COPY, OVERLAY_PLACEMENT } from './config';
export { createScoreOverlay } from './overlay';
export { deriveOverlayView, draftIdentity, failureReason } from './view-model';
export { computeAnchorPosition } from './position';
export type { AnchorPosition, OverlaySize, RegionRect, ScrollOffset, Viewport } from './position';
export type { JevSection, JevSectionState, OverlayView, OverlayViewInputs, ScoreOverlay, ScoreOverlayOptions } from './types';
