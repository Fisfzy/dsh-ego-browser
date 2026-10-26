import { describe, expect, it, vi } from 'vitest'
import { BrowserStateStore } from '../src/browser-state.ts'
import { createPanelController, parseCapture, type PanelTransport } from '../src/tui/panel-controller.ts'
import { layoutPanel } from '../src/tui/panel-layout.ts'
import { displayWidth } from '../src/tui/text.ts'

describe('existing worker capture status', () => {
  it('accepts future string states, ignores missing or malformed status, and clears stale state without new requests', async () => {
    expect(parseCapture({ spaces: [] })).toBeUndefined()
    expect(parseCapture({ capture: { backend: 12, state: 'idle' } })).toBeUndefined()
    expect(parseCapture({ capture: { backend: 'future', state: 'paused', code: null } })).toEqual({ backend: 'future', state: 'paused' })
    const store = new BrowserStateStore(), config = { disableFrameRelay: false }
    const get = vi.fn<PanelTransport['get']>(async () => ({ spaces: [], capture: { backend: 'cdp', state: 'idle' } }))
    const readBrowserState = vi.fn(async () => ({ running: true }))
    const transport: PanelTransport = { readBrowserState, get, ensureWorker: async () => 1234, post: async () => null }
    const controller = createPanelController(store, config, transport)
    await controller.refresh()
    expect(store.getSnapshot().capture).toEqual({ backend: 'cdp', state: 'idle' })
    expect(get).toHaveBeenCalledTimes(1)
    get.mockResolvedValueOnce({ spaces: [] })
    await controller.refresh()
    expect(store.getSnapshot().capture).toBeUndefined()
    // Text-only TUI: the preview relay setting no longer suppresses metadata.
    config.disableFrameRelay = true
    await controller.refresh()
    expect(store.getSnapshot().capture).toEqual({ backend: 'cdp', state: 'idle' })
    expect(get).toHaveBeenCalledTimes(3)
    config.disableFrameRelay = false
    readBrowserState.mockResolvedValue({ running: false })
    await controller.refresh()
    expect(store.getSnapshot().capture).toBeUndefined()
    expect(get).toHaveBeenCalledTimes(3)
    controller.dispose()
  })

  it('owns an immutable capture copy and has no capture row in the text-only layout', () => {
    const store = new BrowserStateStore()
    const capture = { backend: 'cdp', state: 'failed', code: '中文错误描述'.repeat(12) }
    store.update({ browser: { running: true }, capture })
    capture.backend = 'mutated'
    expect(store.getSnapshot().capture?.backend).toBe('cdp')
    expect(Object.isFrozen(store.getSnapshot().capture)).toBe(true)
    const rows = layoutPanel(store.getSnapshot(), 28, 12, 0)
    expect(rows.some(row => row.text.startsWith('Capture'))).toBe(false)
    expect(rows.every(row => displayWidth(row.text) <= 28)).toBe(true)
    const previous = store.getSnapshot()
    store.update({ capture: { ...previous.capture! } })
    expect(store.getSnapshot()).toBe(previous)
  })
})
