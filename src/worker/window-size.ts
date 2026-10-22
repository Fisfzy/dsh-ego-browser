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
/** A sanity ceiling; the OS clamps to the display anyway. */
export const MAX_VIEWPORT_WIDTH = 3840
export const MAX_VIEWPORT_HEIGHT = 2160

/** Keep a requested viewport inside a sane range (a sliver is unusable). */
export function clampViewportSize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.min(MAX_VIEWPORT_WIDTH, Math.max(MIN_VIEWPORT_WIDTH, Math.round(width))),
    height: Math.min(MAX_VIEWPORT_HEIGHT, Math.max(MIN_VIEWPORT_HEIGHT, Math.round(height))),
  }
}

/**
 * Apply a drag delta to the current viewport width.
 *
 * The panel's size-sync toggle maps the user's drag on the sidebar edge to a
 * window-width change, not to an absolute width: the panel is much narrower
 * than the browser window, so absolute mapping would shrink the window to the
 * sidebar on the very first frame.
 */
export function widthWithDelta(currentWidth: number, delta: number): number {
  const next = Math.round(currentWidth + delta)
  return Math.min(MAX_VIEWPORT_WIDTH, Math.max(MIN_VIEWPORT_WIDTH, next))
}

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
