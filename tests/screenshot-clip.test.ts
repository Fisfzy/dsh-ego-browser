import { describe, it, expect } from "vitest";
import { captureScreenshotClip } from "../runtime/ego-browser/screenshot-clip.mjs";

const scrolled = { sx: 0, sy: 3000, w: 800, h: 600, pw: 800, ph: 7139 };

describe("Page.captureScreenshot clip origin", () => {
  it("viewport shot after scroll uses document (sx, sy), not (0, 0)", () => {
    expect(captureScreenshotClip(scrolled)).toEqual({
      x: 0,
      y: 3000,
      width: 800,
      height: 600,
      scale: 1,
    });
  });

  it("fullPage stays at document (0, 0) covering the layout size", () => {
    expect(captureScreenshotClip(scrolled, { full: true })).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 7139,
      scale: 1,
    });
  });

  it("locator boundingBox is viewport-relative and must add scroll", () => {
    expect(
      captureScreenshotClip(scrolled, {
        clip: { x: 10, y: 20, width: 100, height: 50 },
        cssScale: 0.5,
      }),
    ).toEqual({
      x: 10,
      y: 3020,
      width: 100,
      height: 50,
      scale: 0.5,
    });
  });
});
