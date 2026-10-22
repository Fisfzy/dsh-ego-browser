import { describe, expect, it, vi } from 'vitest'
import manifest from '../dsh-plugin.json'
import { resolveConfig } from '../src/config.ts'
import { BrowserStateStore } from '../src/browser-state.ts'
import { installTui } from '../src/tui/integration.ts'
import { manifestSettingsFields, tuiSettingsFields, tuiSettingsSection } from '../src/tui/settings.ts'
import type { EgoContext } from '../src/types.ts'

function host(services: Record<string, unknown>) {
  const cleanup: (() => void)[] = []
  const inject = vi.fn((names: readonly string[], cb: (ctx: EgoContext) => void) => {
    expect(names).toHaveLength(1)
    if (!(names[0]! in services)) return
    const child = { [names[0]!]: services[names[0]!], effect: (fn: () => unknown) => {
      const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose as () => void)
    } }
    cb(child as unknown as EgoContext)
  })
  return { ctx: { inject, get: () => { throw new Error('undeclared service access') } } as unknown as EgoContext,
    cleanup: () => cleanup.splice(0).reverse().forEach(fn => fn()), inject }
}

describe('optional TUI integration', () => {
  it('registers real bilingual settings from the manifest and valid select values', () => {
    const dispose = vi.fn(), register = vi.fn(() => dispose)
    const h = host({ tuiSettingsSections: { register } })
    installTui(h.ctx, new BrowserStateStore())
    expect(register).toHaveBeenCalledWith(tuiSettingsSection)
    expect(tuiSettingsSection).toMatchObject({ ns: 'ego-browser', title: 'Agent Browser', page: { id: 'ego-browser' } })
    expect(manifestSettingsFields).toEqual(manifest.contributes['x-dsh-tui'].find(section => section.kind === 'SettingsSection')!.spec.fields)
    expect(tuiSettingsFields.map(field => field.path[0])).toEqual(['isolateSpaces', 'idleTimeoutMin', 'residentExecutor', 'residentIdleMin', 'disableFrameRelay', 'chromePath', 'captureBackend', 'streamProfile', 'ffmpegPath', 'tuiAutoOpenPanel'])
    for (const field of tuiSettingsFields) {
      expect(field.descriptions?.zh).toBeTruthy()
      expect(field.hintDescriptions?.zh).toBeTruthy()
      for (const option of field.options ?? []) expect(resolveConfig({ [field.path[0]!]: option.value })[field.path[0] as 'streamProfile']).toBe(option.value)
    }
    expect(manifest.contributes['x-dsh-tui'].some(section => String(section.kind) === 'Scene')).toBe(false)
    h.cleanup(); expect(dispose).toHaveBeenCalledOnce()
  })
  it('keeps manifest fields inside the tui.dsh/v1alpha1 SettingsSection vocabulary', () => {
    // dsh-TUI's validateSettingsField rejects any other key, which makes the whole manifest invalid.
    const fieldKeys = new Set(['path', 'label', 'titles', 'hint', 'hintTitles', 'kind', 'options', 'placeholder', 'secretRef'])
    const optionKeys = new Set(['value', 'label', 'titles'])
    for (const field of manifestSettingsFields) {
      expect(Object.keys(field).filter(key => !fieldKeys.has(key))).toEqual([])
      for (const option of field.options ?? []) expect(Object.keys(option).filter(key => !optionKeys.has(key))).toEqual([])
    }
  })
  it('deduplicates unchanged status, displays action and error, and cleans subscriptions', () => {
    const dispose = vi.fn(), setField = vi.fn((_key: string, _text: string, _options: unknown) => dispose)
    const h = host({ tuiStatus: { setField } }), store = new BrowserStateStore()
    installTui(h.ctx, store)
    expect(setField).toHaveBeenLastCalledWith('ego-browser', '◎ idle', { slot: 'right-head', tone: 'dim', maxCells: 24, detail: 'Agent Browser is idle' })
    store.update({ browser: { running: true } })
    expect(setField).toHaveBeenCalledOnce()
    store.update({ lastError: 'previous failure' })
    store.startTool('ego_click', '#submit')
    expect(setField.mock.lastCall?.[2]).toMatchObject({ tone: 'accent', detail: 'ego_click · #submit | previous failure' })
    h.cleanup(); const count = setField.mock.calls.length
    store.startTool('ego_help', '')
    expect(setField).toHaveBeenCalledTimes(count)
    expect(dispose).toHaveBeenCalled()
  })
  it('does nothing without services and limits toast delivery to twenty per minute', () => {
    const absent = host({}), store = new BrowserStateStore()
    const inert = installTui(absent.ctx, store)
    expect(inert.hasToast()).toBe(false)
    inert.toast('unused', 'success')
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000), show = vi.fn()
    const h = host({ tuiToast: { show } }), tui = installTui(h.ctx, store)
    for (let n = 0; n < 25; n++) tui.toast('stopped', 'success')
    expect(show).toHaveBeenCalledTimes(20)
    expect(show).toHaveBeenLastCalledWith('stopped', { color: 'success', timeoutMs: 4000 })
    now.mockReturnValue(61000); tui.toast('failed', 'error')
    expect(show).toHaveBeenCalledTimes(21)
    h.cleanup(); expect(tui.hasToast()).toBe(false)
    tui.toast('ignored', 'warning'); expect(show).toHaveBeenCalledTimes(21)
    now.mockRestore()
  })
})


it('retains the latest tool error after a successful panel refresh clears transient errors', () => {
  const setField = vi.fn((_key: string, _text: string, _options: unknown) => () => {})
  const h = host({ tuiStatus: { setField } }), store = new BrowserStateStore()
  installTui(h.ctx, store)
  const token = store.startTool('ego_click', '#submit')
  store.finishTool(token, { ok: false, error: 'Click target was not found' })
  store.update({ browser: { running: true }, spaces: [], lastError: undefined })
  expect(setField.mock.lastCall?.[2]).toMatchObject({ detail: 'Click target was not found' })
  h.cleanup()
})
