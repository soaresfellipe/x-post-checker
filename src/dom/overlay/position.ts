/**
 * Pure placement math for the overlay host (VAL-DRAFT-023). The panel anchors below the composer
 * REGION — the region includes the composer's toolbar, so the panel never covers the composer,
 * its media control or the Post button; horizontally it clamps inside the visible viewport.
 * Positions are document-absolute (viewport rect + scroll offset), so page scrolling never
 * detaches the panel.
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

  // Vertical: anchor below the region so the panel can NEVER cover the composer, its media
  // control or the Post button. Fold above only when below would overflow the viewport AND the
  // panel fits fully in the space above the region. When neither fits, below still wins: the
  // panel's bottom may extend past the viewport (the page scrolls to it), but the composer
  // region stays uncovered — pushing the panel back up onto the composer is never an option.
  const below = regionRect.bottom + scroll.y + gap;
  const above = regionRect.top + scroll.y - gap - overlaySize.height;
  const viewportTop = scroll.y + margin;
  const viewportBottom = scroll.y + viewport.height - overlaySize.height - margin;
  let top = below;
  if (top > viewportBottom && above >= viewportTop) top = above;
  top = Math.max(top, viewportTop);

  // Horizontal: aligned with the region's left edge, clamped inside the visible window.
  const leftEdge = scroll.x + margin;
  const rightEdge = scroll.x + viewport.width - overlaySize.width - margin;
  const left = Math.min(Math.max(regionRect.left + scroll.x, leftEdge), Math.max(leftEdge, rightEdge));

  return { top, left };
}
