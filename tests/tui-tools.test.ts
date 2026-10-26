import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { apply } from '../src/index.ts'
import type { EgoContext, SpawnSpec, ToolExec } from '../src/types.ts'

vi.mock('../src/ffmpeg-installation.ts', () => ({
  getSharedFfmpegInstallationManager: () => ({ check: async () => ({}) }),
}))
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(), readFile: vi.fn(),
}))

type RegisteredTool = {
  name: string
  execute(args: Record<string, unknown>, exec: ToolExec): Promise<unknown>
  presentCall(args: Record<string, unknown>): { title: string; rawInput: unknown }
}
function reader(text: string) { return { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) } }
function bench(options: { idle?: boolean; services?: boolean } = {}) {
  const tools = new Map<string, RegisteredTool>(), cleanup: (() => void)[] = []
  const setField = vi.fn((_key: string, _text: string, _options: unknown) => () => {})
  const show = vi.fn()
  const spawn = vi.fn((_spec: SpawnSpec) => ({ done: Promise.resolve({ exitCode: 0, signal: null }),
    collected: { stdout: reader('@@DSH_RESULT@@{"ok":true}'), stderr: reader('') } }))
  const ctx = {
    tools: { register: (tool: RegisteredTool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    subprocess: { spawn },
    effect: (factory: () => unknown, label?: string) => {
      // Exercise the existing reaper without running the unrelated legacy teardown effect.
      if (label === 'ego-browser: idle reaper') {
        const dispose = factory(); if (typeof dispose === 'function') cleanup.push(dispose as () => void)
      }
    },
    inject: (names: readonly string[], callback: (ctx: unknown) => void) => {
      if (options.services === false) return
      const service = names[0] === 'tuiStatus' ? { tuiStatus: { setField } }
        : names[0] === 'tuiToast' ? { tuiToast: { show } } : undefined
      if (service) callback({ ...service, effect: (factory: () => unknown) => {
        const dispose = factory(); if (typeof dispose === 'function') cleanup.push(dispose as () => void)
      } })
    },
  }
  apply(ctx as unknown as EgoContext, { chromePath: '/fake/chrome', idleTimeoutMin: options.idle ? 0.5 : 0 })
  const exec = { signal: new AbortController().signal, callId: 'test', name: '', arguments: {} } as ToolExec
  return { tools, spawn, setField, show,
    call: (name: string, args: Record<string, unknown> = {}) => tools.get(name)!.execute(args, exec),
    dispose: () => cleanup.reverse().forEach(fn => fn()) }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.mocked(readFile).mockReset() })

describe('registered browser tools with TUI observers', () => {
  it('registers ego_tabs and builds list/switch/open/close scripts', async () => {
    const b = bench()
    expect(b.tools.has('ego_tabs')).toBe(true)
    await b.call('ego_tabs', { action: 'list' })
    await b.call('ego_tabs', { action: 'switch', targetId: 'T1' })
    await b.call('ego_tabs', { action: 'open', url: 'https://example.com' })
    await b.call('ego_tabs', { action: 'close', targetId: 'T2' })
    const specs = b.spawn.mock.calls.map(call => JSON.stringify(call[0])).join('\n')
    expect(specs).toContain('browser.listTabs')
    expect(specs).toContain('browser.switchTab')
    expect(specs).toContain('ego.createTab')
    expect(specs).toContain('browser.closeTab')
    b.dispose()
  })

  it('presents shared titles, observes standalone help, and preserves outputs without spawning', async () => {
    const b = bench()
    expect(b.tools.get('ego_fill')!.presentCall({ selector: '#email', text: 'SECRET' })).toMatchObject({ title: 'ego_fill · #email', rawInput: null })
    expect(b.tools.get('ego_script')!.presentCall({ script: 'SECRET' }).title).toBe('ego_script')
    const result = await b.call('ego_help')
    expect(result).toMatchObject({ ok: true, topic: 'overview' })
    expect(b.setField.mock.calls.some(call => call[1] === '◎ ego_help')).toBe(true)
    expect(b.spawn).not.toHaveBeenCalled()
    expect(b.show).not.toHaveBeenCalled()
    b.dispose()
    const absent = bench({ services: false })
    await absent.call('ego_help')
    expect(absent.spawn).not.toHaveBeenCalled()
    expect(absent.setField).not.toHaveBeenCalled()
    absent.dispose()
  })
  it('starts observing a queued action only after it acquires the existing lock', async () => {
    const b = bench()
    let release!: (value: { exitCode: number; signal: null }) => void
    b.spawn.mockImplementationOnce(() => ({ done: new Promise(resolve => { release = resolve }),
      collected: { stdout: reader('@@DSH_RESULT@@{"ok":true}'), stderr: reader('') } }))
    const first = b.call('ego_click', { selector: '#one' })
    await vi.waitFor(() => expect(b.spawn).toHaveBeenCalledOnce())
    const second = b.call('ego_click', { selector: '#two' })
    await Promise.resolve()
    expect(b.setField.mock.lastCall?.[2]).toMatchObject({ detail: 'ego_click · #one' })
    release({ exitCode: 0, signal: null })
    await first; await second
    expect(b.setField.mock.calls.some(call => (call[2] as { detail?: string }).detail === 'ego_click · #two')).toBe(true)
    b.dispose()
  })
  it('only announces a cold-start failure after all retries, preserving the rejection', async () => {
    vi.useFakeTimers()
    const b = bench()
    b.spawn.mockImplementation(() => ({ done: Promise.resolve({ exitCode: 1, signal: null }),
      collected: { stdout: reader(''), stderr: reader('CDP channel is not open') } }))
    const failed = b.call('ego_click', { selector: '#submit' }).catch(error => error)
    await vi.advanceTimersByTimeAsync(599)
    expect(b.show).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1800)
    expect(await failed).toBeInstanceOf(Error)
    expect(b.spawn).toHaveBeenCalledTimes(3)
    expect(b.show).toHaveBeenCalledTimes(1)
    expect(b.show.mock.lastCall?.[0]).toContain('could not start after retrying')
    b.spawn.mockImplementation(() => ({ done: Promise.resolve({ exitCode: 1, signal: null }),
      collected: { stdout: reader(''), stderr: reader('element not found') } }))
    await expect(b.call('ego_click', { selector: '#missing' })).rejects.toThrow('element not found')
    expect(b.show).toHaveBeenCalledTimes(1)
    b.dispose()
  })
  it('only announces an idle stop when a live process has actually stopped', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000)
    vi.mocked(readFile).mockResolvedValue('{"pid":98765}')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const b = bench({ idle: true })
    await b.call('ego_click', { selector: '#submit' })
    kill.mockImplementationOnce(() => true).mockImplementationOnce(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(b.spawn.mock.lastCall?.[0].argv).toContain('--stop')
    expect(b.show).toHaveBeenCalledWith('Agent Browser stopped after the idle timeout.', { color: 'success', timeoutMs: 4000 })
    b.dispose()
    const calls = b.spawn.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(b.spawn).toHaveBeenCalledTimes(calls)
    const stillRunning = bench({ idle: true })
    kill.mockImplementation(() => true)
    await stillRunning.call('ego_click', { selector: '#again' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(stillRunning.show).not.toHaveBeenCalled()
    stillRunning.dispose()
  })
})
