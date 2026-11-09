import { describe, it, expect } from 'vitest'
import { NAVIGATE_REUSE_MODES, navigateScript, normalizeNavigateReuse } from '../src/index.ts'

/**
 * Compile the generated heredoc exactly like the runtime does
 * (`new AsyncFunction(...contextNames, code)`), so a codegen regression is
 * caught before a browser is ever contacted. Same harness as tabs-script.test.ts.
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

describe('ego_navigate script codegen', () => {
  it.each([...NAVIGATE_REUSE_MODES])('compiles reuse=%s', (reuse) => {
    const script = navigateScript({ url: 'https://example.com/a', reuse, space: 's' })
    expect(compiles(script)).toBeNull()
  })

  it('defaults to origin when the reuse value is unknown', () => {
    expect(normalizeNavigateReuse(undefined)).toBe('origin')
    expect(normalizeNavigateReuse('')).toBe('origin')
    expect(normalizeNavigateReuse('bogus')).toBe('origin')
    expect(normalizeNavigateReuse('EXACT')).toBe('exact')
    expect(navigateScript({ url: 'https://example.com', space: 's' })).toContain('const __reuse = "origin"')
  })

  it('reuses the exact URL without navigating', () => {
    const script = navigateScript({ url: 'https://example.com/a', reuse: 'exact', space: 's' })
    expect(script).toContain('__exact')
    expect(script).toContain("__reused = 'exact'")
    // The exact branch switches only; the fallback goto stays for the miss case.
    expect(script).toContain('if (__reused === \'none\') await page.goto')
  })

  it('navigates a same-host tab in place on origin reuse', () => {
    const script = navigateScript({ url: 'https://example.com/b', reuse: 'origin', space: 's' })
    expect(script).toContain('new URL(__url).host')
    expect(script).toContain('new URL(t.url).host === __host')
    expect(script).toContain('__reused = \'origin\'')
    // The same-origin tab must actually be navigated, not merely activated.
    expect(script).toMatch(/switchTab\(__same\.targetId\)[\s\S]*page\.goto/)
  })

  it('disables reuse entirely with reuse=none', () => {
    const script = navigateScript({ url: 'https://example.com/c', reuse: 'none', space: 's' })
    expect(script).not.toContain('__exact')
    expect(script).not.toContain('new URL')
    expect(script).toContain("reused: 'none'")
    expect(script).toContain('navigated: true')
  })

  it('reports a structured INVALID_ARGS failure for an empty URL', () => {
    const script = navigateScript({ url: '', space: 's' })
    expect(script).toContain("code: 'INVALID_ARGS'")
    expect(compiles(script)).toBeNull()
  })

  it('pins the task space exactly once and keeps the wait/timeout values', () => {
    const script = navigateScript({
      url: 'https://example.com',
      reuse: 'origin',
      wait: false,
      timeout: 1234,
      space: 'dsh-agent-probe',
    })
    expect((script.match(/const task = await taskSpaces\.useOrCreate/g) ?? []).length).toBe(1)
    expect(script).toContain('{ wait: false, timeout: 1234 }')
  })
})
