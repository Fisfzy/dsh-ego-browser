/**
 * Panel size → real browser window size.
 *
 * The watch panel shows a screencast frame. By default resizing the panel only
 * scales that frame; with the panel's size-sync toggle unlocked, the panel
 * reports its live-image box and the worker resizes the REAL Chrome window so
 * the page reflows at the size the user is drawing. The page viewport is not
 * the window: Chrome's own frame (tab strip / toolbar / borders) sits outside
 * it, so the target window is the requested viewport plus that delta, measured
 * from the page (`outerWidth - innerWidth`).
 */

export interface WindowBoundsTarget {
  left?: number
  top?: number
  width: number
  height: number
  windowState: 'normal'
}

/** Chrome refuses slivers; below this a resize is not worth sending. */
export const MIN_VIEWPORT_WIDTH = 320
export const MIN_VIEWPORT_HEIGHT = 200

/**
 * Compute CDP `Browser.setWindowBounds` bounds for a desired page viewport.
 *
 * `left`/`top` are preserved when known so the window does not jump to another
 * corner while the user drags a panel edge. `windowState: 'normal'` is always
 * included: a maximized window ignores width/height until it is restored.
 */
export function computeWindowBounds(
  viewport: { width: number; height: number },
  chromeFrame: { width: number; height: number } = { width: 0, height: 0 },
  current: { left?: number; top?: number } = {},
): WindowBoundsTarget {
  const width = Math.max(MIN_VIEWPORT_WIDTH, Math.round(viewport.width + Math.max(0, chromeFrame.width)))
  const height = Math.max(MIN_VIEWPORT_HEIGHT, Math.round(viewport.height + Math.max(0, chromeFrame.height)))
  return {
    ...(typeof current.left === 'number' && Number.isFinite(current.left) ? { left: Math.round(current.left) } : {}),
    ...(typeof current.top === 'number' && Number.isFinite(current.top) ? { top: Math.round(current.top) } : {}),
    width,
    height,
    windowState: 'normal',
  }
}
