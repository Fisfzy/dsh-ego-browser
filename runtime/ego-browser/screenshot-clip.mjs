/**
 * Build a Page.captureScreenshot `clip` in document CSS pixels.
 *
 * CDP clip origin is the layout/document origin, not the visual viewport.
 * `pageInfo().sx/sy` are window.scrollX/scrollY; `boundingBox()` is
 * viewport-relative (getBoundingClientRect). Viewport-only shots and locator
 * clips must add that scroll, otherwise the clip sits at document (0, 0)
 * while captureBeyondViewport is false — Chrome returns a tiny blank PNG
 * after the page has been scrolled. fullPage stays at (0, 0) with
 * captureBeyondViewport: true.
 *
 * Same contract as runtime/ego-linux/src/spaces-server.mjs followClip.
 *
 * @param {{ sx?: number, sy?: number, w: number, h: number, pw: number, ph: number }} info
 * @param {{ full?: boolean, clip?: { x?: number, y?: number, width: number, height: number }, cssScale?: number }} [options]
 */
export function captureScreenshotClip(info, options = {}) {
  const cssScale = options.cssScale ?? 1;
  const sx = Number(info?.sx) || 0;
  const sy = Number(info?.sy) || 0;
  if (options.clip) {
    return {
      scale: cssScale,
      ...options.clip,
      x: (Number(options.clip.x) || 0) + sx,
      y: (Number(options.clip.y) || 0) + sy,
    };
  }
  if (options.full) {
    return {
      x: 0,
      y: 0,
      width: info.pw,
      height: info.ph,
      scale: cssScale,
    };
  }
  return {
    x: sx,
    y: sy,
    width: info.w,
    height: info.h,
    scale: cssScale,
  };
}
