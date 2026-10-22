import { describe, expect, it, vi } from 'vitest'
import { BrowserStateStore } from '../src/browser-state.ts'
import { displayWidth, sanitizeText, truncateCells } from '../src/tui/text.ts'
import { safeLocatorSummary, toolCallTitle } from '../src/tui/presentation.ts'

describe('safe tool presentation', () => {
  it('shows only eligible locators and strips URL credentials, query and fragment', () => {
    expect(toolCallTitle('ego_navigate', { url: 'https://user:secret@github.com/foo?token=private#secret' })).toBe('ego_navigate · github.com/foo')
    expect(toolCallTitle('ego_fill', { selector: '#email', text: 'private@example.org' })).toBe('ego_fill · #email')
    expect(toolCallTitle('ego_http', { url: 'https://example.org/api', headers: { Authorization: 'secret' }, body: 'secret' })).toBe('ego_http · example.org/api')
    for (const name of ['ego_key', 'ego_js', 'ego_script', 'ego_cli', 'ego_cdp', 'ego_dialog']) {
      expect(toolCallTitle(name, { text: 'SECRET', key: 'SECRET', script: 'SECRET', expression: 'SECRET', code: 'SECRET', params: { secret: 'SECRET' }, selector: 'SECRET' })).toBe(name)
    }
    expect(toolCallTitle('ego_download', { triggerSelector: '#download', triggerScript: 'SECRET', savePath: 'SECRET' })).toBe('ego_download · #download')
    expect(safeLocatorSummary('ego_navigate', { url: 'javascript:SECRET' })).toBe('')
    for (const invalid of [null, undefined, 42, true, 'SECRET', []]) {
      expect(toolCallTitle('ego_click', invalid)).toBe('ego_click')
    }
  })
  it('removes terminal escapes and respects display cells and graphemes', () => {
    expect(sanitizeText('\x1b[31mred\x1b[0m\n\x1b]8;;https://secret\x07link\x1b]8;;\x07')).toBe('red link')
    expect(displayWidth('汉字e\u0301👨‍👩‍👧‍👦🇨🇳')).toBe(9)
    expect(displayWidth('  tab  ')).toBe(7)
    expect(truncateCells('  tab  ', 7)).toBe('  tab  ')
    expect(truncateCells('汉字e\u0301👨‍👩‍👧‍👦', 6)).toBe('汉字é…')
    expect(displayWidth(safeLocatorSummary('ego_click', { selector: '汉'.repeat(40) }))).toBeLessThanOrEqual(48)
    expect(truncateCells('👨‍👩‍👧‍👦abc', 2)).toBe('…')
  })
})

describe('BrowserStateStore', () => {
  it('owns immutable snapshots, stable references and a bounded completion history', () => {
    const store = new BrowserStateStore(), first = store.getSnapshot()
    expect(store.getSnapshot()).toBe(first)
    const listener = vi.fn(), off = store.subscribe(listener)
    const token = store.startTool('ego_click', '#submit', 100)
    const active = store.getSnapshot()
    expect(active.activeTool).toEqual({ name: 'ego_click', summary: '#submit', startedAt: 100 })
    store.finishTool(token, { ok: false, error: '坏'.repeat(200) }, 155)
    expect(store.getSnapshot().recent[0]).toMatchObject({ ok: false, ms: 55, at: 155 })
    expect(displayWidth(store.getSnapshot().lastError!)).toBeLessThanOrEqual(160)
    expect(first.recent).toEqual([])
    expect(Object.isFrozen(active.activeTool)).toBe(true)
    off()
    for (let n = 0; n < 12; n++) store.finishTool(store.startTool('ego_help', '', n), { ok: true }, n + 1)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().recent).toHaveLength(10)
    const spaces = [{ name: 'default', tabs: [{ targetId: '1', url: 'https://example.org', title: 'Example', active: true, humanCheck: { detected: true } }] }]
    store.update({ spaces })
    const snapshot = store.getSnapshot()
    spaces[0]!.tabs[0]!.humanCheck.detected = false
    expect(snapshot.spaces[0]!.tabs[0]!.humanCheck?.detected).toBe(true)
    expect(Object.isFrozen(snapshot.spaces[0]!.tabs[0])).toBe(true)
    store.update({ frameRelayDisabled: false })
    expect(store.getSnapshot()).toBe(snapshot)
  })
  it('keeps another in-flight action active and isolates presentation failures', () => {
    const store = new BrowserStateStore()
    store.subscribe(() => { throw new Error('disposed UI') })
    const a = store.startTool('ego_click', '#a'), b = store.startTool('ego_script', '')
    store.finishTool(b, { ok: true })
    expect(store.getSnapshot().activeTool?.name).toBe('ego_click')
    store.finishTool(a, { ok: true })
    expect(store.getSnapshot().activeTool).toBeUndefined()
  })
})
