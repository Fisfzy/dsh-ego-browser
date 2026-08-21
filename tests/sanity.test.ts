import { describe, it, expect } from 'vitest'
import { SENTINEL, j, str, num, bool } from '../src/util.ts'

describe('sanity', () => {
  it('vitest transforms TS', () => {
    const x: number = 1 + 2
    expect(x).toBe(3)
  })

  it('util helpers work', () => {
    expect(SENTINEL).toBe('@@DSH_RESULT@@')
    expect(j({ a: 1 })).toBe('{"a":1}')
    expect(str('x', 'd')).toBe('x')
    expect(str('', 'd')).toBe('d')
    expect(num(5, 0)).toBe(5)
    expect(num(NaN, 0)).toBe(0)
    expect(bool(true, false)).toBe(true)
    expect(bool(1 as unknown, false)).toBe(false)
  })
})
