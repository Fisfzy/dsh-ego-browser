import { describe, it, expect } from 'vitest'
import { waitForHumanScript } from '../src/index.ts'

describe('waitForHumanScript', () => {
  it('polls the challenge probe at the requested cadence', () => {
    const script = waitForHumanScript('dsh-agent', { timeoutMs: 30_000, pollMs: 1_500 })
    expect(script).toContain('page.evaluate(')
    expect(script).toContain('await page.waitForTimeout(1500)')
    expect(script).toContain('Date.now() - __wb >= 30000')
  })

  it('returns as soon as the challenge is gone when no selector is given', () => {
    const script = waitForHumanScript('dsh-agent', { timeoutMs: 10_000, pollMs: 500 })
    expect(script).toContain('const __selOk = true')
    expect(script).not.toContain('page.count(')
  })

  it('also waits for the follow-up selector when one is given', () => {
    const script = waitForHumanScript('dsh-agent', {
      timeoutMs: 10_000,
      pollMs: 500,
      selector: '#account-menu',
    })
    expect(script).toContain('page.count("#account-menu")')
    expect(script).toContain('__selOk')
  })

  it('reports a structured payload instead of throwing', () => {
    const script = waitForHumanScript('dsh-agent', { timeoutMs: 10_000, pollMs: 500 })
    expect(script).toContain('resolved: __resolved')
    expect(script).toContain('needed: __saw')
    expect(script).toContain('waitedMs: Date.now() - __wb')
  })

  it('starts from a real tab like every other page tool', () => {
    const script = waitForHumanScript('dsh-agent', { timeoutMs: 10_000, pollMs: 500 })
    expect(script).toContain('taskSpaces.useOrCreate')
    expect(script).toContain('browser.switchTab')
  })
})
