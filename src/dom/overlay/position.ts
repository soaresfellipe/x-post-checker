/**
 * Pure placement math for the overlay host (VAL-DRAFT-023). The panel anchors below the composer
 * REGION — the region includes the composer's toolbar, so the panel never covers the composer,
 * its media control or the Post button; horizontally it clamps inside the visible viewport.
 * Positions are document-absolute (viewport rect + scroll offset), so page scrolling never
 * detaches the panel.
 *
 * When the panel fits neither side whole (a short window with a tall analyzed breakdown), the
 * anchor is capped to the available space — the below-region space first, else the fold-above
 * space when that offers more room — and the overlay scrolls the panel internally. The capped
 * panel always ends at the viewport margin: it stays inside the viewport, anchored to the region
 * edge, and the composer region stays uncovered.
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
   * The height the overlay must cap the panel to (px, applied with internal scrolling), or null
   * when the panel's natural size already fits the chosen side (VAL-DRAFT-023).
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

  // Vertical: anchor below the region so the panel can NEVER cover the composer, its media
  // control or the Post button. Fold above only when below would overflow the viewport AND the
  // panel fits fully in the space above the region. When NEITHER side fits the whole panel, the
  // height caps to the available space (VAL-DRAFT-023): below first, else the fold-above space
  // when it offers strictly more room. The composer region stays uncovered either way.
  const below = regionRect.bottom + scroll.y + gap;
  const viewportTop = scroll.y + margin;
  const viewportBottom = scroll.y + viewport.height - margin;
  const spaceBelow = Math.max(viewportBottom - below, 0);
  const spaceAbove = Math.max(regionRect.top + scroll.y - gap - viewportTop, 0);

  let top = below;
  let maxHeight: number | null = null;
  if (overlaySize.height <= spaceBelow) {
    // Fits fully below the region: natural size, no cap.
  } else if (overlaySize.height <= spaceAbove) {
    top = regionRect.top + scroll.y - gap - overlaySize.height; // fold above, full height
  } else if (spaceBelow >= spaceAbove) {
    maxHeight = spaceBelow; // cap below the region (below-first precedence)
  } else {
    maxHeight = spaceAbove; // fold above, capped: the panel's bottom meets the region's top
    top = viewportTop;
  }
  top = Math.max(top, viewportTop);

  // Horizontal: aligned with the region's left edge, clamped inside the visible window.
  const leftEdge = scroll.x + margin;
  const rightEdge = scroll.x + viewport.width - overlaySize.width - margin;
  const left = Math.min(Math.max(regionRect.left + scroll.x, leftEdge), Math.max(leftEdge, rightEdge));

  return { top, left, maxHeight };
}
