import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureSnapshot } from '../src/worker/snapshot.ts'
import { requestSnapshot } from '../src/worker-client.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAarVyFEAAAAASUVORK5CYII=', 'base64')

describe('one-shot worker snapshot', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('captures the scrolled viewport at the requested pixel width on the existing session', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ result: { value: { x: 12, y: 400, width: 1200, height: 800, dpr: 2 } } })
      .mockResolvedValueOnce({ data: png.toString('base64') })
    expect(await captureSnapshot({ call }, 'selected-tab', 300)).toEqual(png)
    expect(call.mock.calls.map(([targetId, method]) => [targetId, method])).toEqual([
      ['selected-tab', 'Runtime.evaluate'],
      ['selected-tab', 'Page.captureScreenshot'],
    ])
    expect(call.mock.calls[1][2]).toEqual({
      format: 'png', captureBeyondViewport: false,
      clip: { x: 12, y: 400, width: 1200, height: 800, scale: 0.125 },
    })
  })

  it('does not upscale small viewports or attempt capture without viewport dimensions', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ result: { value: { x: 0, y: 0, width: 200, height: 100, dpr: 1 } } })
      .mockResolvedValueOnce({ data: png.toString('base64') })
      .mockResolvedValueOnce({ result: {} })
    await captureSnapshot({ call }, 'small-tab', 300)
    expect(call.mock.calls[1][2].clip.scale).toBe(1)
    await expect(captureSnapshot({ call }, 'gone-tab', 300)).rejects.toThrow('viewport unavailable')
    expect(call).toHaveBeenCalledTimes(3)
  })

  it('fetches PNG bytes with encoded target IDs and preserves non-success responses', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(png, { headers: { 'content-type': 'image/png' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 409 }))
      .mockRejectedValueOnce(new Error('unreachable'))
    vi.stubGlobal('fetch', fetcher)
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    expect(await requestSnapshot(4321, 'tab & other', 320)).toEqual(new Uint8Array(png))
    expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:4321/api/snapshot?targetId=tab+%26+other&maxWidth=320')
    expect(timeout).toHaveBeenCalledWith(15_000)
    expect(await requestSnapshot(4321, 'missing', 320)).toBeNull()
    expect(await requestSnapshot(4321, 'missing', 320)).toBeNull()
  })
})
