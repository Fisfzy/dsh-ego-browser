import { describe, expect, it } from 'vitest'
import { decodePng } from '../src/tui/png.ts'

// Fixed 2x2 PNG fixtures with known pixels. Each fixture uses its numbered
// filter on both rows, so the first row/column and prior-row predictors run.
const rgbaFixtures = [
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGklEQVR4nGPgEpH7b2Ok0cBwYssCBxGNAAYAL2AFOuzF1YgAAAAASUVORK5CYII=',
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGklEQVR4nGPkEpH7byTH1ch4YssCB5+SDQcAMA0GpR3LFDAAAAAASUVORK5CYII=',
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGklEQVR4nGPiEpH7b2Ok0cC0b0GT441vGg0AM7UG7ddTXjQAAAAASUVORK5CYII=',
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAG0lEQVR4nGPmEpH7b64hych8eNXEg5O2vlkAADCRB00mB88zAAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGklEQVR4nGPhEpH7byTH1ciyb0GTo0/JhgMALtMGcC9MskUAAAAASUVORK5CYII=',
]
const rgba = [10, 20, 30, 255, 60, 50, 40, 128, 200, 180, 160, 64, 20, 40, 80, 0]

describe('PNG thumbnail decoder', () => {
  it.each(rgbaFixtures.map((png, filter) => ({ png, filter })))('decodes filter $filter and preserves RGBA channels', ({ png }) => {
    const image = decodePng(Buffer.from(png, 'base64'))
    expect(image.width).toBe(2)
    expect(image.height).toBe(2)
    expect([...image.data]).toEqual(rgba)
  })

  it('fills opaque alpha for RGB PNGs', () => {
    const image = decodePng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGP4z8DAAMIM/7lE5AAaWAM6VmOiPAAAAABJRU5ErkJggg==', 'base64'))
    expect([...image.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 255])
  })

  it('allocates independent frame buffers even when decoding the same PNG', () => {
    const bytes = Buffer.from(rgbaFixtures[0], 'base64')
    const first = decodePng(bytes)
    const next = decodePng(bytes)
    expect(first.data).not.toBe(next.data)
    first.data[0] = 99
    expect(next.data[0]).toBe(10)
  })

  it('rejects unsupported formats, truncated data and excessive dimensions', () => {
    const bytes = Buffer.from(rgbaFixtures[0], 'base64')
    const interlaced = Buffer.from(bytes)
    interlaced[28] = 1
    expect(() => decodePng(interlaced)).toThrow('unsupported PNG format')
    const oversized = Buffer.from(bytes)
    oversized.writeUInt32BE(100_000, 16)
    expect(() => decodePng(oversized)).toThrow('dimensions exceed limit')
    expect(() => decodePng(bytes.subarray(0, 48))).toThrow('truncated PNG')
  })
})
