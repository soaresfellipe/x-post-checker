/**
 * TargetBadges public surface: the controller (`createTargetBadges`), the popover, the pure view
 * model and the UI constants/copy. Mounted by the content script alongside the timeline scanner.
 */
export {
  BADGE_STYLE,
  BADGE_TESTID,
  BADGE_TESTIDS,
  BADGE_COPY,
  POPOVER_HOST_ID,
  POPOVER_STYLE,
  POPOVER_TESTIDS,
  POPOVER_PLACEMENT,
} from './config';
export { createTargetBadges } from './controller';
export type { TargetBadges, TargetBadgesOptions } from './controller';
export { createTargetPopover } from './popover';
export type { TargetPopover, TargetPopoverView, TargetPopoverCallbacks } from './popover';
export { badgeReason, isBadgeEligible, deriveTargetAiSection, targetFailureReason } from './view-model';
export type { TargetAiSection, TargetAiState } from './view-model';
