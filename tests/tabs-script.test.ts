import { describe, it, expect } from 'vitest'
import { tabsScript } from '../src/index.ts'

/**
 * Regression guard for issue #88.
 *
 * 0.9.7 generated the ego_tabs heredoc with `useSpace(...)` interpolated three
 * times per action (before the capability guard, inside its `if` branch and at
 * its tail), so `new AsyncFunction(code)` rejected the repeated block-scoped
 * `const task` and EVERY action failed with
 * `SyntaxError: Identifier 'task' has already been declared` — before the
 * browser was ever contacted.
 *
 * The runtime compiles the heredoc exactly like this
 * (`runtime/ego-browser/dist/out/index.js`):
 *   const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
 *   new AsyncFunction(...Object.keys(context), `"use strict";\n${code}`)
 * so the test reproduces the same compile step rather than pattern-matching
 * source text.
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

const TASK_DECL = /const task = await taskSpaces\.useOrCreate/g
const countTaskDecls = (code: string): number => (code.match(TASK_DECL) ?? []).length

const ACTIONS = [
  { action: 'list', args: {} },
  { action: 'switch', args: { targetId: 'ABC123' } },
  { action: 'open', args: { url: 'https://example.com' } },
  { action: 'close', args: { targetId: 'ABC123' } },
] as const

describe('ego_tabs script codegen (#88)', () => {
  it.each(ACTIONS)('compiles action=$action in the runtime harness', ({ action, args }) => {
    const script = tabsScript({ action, space: 'dsh-agent-probe', ...args })
    expect(compiles(script)).toBeNull()
  })

  it.each(ACTIONS)('declares the space pin exactly once for $action', ({ action, args }) => {
    const script = tabsScript({ action, space: 'dsh-agent-probe', ...args })
    expect(countTaskDecls(script)).toBe(1)
  })

  it('pins the space before the capability guard and outside both branches', () => {
    const script = tabsScript({ action: 'list', space: 'dsh-agent-probe' })
    const decl = script.indexOf('const task =')
    expect(decl).toBe(0)
    expect(script.indexOf('if (typeof browser')).toBeGreaterThan(decl)
    // The declaration must not reappear inside the if/else bodies.
    expect(script.slice(decl + 1)).not.toContain('const task =')
  })

  it('keeps the #87 capability messages for every action', () => {
    expect(tabsScript({ action: 'list', space: 's' })).toContain(
      'runtime capability missing: browser.listTabs',
    )
    expect(tabsScript({ action: 'switch', targetId: 'T', space: 's' })).toContain(
      'runtime capability missing: browser.switchTab / browser.listTabs',
    )
    expect(tabsScript({ action: 'open', space: 's' })).toContain(
      'runtime capability missing: ego.createTab / browser.listTabs',
    )
    expect(tabsScript({ action: 'close', targetId: 'T', space: 's' })).toContain(
      'runtime capability missing: browser.closeTab / browser.listTabs',
    )
  })

  it('still emits the per-action calls it did before the fix', () => {
    expect(tabsScript({ action: 'switch', targetId: 'T1', space: 's' })).toContain(
      'await browser.switchTab("T1")',
    )
    expect(tabsScript({ action: 'open', url: 'https://example.com', space: 's' })).toContain(
      'await ego.createTab("https://example.com")',
    )
    expect(tabsScript({ action: 'open', space: 's' })).toContain('await ego.createTab("about:blank")')
    expect(tabsScript({ action: 'close', targetId: 'T2', space: 's' })).toContain(
      'await browser.closeTab("T2")',
    )
    expect(tabsScript({ action: 'list', space: 's' })).toContain('await browser.listTabs()')
  })

  it('rejects switch/close without a targetId and unknown actions', () => {
    for (const action of ['switch', 'close']) {
      const script = tabsScript({ action, space: 's' })
      expect(compiles(script)).toBeNull()
      expect(script).toContain(`targetId is required for action=${action}`)
      // The early return must not carry a dangling else block.
      expect(script).not.toContain(' else {')
    }
    const unknown = tabsScript({ action: 'nope', space: 's' })
    expect(compiles(unknown)).toBeNull()
    expect(unknown).toContain('unknown action: nope')
  })

  it('escapes the space name and target id as JSON literals', () => {
    const script = tabsScript({ action: 'switch', targetId: 'a"b', space: 'sp ace' })
    expect(script).toContain('taskSpaces.useOrCreate("sp ace")')
    expect(script).toContain('browser.switchTab("a\\"b")')
    expect(compiles(script)).toBeNull()
  })
})
