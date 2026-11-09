import { describe, it, expect } from 'vitest'
import { classifyEgoFailure, failureValue } from '../src/errors.ts'

describe('classifyEgoFailure', () => {
  it('treats user control as a hard stop that must not be retried', () => {
    const failure = classifyEgoFailure('ego_click', 'user is controlling this task space')
    expect(failure.code).toBe('USER_CONTROLLING')
    expect(failure.retry).toBe('never')
    expect(failure.actionSent).toBe(false)
  })

  it('marks a stale task space as retryable and not sent', () => {
    const failure = classifyEgoFailure('ego_snapshot', 'task space not found: 7')
    expect(failure.code).toBe('SPACE_STALE')
    expect(failure.retry).toBe('retry')
    expect(failure.actionSent).toBe(false)
  })

  it('classifies a cold channel as BROWSER_DOWN, not a locator failure', () => {
    const failure = classifyEgoFailure('ego_navigate', 'CDP channel is not open yet')
    expect(failure.code).toBe('BROWSER_DOWN')
    expect(failure.retry).toBe('retry')
  })

  it('maps a locator timeout to reobserve with actionSent for an action tool', () => {
    const failure = classifyEgoFailure('ego_click', 'Timeout 3000ms exceeded waiting for locator')
    expect(failure.code).toBe('TIMEOUT')
    expect(failure.retry).toBe('reobserve')
    expect(failure.actionSent).toBe(true)
    expect(failure.hint).toContain('不要原样重试')
  })

  it('keeps actionSent false for read-only tools', () => {
    const failure = classifyEgoFailure('ego_snapshot', 'Timed out reading the page')
    expect(failure.code).toBe('TIMEOUT')
    expect(failure.actionSent).toBe(false)
  })

  it('classifies missing elements as LOCATOR_NOT_FOUND', () => {
    const failure = classifyEgoFailure('ego_fill', 'element not found for selector "#q"')
    expect(failure.code).toBe('LOCATOR_NOT_FOUND')
    expect(failure.retry).toBe('reobserve')
  })

  it('classifies a dialog block and points at ego_dialog', () => {
    const failure = classifyEgoFailure('ego_click', 'blocked by a dialog')
    expect(failure.code).toBe('DIALOG_BLOCKING')
    expect(failure.hint).toContain('ego_dialog')
  })

  it('treats invalid arguments as never-retry and not sent', () => {
    const failure = classifyEgoFailure('ego_click', 'ego_click: provide either `selector` or `x`/`y`')
    expect(failure.code).toBe('INVALID_ARGS')
    expect(failure.retry).toBe('never')
    expect(failure.actionSent).toBe(false)
  })

  it('falls back to UNKNOWN with an observe-first hint', () => {
    const failure = classifyEgoFailure('ego_drag', 'something unexpected happened')
    expect(failure.code).toBe('UNKNOWN')
    expect(failure.retry).toBe('reobserve')
  })

  it('failureValue is a canonical ok:false value, not a thrown error', () => {
    const value = failureValue('ego_navigate', 'net::ERR_NAME_NOT_RESOLVED')
    expect(value.ok).toBe(false)
    expect(value.code).toBe('NAVIGATION_FAILED')
    expect(value.error).toContain('ERR_NAME_NOT_RESOLVED')
  })
})
