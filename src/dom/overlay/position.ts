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
  /** The region's right edge, when the caller can measure it (the pill's bottom-right anchor). */
  readonly right?: number;
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
  /**
   * Present only for the COLLAPSED pill: the height band its top edge sits in, measured up from
   * the region's BOTTOM edge (the composer furniture row). The pill is anchored there instead of
   * below the region so it never occupies the space X's own mention/emoji/GIF popups take
   * (VAL-DRAFT-032/033/040). Absent for the expanded panel, which keeps the below-the-region
   * placement above.
   */
  readonly pillTop?: number;
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

  // Horizontal: the COLLAPSED PILL is anchored bottom-RIGHT of the region (VAL-DRAFT-033): its
  // right edge sits `pillInsetRight` short of the region's right edge, leaving the Post button
  // (the rightmost control of the composer furniture row) clear, and its top edge sits in that
  // row's own band (see `computePillPosition`), so the text area above is never covered. When the
  // region's right edge cannot be measured, the pill falls back to the region's left edge clamped
  // inside the viewport (its previous placement).
  const leftEdge = scroll.x + margin;
  const rightEdge = scroll.x + viewport.width - overlaySize.width - margin;
  const desiredLeft =
    regionRect.right === undefined
      ? regionRect.left + scroll.x
      : regionRect.right + scroll.x - overlaySize.width - OVERLAY_PLACEMENT.pillInsetRight;
  const left = Math.min(Math.max(desiredLeft, leftEdge), Math.max(leftEdge, rightEdge));

  return { top, left, maxHeight };
}

/**
 * The COLLAPSED PILL's placement (VAL-DRAFT-032/033): its bottom-right corner sits inside the
 * composer REGION — right-aligned `pillInsetRight` short of the region's right edge (clear of the
 * Post button) and `pillInsetBottom` above the region's bottom edge, which is the top of the
 * composer furniture row that holds the character counter and the media controls. Sitting in that
 * band (rather than below the region) is what makes the pill structurally unable to cover the
 * text area, the counter, the media controls or the Post button, and — because the space below is
 * left entirely free — it can never occlude X's own mention/emoji/GIF popups, which grow
 * downward from the composer (VAL-DRAFT-040).
 *
 * A region too short to hold the pill falls back to the panel's below-the-region placement, which
 * is still inside the viewport and still outside the text area.
 */
export function computePillPosition(inputs: {
  regionRect: RegionRect;
  overlaySize: OverlaySize;
  viewport: Viewport;
  scroll: ScrollOffset;
}): AnchorPosition {
  const { regionRect, overlaySize, viewport, scroll } = inputs;
  const regionBottom = regionRect.bottom + scroll.y;
  const preferredTop = regionBottom - OVERLAY_PLACEMENT.pillInsetBottom - overlaySize.height;
  if (preferredTop < regionRect.top + scroll.y || preferredTop < scroll.y) {
    return computeAnchorPosition(inputs);
  }
  const position = computeAnchorPosition(inputs);
  const maxHeight = viewport.height + scroll.y - preferredTop - OVERLAY_PLACEMENT.viewportMargin;
  return {
    top: preferredTop,
    left: position.left,
    maxHeight: maxHeight >= overlaySize.height ? null : Math.max(maxHeight, 0),
    pillTop: preferredTop,
  };
}
