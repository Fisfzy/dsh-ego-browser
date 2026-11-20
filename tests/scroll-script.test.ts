import { describe, it, expect } from 'vitest'
import { scrollScript } from '../src/index.ts'

/**
 * Compile the generated heredoc exactly like the runtime does, so a codegen
 * regression is caught before a browser is contacted (same harness as
 * click-script.test.ts).
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

/**
 * ego_scroll result contract.
 *
 * Regression context: the tool used to read `page.info()` only once, *after*
 * the wheel dispatch, and echo `scrollY` from it. Two things went wrong:
 *
 *  - `Input.dispatchMouseEvent` resolves when the event is dispatched, not when
 *    the compositor has applied the scroll, so the reported offset could still
 *    be the pre-scroll one. Callers saw scrollY advance one call late.
 *  - When the page was already at its scroll limit the offset never changed,
 *    yet the tool still answered `ok: true` with nothing distinguishing "moved"
 *    from "did not move".
 *
 * The script now captures before/after and reports `moved`/`settled`/`atEnd`.
 */
describe('ego_scroll script codegen', () => {
  it('keeps the default wheel path', () => {
    const script = scrollScript({ deltaY: 400, space: 's' })
    expect(compiles(script)).toBeNull()
    expect(script).toContain('await page.mouse.wheel(0, 400)')
  })

  it('keeps the selector path (scrollIntoViewIfNeeded) and does not wheel', () => {
    const script = scrollScript({ selector: '#target', space: 's' })
    expect(compiles(script)).toBeNull()
    expect(script).toContain('await page.locator("#target").scrollIntoViewIfNeeded()')
    expect(script).not.toContain('page.mouse.wheel')
  })

  it('defaults deltaY to 300 when only deltaX is given', () => {
    const script = scrollScript({ deltaX: 50, space: 's' })
    expect(compiles(script)).toBeNull()
    expect(script).toContain('await page.mouse.wheel(50, 300)')
  })

  it('rejects a call with neither a selector nor a delta', () => {
    const script = scrollScript({ space: 's' })
    expect(compiles(script)).toBeNull()
    expect(script).toContain('ok: false')
    expect(script).toContain('provide deltaX/deltaY or a selector')
    expect(script).not.toContain('page.mouse.wheel')
  })

  it('reads the offset before the action, not only after', () => {
    const script = scrollScript({ deltaY: 100, space: 's' })
    const beforeIdx = script.indexOf('const __s0 = await page.info()')
    const actionIdx = script.indexOf('await page.mouse.wheel')
    expect(beforeIdx).toBeGreaterThanOrEqual(0)
    expect(actionIdx).toBeGreaterThan(beforeIdx)
  })

  it('polls until two consecutive reads agree, bounded by a deadline', () => {
    const script = scrollScript({ deltaY: 100, space: 's' })
    expect(script).toContain('const __deadline = Date.now() + 400')
    expect(script).toContain('while (Date.now() < __deadline)')
    expect(script).toContain('__settled = true')
  })

  it('reports before/after, moved, settled, atEnd and applied deltas', () => {
    const script = scrollScript({ deltaY: 100, space: 's' })
    for (const field of [
      'before: { scrollX: __sx0, scrollY: __sy0 }',
      'after: { scrollX: __sx1, scrollY: __sy1 }',
      'moved: __moved',
      'settled: __settled',
      'atEnd: !__moved',
      'deltaY: __sy0 === null || __sy1 === null ? null : __sy1 - __sy0',
    ]) {
      expect(script).toContain(field)
    }
  })

  it('keeps scrollX/scrollY as the settled post-action offset', () => {
    const script = scrollScript({ deltaY: 100, space: 's' })
    expect(script).toContain('scrollX: __sx1, scrollY: __sy1')
  })

  it('never emits a bare ok:true without the offset evidence', () => {
    const script = scrollScript({ deltaY: 100, space: 's' })
    expect(script).toContain('ok: true')
    expect(script).toContain('moved:')
  })
})
