/**
 * Placement math for the overlay host's FALLBACK mode only (M6, Design 1b): when the composer's
 * `[data-testid="toolBar"]` cannot be found, the host falls back to absolute placement below the
 * composer REGION with the same row anatomy. In the normal IN-FLOW mode there is nothing to
 * compute — the row reflows natively above the toolbar (the M5 pill position math
 * `computePillPosition`/`clampPillClearOfControl` is DELETED with the pill itself).
 *
 * The fallback anchors below the region — the region includes the composer's furniture, so the
 * row never covers the composer, its media control or the Post button; horizontally it clamps
 * inside the visible viewport. Positions are document-absolute (viewport rect + scroll offset),
 * so page scrolling never detaches the row. When the content does not fit below (a short window),
 * the anchor caps to the available below-space and the expanded block scrolls internally.
 */
import { OVERLAY_PLACEMENT } from './config';

export interface RegionRect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
}

export interface OverlaySize {
  readonly width: number;
  readonly height: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface ScrollOffset {
  readonly x: number;
  readonly y: number;
}

export interface AnchorPosition {
  readonly top: number;
  readonly left: number;
  /**
   * The height the overlay must cap the expanded block to (px, applied with internal scrolling),
   * or null when its natural size already fits below (VAL-DRAFT-023).
   */
  readonly maxHeight: number | null;
}

export function computeAnchorPosition(inputs: {
  regionRect: RegionRect;
  overlaySize: OverlaySize;
  viewport: Viewport;
  scroll: ScrollOffset;
}): AnchorPosition {
  const { regionRect, overlaySize, viewport, scroll } = inputs;
  const margin = OVERLAY_PLACEMENT.viewportMargin;
  const gap = OVERLAY_PLACEMENT.gap;

  // Vertical: anchor below the region so the row can NEVER cover the composer, its media
  // control or the Post button. When below would overflow the viewport, the height caps to the
  // available below-space and the expanded block scrolls internally.
  const below = regionRect.bottom + scroll.y + gap;
  const viewportTop = scroll.y + margin;
  const viewportBottom = scroll.y + viewport.height - margin;
  const spaceBelow = Math.max(viewportBottom - below, 0);

  let top = below;
  let maxHeight: number | null = null;
  if (overlaySize.height > spaceBelow) maxHeight = spaceBelow;
  top = Math.max(top, viewportTop);

  // Horizontal: align with the region's left edge, clamped inside the viewport.
  const leftEdge = scroll.x + margin;
  const rightEdge = scroll.x + viewport.width - overlaySize.width - margin;
  const desiredLeft = regionRect.left + scroll.x;
  const left = Math.min(Math.max(desiredLeft, leftEdge), Math.max(leftEdge, rightEdge));

  return { top, left, maxHeight };
}
