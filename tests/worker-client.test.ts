import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.ts'
import { knownWorkerState, makeEnsureWorker, proxyFrom, proxyPost, readBrowserState, readTaskSpaceGroups } from '../src/worker-client.ts'

describe('shared worker client', () => {
  let stateDir: string

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'ego-worker-client-'))
    vi.stubEnv('EGO_LINUX_STATE_DIR', stateDir)
    await mkdir(join(stateDir, 'ego-lite-linux'))
  })
  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    await rm(stateDir, { recursive: true, force: true })
  })

  it('reads browser liveness from the existing state directory without launching a worker', async () => {
    expect(await readBrowserState()).toEqual({ running: false })
    await writeFile(join(stateDir, 'browser.json'), JSON.stringify({ pid: process.pid, headless: true }))
    expect(await readBrowserState()).toEqual({ running: true, headless: true })
    await writeFile(join(stateDir, 'browser.json'), JSON.stringify({ pid: -1, headless: false }))
    expect(await readBrowserState()).toEqual({ running: false, headless: false })
    await writeFile(join(stateDir, 'browser.json'), 'invalid')
    expect(await readBrowserState()).toEqual({ running: false })
  })

  it('reads task-space membership without creating or modifying state, and tolerates absent or malformed metadata', async () => {
    expect(await readTaskSpaceGroups()).toEqual([])
    await writeFile(join(stateDir, 'task-spaces.json'), JSON.stringify({ spaces: [
      { name: 'Research', targetIds: ['a', 'b'] }, { name: 'Writing', targetIds: ['c', 123] }, { name: 'Broken' },
    ] }))
    expect(await readTaskSpaceGroups()).toEqual([{ name: 'Research', targetIds: ['a', 'b'] }, { name: 'Writing', targetIds: ['c'] }])
    await writeFile(join(stateDir, 'task-spaces.json'), '{partial write')
    expect(await readTaskSpaceGroups()).toEqual([])
  })

  it('keeps construction lazy and failed launches throttled for eight seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(100_000)
    const spawn = vi.fn(() => { throw new Error('browser unavailable') })
    const ensure = makeEnsureWorker({ subprocess: { spawn } } as never, resolveConfig({}), null)
    expect(spawn).not.toHaveBeenCalled()
    expect(await ensure()).toBeNull()
    expect(await ensure()).toBeNull()
    vi.setSystemTime(108_000)
    expect(await ensure()).toBeNull()
    expect(spawn).toHaveBeenCalledTimes(1)
    vi.setSystemTime(108_001)
    expect(await ensure()).toBeNull()
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('reuses the live worker and preserves the existing cast-state path', async () => {
    await writeFile(join(stateDir, 'ego-lite-linux', 'ego-cast.json'), JSON.stringify({ port: 41234, pid: process.pid }))
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({ workerOk: true })))
    vi.stubGlobal('fetch', fetcher)
    const spawn = vi.fn()
    const ensure = makeEnsureWorker({ subprocess: { spawn } } as never, resolveConfig({}), null)
    expect(await knownWorkerState()).toEqual({ port: 41234, pid: process.pid })
    expect(await ensure()).toBe(41234)
    expect(spawn).not.toHaveBeenCalled()
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://127.0.0.1:41234/api/health')
  })

  it('preserves GET failure semantics, POST status, and default/custom timeouts', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('{"spaces":[]}'))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response('not json', { status: 409 }))
      .mockRejectedValueOnce(new Error('unreachable'))
    vi.stubGlobal('fetch', fetcher)
    expect(await proxyFrom(1234, '/api/spaces')).toEqual({ spaces: [] })
    expect(await proxyFrom(1234, '/api/spaces')).toBeNull()
    expect(await proxyPost(1234, '/api/close', { targetId: 'closed' }, 1700)).toEqual({ status: 409, body: { ok: false, error: 'worker returned 409' } })
    expect(await proxyPost(1234, '/api/flush', {})).toBeNull()
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([4000, 4000, 1700, 4000])
  })
})
