import type { BrowserStateStore } from '../browser-state.ts'
import { decodePng, type RgbaImage } from './png.ts'

export interface ThumbnailState { readonly source?: RgbaImage; readonly alt: string }
export interface ThumbnailController {
  getSnapshot(): ThumbnailState
  subscribe(listener: () => void): () => void
  setView(visible: boolean, targetId: string | undefined, maxWidth: number): void
  refresh(): Promise<void>
  dispose(): void
}

/** Event-driven snapshots only: no streaming session and no recurring capture timer. */
export function createThumbnailController(store: BrowserStateStore, config: { readonly disableFrameRelay: boolean }, transport: {
  ensureWorker(): Promise<number | null>
  requestSnapshot(port: number, targetId: string, maxWidth: number): Promise<Uint8Array | null>
}): ThumbnailController {
  let state: ThumbnailState = { alt: 'Select a tab to preview' }
  const listeners = new Set<() => void>()
  let visible = false
  let targetId: string | undefined
  let maxWidth = 320
  let disposed = false
  let generation = 0
  let pending: Promise<void> | undefined
  let queued = false
  const publish = (next: ThumbnailState) => { state = next; for (const listener of [...listeners]) listener() }
  const refresh = (): Promise<void> => {
    if (disposed || !visible || !targetId) return Promise.resolve()
    if (config.disableFrameRelay) { publish({ alt: 'Preview disabled by settings' }); return Promise.resolve() }
    if (pending) { queued = true; return pending }
    const epoch = generation, target = targetId, width = maxWidth
    pending = (async () => {
      const port = await transport.ensureWorker()
      if (disposed || !visible || epoch !== generation || config.disableFrameRelay) return
      if (!port) { publish({ alt: 'Browser preview unavailable' }); return }
      const png = await transport.requestSnapshot(port, target, width)
      if (disposed || !visible || epoch !== generation || config.disableFrameRelay) return
      // Every successful decode owns a new RGBA buffer, including identical PNG bytes.
      publish(png ? { source: decodePng(png), alt: 'Browser tab preview · r refresh · o open' } : { alt: 'Preview unavailable · r retry · o open' })
    })().catch(() => {
      if (!disposed && visible && epoch === generation) publish({ alt: 'Preview unavailable · r retry · o open' })
    }).finally(() => {
      pending = undefined
      if (queued) { queued = false; void refresh() }
    })
    return pending
  }
  let latest = store.getSnapshot().recent.at(-1)
  const unsubscribe = store.subscribe(() => {
    const next = store.getSnapshot().recent.at(-1)
    if (next === latest) return
    latest = next
    if (next) void refresh()
  })
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    setView(nextVisible, nextTarget, nextWidth) {
      const width = Math.max(1, Math.min(1920, Math.floor(nextWidth)))
      if (visible === nextVisible && targetId === nextTarget && maxWidth === width) return
      visible = nextVisible; targetId = nextTarget; maxWidth = width; generation++
      if (state.source) publish({ alt: targetId ? 'Loading browser preview…' : 'Select a tab to preview' })
      if (visible) void refresh()
    },
    refresh,
    dispose() { disposed = true; generation++; queued = false; unsubscribe(); listeners.clear() },
  }
}
