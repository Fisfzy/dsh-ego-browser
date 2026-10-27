import { describe, it, expect } from 'vitest'
import {
  createSessionScopedSpaceTracker,
  scopedTargetKey,
  spaceNameForSession,
} from '../src/index.ts'
import { resolveConfig } from '../src/config.ts'

describe('session-scoped space names', () => {
  it('derives a stable per-session name', () => {
    expect(spaceNameForSession('session-faaebd59-1111-2222', 'dsh-agent', true)).toBe(
      'dsh-agent-faaebd59',
    )
  })

  it('keeps the base name when scoping is off or no session is known', () => {
    expect(spaceNameForSession('session-faaebd59', 'dsh-agent', false)).toBe('dsh-agent')
    expect(spaceNameForSession(undefined, 'dsh-agent', true)).toBe('dsh-agent')
    expect(spaceNameForSession('', 'dsh-agent', true)).toBe('dsh-agent')
  })

  it('sanitizes ids that would break a space name', () => {
    expect(spaceNameForSession('session-aa/bb cc!dd', 'dsh-agent', true)).toBe('dsh-agent-aabbccdd')
    expect(spaceNameForSession('!!!', 'dsh-agent', true)).toBe('dsh-agent')
  })
})

describe('session-scoped trackers', () => {
  it('gives each session its own default space', () => {
    const tracker = createSessionScopedSpaceTracker('dsh-agent', () => true)
    expect(tracker.forSession('session-aaaa1111').current()).toBe('dsh-agent-aaaa1111')
    expect(tracker.forSession('session-bbbb2222').current()).toBe('dsh-agent-bbbb2222')
  })

  it('keeps an explicit selection per session', () => {
    const tracker = createSessionScopedSpaceTracker('dsh-agent', () => true)
    const a = tracker.forSession('session-aaaa1111')
    const b = tracker.forSession('session-bbbb2222')
    a.selected('research')
    expect(a.current()).toBe('research')
    expect(b.current()).toBe('dsh-agent-bbbb2222')
  })

  it('resets a closed space to that session default, not another session’s', () => {
    const tracker = createSessionScopedSpaceTracker('dsh-agent', () => true)
    const a = tracker.forSession('session-aaaa1111')
    a.selected('research')
    a.closed('research', true)
    expect(a.current()).toBe('dsh-agent-aaaa1111')
    expect(tracker.forSession('session-bbbb2222').current()).toBe('dsh-agent-bbbb2222')
  })

  it('falls back to the shared space when scoping is disabled', () => {
    const tracker = createSessionScopedSpaceTracker('dsh-agent', () => false)
    expect(tracker.forSession('session-aaaa1111').current()).toBe('dsh-agent')
    expect(tracker.forSession('session-bbbb2222').current()).toBe('dsh-agent')
  })

  it('reads the scope flag live, so a settings flip affects new sessions', () => {
    let scoped = true
    const tracker = createSessionScopedSpaceTracker('dsh-agent', () => scoped)
    expect(tracker.forSession('session-aaaa1111').current()).toBe('dsh-agent-aaaa1111')
    scoped = false
    expect(tracker.forSession('session-cccc3333').current()).toBe('dsh-agent')
  })
})

describe('session-scoped tab cursor keys', () => {
  it('separates the same space across sessions', () => {
    expect(scopedTargetKey('session-a', 'dsh-agent')).not.toBe(
      scopedTargetKey('session-b', 'dsh-agent'),
    )
  })

  it('is stable within one session and space', () => {
    expect(scopedTargetKey('session-a', 'dsh-agent')).toBe(
      scopedTargetKey('session-a', 'dsh-agent'),
    )
  })

  it('handles an unknown session', () => {
    expect(scopedTargetKey(undefined, 'dsh-agent')).toBe('\u0000dsh-agent')
  })
})

describe('sessionScopedSpaces config', () => {
  it('defaults to on', () => {
    expect(resolveConfig({}).sessionScopedSpaces).toBe(true)
  })

  it('can be turned off explicitly', () => {
    expect(resolveConfig({ sessionScopedSpaces: false }).sessionScopedSpaces).toBe(false)
    expect(resolveConfig({ sessionScopedSpaces: 'false' as unknown as boolean }).sessionScopedSpaces).toBe(false)
    expect(resolveConfig({ sessionScopedSpaces: 0 as unknown as boolean }).sessionScopedSpaces).toBe(false)
  })
})
