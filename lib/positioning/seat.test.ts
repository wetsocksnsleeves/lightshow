import { describe, expect, it } from "vitest";
import {
  DEFAULT_POSITIONING,
  inchesFromTargetWidth,
  TARGET_SHARE_OF_SCREEN,
  screenFromConfig,
  screenFromDiagonal,
  targetShareOfScreen,
  targetWidthFromScreen,
  roomToVenuePoint,
  targetWidthFromInches,
} from "./seat";

const config = { targetWidthM: 3, venueWidthM: 20, venueDepthM: 30 };

describe("roomToVenuePoint", () => {
  it("puts the screen at the top centre of the venue", () => {
    expect(roomToVenuePoint({ x: 0, z: 0 }, config)).toEqual({ x: 0.5, y: 0 });
  });

  it("scales metres to the venue box", () => {
    expect(roomToVenuePoint({ x: -5, z: 15 }, config)).toEqual({
      x: 0.25,
      y: 0.5,
    });
  });

  it("clamps positions outside the box to its edge", () => {
    expect(roomToVenuePoint({ x: 50, z: 45 }, config)).toEqual({ x: 1, y: 1 });
  });
});

describe("screen size in inches", () => {
  it("defaults to a 55 inch screen", () => {
    expect(inchesFromTargetWidth(DEFAULT_POSITIONING.targetWidthM)).toBeCloseTo(
      55,
      9,
    );
  });

  it("gives the target width on a fullscreen 16:9 screen", () => {
    // A 65" TV is 1.439 m wide; the target spans about 65.5% of it.
    expect(targetWidthFromInches(65)).toBeCloseTo(0.943, 3);
  });

  it("round-trips", () => {
    expect(inchesFromTargetWidth(targetWidthFromInches(100))).toBeCloseTo(
      100,
      9,
    );
  });

  it("turns a diagonal into width and height", () => {
    const tv = screenFromDiagonal(55 * 0.0254);
    expect(tv.widthM / tv.heightM).toBeCloseTo(16 / 9, 9);
    expect(targetWidthFromScreen(tv)).toBeCloseTo(targetWidthFromInches(55), 9);

    const fourThree = screenFromDiagonal(2.5, 4 / 3);
    expect(fourThree.widthM).toBeCloseTo(2, 9);
    expect(fourThree.heightM).toBeCloseTo(1.5, 9);
  });
});

describe("screen shape", () => {
  it("matches the 16:9 share exactly, and grows on squarer screens", () => {
    expect(targetShareOfScreen(16 / 9)).toBeCloseTo(TARGET_SHARE_OF_SCREEN, 9);
    expect(targetShareOfScreen(16 / 10)).toBeCloseTo(0.728, 3);
    // 4:3: the page runs out of width first.
    expect(targetShareOfScreen(4 / 3)).toBeCloseTo(16 / 19, 9);
    // Ultrawide: less of the width.
    expect(targetShareOfScreen(21 / 9)).toBeCloseTo(0.499, 3);
  });

  it("works out the target width from the screen's width and height", () => {
    // A 65 inch 16:9 TV is the same as entering 65 inches.
    const tv = { widthM: 1.439, heightM: 1.439 * (9 / 16) };
    expect(targetWidthFromScreen(tv)).toBeCloseTo(targetWidthFromInches(65), 3);
    // A 4:3 projector screen 2 m wide.
    expect(targetWidthFromScreen({ widthM: 2, heightM: 1.5 })).toBeCloseTo(
      (2 * 16) / 19,
      9,
    );
  });

  it("reads the screen back from a config, or assumes 16:9", () => {
    const config = {
      targetWidthM: 1,
      venueWidthM: 200,
      venueDepthM: 200,
    };
    const screen = screenFromConfig(config);
    expect(screen.widthM / screen.heightM).toBeCloseTo(16 / 9, 9);
    expect(targetWidthFromScreen(screen)).toBeCloseTo(1, 9);
    expect(
      screenFromConfig({ ...config, screen: { widthM: 3, heightM: 2 } }),
    ).toEqual({ widthM: 3, heightM: 2 });
  });
});
