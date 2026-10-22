import { describe, it, expect } from 'vitest'
import { clampViewportSize, computeWindowBounds, widthWithDelta, MIN_VIEWPORT_HEIGHT, MIN_VIEWPORT_WIDTH } from '../src/worker/window-size.ts'

describe('clampViewportSize', () => {
  it('clamps both dimensions into the sane range', () => {
    expect(clampViewportSize(100, 100)).toEqual({ width: MIN_VIEWPORT_WIDTH, height: MIN_VIEWPORT_HEIGHT })
    expect(clampViewportSize(5000, 5000)).toEqual({ width: 3840, height: 2160 })
    expect(clampViewportSize(1000, 700)).toEqual({ width: 1000, height: 700 })
  })
})

describe('widthWithDelta', () => {
  it('moves the viewport width by the drag delta', () => {
    expect(widthWithDelta(1264, 100)).toBe(1364)
    expect(widthWithDelta(1264, -200)).toBe(1064)
  })

  it('clamps to the sane range so a drag cannot produce a sliver or an absurd window', () => {
    expect(widthWithDelta(400, -1000)).toBe(MIN_VIEWPORT_WIDTH)
    expect(widthWithDelta(3000, 5000)).toBe(3840)
  })

  it('rounds fractional deltas', () => {
    expect(widthWithDelta(1000, 12.6)).toBe(1013)
  })
})

describe('computeWindowBounds', () => {
  it('adds the measured Chrome frame to the requested viewport', () => {
    expect(computeWindowBounds({ width: 800, height: 600 }, { width: 0, height: 132 })).toMatchObject({
      width: 800,
      height: 732,
      windowState: 'normal',
    })
    expect(computeWindowBounds({ width: 640, height: 480 }, { width: 16, height: 88 })).toMatchObject({
      width: 656,
      height: 568,
    })
  })

  it('keeps the current window position', () => {
    const bounds = computeWindowBounds({ width: 900, height: 700 }, { width: 0, height: 100 }, { left: 120, top: 64 })
    expect(bounds.left).toBe(120)
    expect(bounds.top).toBe(64)
    expect(bounds.width).toBe(900)
    expect(bounds.height).toBe(800)
  })

  it('floors absurdly small requests instead of sending slivers', () => {
    const bounds = computeWindowBounds({ width: 10, height: 10 }, { width: 0, height: 0 })
    expect(bounds.width).toBe(MIN_VIEWPORT_WIDTH)
    expect(bounds.height).toBe(MIN_VIEWPORT_HEIGHT)
  })

  it('rounds fractional sizes', () => {
    const bounds = computeWindowBounds({ width: 799.6, height: 600.4 }, { width: 0.4, height: 131.6 })
    expect(bounds.width).toBe(800)
    expect(bounds.height).toBe(732)
  })

  it('always restores a normal window state', () => {
    expect(computeWindowBounds({ width: 800, height: 600 }).windowState).toBe('normal')
  })
})
