import type { TargetSessions } from './capture-cdp.ts'

/** A single viewport PNG on the existing control session; never starts a watch. */
export async function captureSnapshot(sessions: Pick<TargetSessions, 'call'>, targetId: string, maxWidth: number): Promise<Buffer> {
  const result = await sessions.call(targetId, 'Runtime.evaluate', {
    expression: '({ x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })',
    returnByValue: true,
  }) as { result?: { value?: { x: number; y: number; width: number; height: number; dpr: number } } }
  const viewport = result.result?.value
  if (!viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) {
    throw new Error('viewport unavailable')
  }
  const dpr = Number.isFinite(viewport.dpr) && viewport.dpr > 0 ? viewport.dpr : 1
  // CDP clip coordinates are document CSS pixels. Compensate for DPR so
  // maxWidth describes output pixels, including on high-density displays.
  const scale = Math.min(1, maxWidth / viewport.width) / dpr
  const image = await sessions.call(targetId, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: {
      x: viewport.x || 0,
      y: viewport.y || 0,
      width: viewport.width,
      height: viewport.height,
      scale,
    },
  }) as { data?: string }
  if (!image.data) throw new Error('snapshot unavailable')
  return Buffer.from(image.data, 'base64')
}
