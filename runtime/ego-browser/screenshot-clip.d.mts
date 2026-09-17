/**
 * Type declarations for screenshot-clip.mjs (PR #50).
 * Sibling declaration so `tests/screenshot-clip.test.ts` can import the plain
 * JS runtime module without TS7016 under tsconfig's tests/ scope.
 */
export interface ScreenshotClipInfo {
  sx?: number
  sy?: number
  w: number
  h: number
  pw: number
  ph: number
}
export interface ScreenshotClipOptions {
  full?: boolean
  clip?: { x?: number; y?: number; width: number; height: number }
  cssScale?: number
}
export function captureScreenshotClip(
  info: ScreenshotClipInfo,
  options?: ScreenshotClipOptions,
): { x: number; y: number; width: number; height: number; scale: number }
