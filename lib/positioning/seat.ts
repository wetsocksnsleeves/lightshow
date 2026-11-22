import type { Point, PositioningConfig, ScreenSize } from "../types";
import { EXTENT, W } from "./pattern";
import { clampUnit } from "../venue-geometry";

/**
 * Share of a 16:9 screen's width between the left and right anchor centres
 * when the big screen page is fullscreen (`/sessions/[code]/screen`). The
 * page leaves bands above and below the target, so this varies a little with
 * resolution: 0.653 at 1280x720, 0.657 at 1920x1080.
 */
export const TARGET_SHARE_OF_SCREEN = 0.655;

/**
 * Share of the page's height the target can use: the logo band above and
 * the margin below take the rest. Set so a 16:9 screen gives exactly
 * `TARGET_SHARE_OF_SCREEN`.
 */
const PAGE_HEIGHT_SHARE = (TARGET_SHARE_OF_SCREEN * EXTENT.h * 16) / (9 * W);

/**
 * Share of a screen's width between the target's corner square centres, for
 * a screen `aspect` (width / height) wide. The page fits the target to the
 * screen, so on narrow screens it's limited by the width instead of the
 * height.
 */
export function targetShareOfScreen(aspect: number): number {
  return Math.min(W / EXTENT.w, (W * PAGE_HEIGHT_SHARE) / (EXTENT.h * aspect));
}

/** Target width (metres) on a screen this big, showing the page fullscreen. */
export function targetWidthFromScreen(screen: ScreenSize): number {
  return screen.widthM * targetShareOfScreen(screen.widthM / screen.heightM);
}

/** Screen width and height (metres) from a diagonal and aspect ratio. */
export function screenFromDiagonal(
  diagonalM: number,
  aspect = 16 / 9,
): ScreenSize {
  const heightM = diagonalM / Math.hypot(aspect, 1);
  return { widthM: heightM * aspect, heightM };
}

/** The screen size a config stands for: as entered, or 16:9 from the target. */
export function screenFromConfig(config: PositioningConfig): ScreenSize {
  if (config.screen) return config.screen;
  const widthM = config.targetWidthM / TARGET_SHARE_OF_SCREEN;
  return { widthM, heightM: (widthM * 9) / 16 };
}

/** 16:9 screen width as a fraction of its diagonal. */
const WIDTH_PER_DIAGONAL = 16 / Math.hypot(16, 9);
const METRES_PER_INCH = 0.0254;

/** Target width (metres) on a 16:9 screen of `inches` diagonal, fullscreen. */
export function targetWidthFromInches(inches: number): number {
  return inches * METRES_PER_INCH * WIDTH_PER_DIAGONAL * TARGET_SHARE_OF_SCREEN;
}

/** The screen diagonal (inches) that gives `targetWidthM`. */
export function inchesFromTargetWidth(targetWidthM: number): number {
  return (
    targetWidthM /
    (METRES_PER_INCH * WIDTH_PER_DIAGONAL * TARGET_SHARE_OF_SCREEN)
  );
}

/**
 * Used until the host sets the screen size. The room is a large box so that
 * nobody's position is clipped: shows are fitted to the crowd itself
 * (`lib/crowd.ts`), not to the room.
 */
export const DEFAULT_POSITIONING: PositioningConfig = {
  targetWidthM: targetWidthFromInches(55),
  venueWidthM: 200,
  venueDepthM: 200,
};

/**
 * Turn a camera position into a room point. The room's top edge is the
 * screen, centred. The 0..1 box spans `venueWidthM` across and `venueDepthM`
 * back from the screen.
 *
 * `room` is the camera position in metres: `x` right of the screen centre as
 * the audience sees it, `z` out from the screen.
 */
export function roomToVenuePoint(
  room: { x: number; z: number },
  config: PositioningConfig,
): Point {
  return {
    x: clampUnit(0.5 + room.x / config.venueWidthM),
    y: clampUnit(room.z / config.venueDepthM),
  };
}
