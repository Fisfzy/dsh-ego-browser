import { describe, it, expect, vi } from 'vitest'
import { deliverToSession } from '../src/index.ts'

const ctxWithTurn = (turn: number | undefined) =>
  ({
    get: (name: string) =>
      name === 'sessionProjections'
        ? { stateOf: () => (turn === undefined ? undefined : { lastTurn: turn }) }
        : undefined,
  }) as never

const execWith = (append: unknown) =>
  ({ callId: 'call-42', agent: { session: { append } } }) as never

describe('deliverToSession', () => {
  it('appends the same event the present tool emits', () => {
    const append = vi.fn()
    const ok = deliverToSession(ctxWithTurn(7), execWith(append), [
      { path: '/tmp/shot.png', description: 'Screenshot' },
    ])
    expect(ok).toBe(true)
    expect(append).toHaveBeenCalledWith('deliverables/presented', {
      turn: 7,
      callId: 'call-42',
      files: [{ path: '/tmp/shot.png', description: 'Screenshot' }],
    })
  })

  it('does nothing without files', () => {
    const append = vi.fn()
    expect(deliverToSession(ctxWithTurn(7), execWith(append), [])).toBe(false)
    expect(append).not.toHaveBeenCalled()
  })

  it('does nothing when the call has no initiating agent', () => {
    const append = vi.fn()
    expect(deliverToSession(ctxWithTurn(7), { callId: 'c' } as never, [{ path: '/tmp/a' }])).toBe(false)
    expect(append).not.toHaveBeenCalled()
  })

  it('does nothing when the session cannot append', () => {
    expect(
      deliverToSession(ctxWithTurn(7), { callId: 'c', agent: { session: {} } } as never, [
        { path: '/tmp/a' },
      ]),
    ).toBe(false)
  })

  it('does nothing when the turn projection is unavailable', () => {
    const append = vi.fn()
    expect(deliverToSession(ctxWithTurn(undefined), execWith(append), [{ path: '/tmp/a' }])).toBe(false)
    expect(append).not.toHaveBeenCalled()
  })

  it('does nothing when the host has no projection service', () => {
    const append = vi.fn()
    expect(deliverToSession({} as never, execWith(append), [{ path: '/tmp/a' }])).toBe(false)
    expect(append).not.toHaveBeenCalled()
  })

  it('never lets a delivery failure break the tool call', () => {
    const append = vi.fn(() => {
      throw new Error('session closed')
    })
    expect(deliverToSession(ctxWithTurn(3), execWith(append), [{ path: '/tmp/a' }])).toBe(false)
  })
})

describe('deliverable wiring', () => {
  it('screenshot and download tools declare a deliver callback', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'),
    )
    expect(source).toContain("description: selector === '' ? 'Screenshot'")
    expect(source).toContain('`Download: ${name}`')
    expect(source).toContain('deliverToSession(ctx, exec, opts.deliverFiles(args, result.value))')
  })
})
