import { describe, it, expect } from 'vitest'
import { clickScript } from '../src/index.ts'

/**
 * Compile the generated heredoc exactly like the runtime does, so a codegen
 * regression is caught before a browser is contacted (same harness as
 * tabs-script.test.ts).
 */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const CONTEXT_NAMES = ['page', 'browser', 'taskSpaces', 'site', 'fetch', 'cdp', 'help', 'console']
const compiles = (code: string): string | null => {
  try {
    new AsyncFunction(...CONTEXT_NAMES, `"use strict";\n${code}`)
    return null
  } catch (error) {
    return (error as Error).message
  }
}

describe('ego_click script codegen', () => {
  it('keeps the default mouse selector path unchanged', () => {
    const script = clickScript({ selector: '#submit', space: 's' })
    expect(compiles(script)).toBeNull()
    expect(script).toContain('await page.locator("#submit").click()')
    expect(script).not.toContain('Input.dispatchTouchEvent')
    expect(script).not.toContain('page.mouse.down')
    expect(script).not.toContain('setTimeout')
  })

  it('keeps the default coordinate mouse path unchanged', () => {
    const script = clickScript({ x: 10, y: 20, space: 's' })
    expect(compiles(script)).toBeNull()
    expect(script).toContain('await page.mouse.click(10, 20)')
    expect(script).not.toContain('Input.dispatchTouchEvent')
  })

  it('emits touchStart/touchEnd for touch=true and never a mouse move', () => {
    const script = clickScript({ selector: '#game', touch: true, space: 's' })
    expect(compiles(script)).toBeNull()
    expect(script).toContain('await page.elementCenter("#game")')
    expect(script).toContain("Input.dispatchTouchEvent")
    expect(script).toContain("type: 'touchStart'")
    expect(script).toContain("type: 'touchEnd'")
    expect(script).not.toContain('page.mouse')
    expect(script).not.toContain('mouse.move')
  })

  it('uses raw viewport coordinates for touch when no selector is given', () => {
    const script = clickScript({ x: 650, y: 470, touch: true, space: 's' })
    expect(script).toContain('const __p = { x: 650, y: 470 }')
    expect(script).not.toContain('elementCenter')
  })

  it('holds touch without emitting touchmove', () => {
    const script = clickScript({ x: 650, y: 470, touch: true, holdMs: 800, space: 's' })
    expect(compiles(script)).toBeNull()
    expect(script).toContain('setTimeout(r, 800)')
    expect(script).not.toContain('touchMove')
    expect(script).not.toContain('mouse.move')
  })

  it('holds a mouse press at the same point (move before down, never while down)', () => {
    const script = clickScript({ selector: '#hold', holdMs: 700, space: 's' })
    expect(compiles(script)).toBeNull()
    expect(script).toContain('await page.elementCenter("#hold")')
    expect(script).toContain('await page.mouse.move(__p.x, __p.y)')
    expect(script).toContain('await page.mouse.down()')
    expect(script).toContain('setTimeout(r, 700)')
    expect(script).toContain('await page.mouse.up()')
    expect(script.indexOf('mouse.move')).toBeLessThan(script.indexOf('mouse.down'))
  })

  it('repeats the tap for double with touch', () => {
    const script = clickScript({ x: 1, y: 2, touch: true, double: true, space: 's' })
    expect(script).toContain('__i < 2')
  })

  it('rejects an out-of-range holdMs instead of silently clamping', () => {
    expect(() => clickScript({ x: 1, y: 2, holdMs: -1, space: 's' })).toThrow(/between 0 and 5000/)
    expect(() => clickScript({ x: 1, y: 2, holdMs: 5001, space: 's' })).toThrow(/between 0 and 5000/)
    expect(() => clickScript({ x: 1, y: 2, holdMs: Number.NaN, space: 's' })).toThrow(/between 0 and 5000/)
  })

  it('still requires a selector or both coordinates', () => {
    expect(() => clickScript({ space: 's' })).toThrow(/provide either/)
    expect(() => clickScript({ x: 1, space: 's' })).toThrow(/provide either/)
  })
})
