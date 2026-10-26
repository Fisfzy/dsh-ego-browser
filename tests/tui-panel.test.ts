import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserStateStore } from '../src/browser-state.ts'
import { createPanelController, parseSpaces } from '../src/tui/panel-controller.ts'
import { hasHumanCheck, layoutPanel, rowTextProps } from '../src/tui/panel-layout.ts'
import { displayWidth } from '../src/tui/text.ts'

const tabs = Array.from({ length: 9 }, (_, i) => ({ targetId: String(i), title: `全中文网页标题很长需要按显示宽度截断${i}`, url: `https://example.org/${'long-url/'.repeat(15)}${i}`, active: i === 0 }))
const transport = () => ({ readTaskSpaceGroups: vi.fn(async () => []), readBrowserState: vi.fn(async () => ({ running: true, headless: true })), ensureWorker: vi.fn(async () => 1234), get: vi.fn(async () => ({ spaces: tabs })), post: vi.fn(async () => ({ status: 200, body: { ok: true } })) })

afterEach(() => vi.useRealTimers())

describe('browser panel layout', () => {
  it('fits 28 columns with long URLs, Chinese titles, and selected last tab', () => {
    const store = new BrowserStateStore()
    store.update({ browser: { running: true, headless: true }, spaces: [{ name: 'Global/default group', tabs }] })
    const rows = layoutPanel(store.getSnapshot(), 28, 12, 8)
    expect(rows.length).toBeLessThanOrEqual(12)
    expect(rows.every(row => displayWidth(row.text) <= 28)).toBe(true)
    expect(rows.some(row => row.text.startsWith('›'))).toBe(true)
    expect(rows[0]?.text).toContain('Global')
    expect(rows.some(row => row.text.startsWith('Capture'))).toBe(false)
    expect(layoutPanel(store.getSnapshot(), 1, 1, 8).every(row => displayWidth(row.text) <= 1)).toBe(true)
  })
  it('preserves real groups but labels the existing flat worker data honestly', () => {
    expect(parseSpaces({ spaces: tabs })?.[0]?.name).toBe('Global/default group')
    expect(parseSpaces({ spaces: [{ name: 'Research', tabs }] })?.[0]?.name).toBe('Research')
    const store = new BrowserStateStore()
    store.update({ spaces: parseSpaces({ spaces: [{ ...tabs[0], humanCheck: { detected: false } }] }) })
    expect(hasHumanCheck(store.getSnapshot())).toBe(false)
    store.update({ spaces: parseSpaces({ spaces: [{ ...tabs[0], humanCheck: { detected: true, kind: 'captcha' } }] }) })
    expect(hasHumanCheck(store.getSnapshot())).toBe(true)
  })
  it('groups live tabs by exact persisted target ids and labels unknown tabs separately', () => {
    const groups = [{ name: 'Research', targetIds: ['0', 'gone'] }, { name: 'Writing', targetIds: ['1'] }]
    const spaces = parseSpaces({ spaces: tabs.slice(0, 3) }, groups)!
    expect(spaces.map(space => space.name)).toEqual(['Research', 'Writing', 'Unassigned / global'])
    expect(spaces.map(space => space.tabs.map(tab => tab.targetId))).toEqual([['0'], ['1'], ['2']])
    expect(parseSpaces({ spaces: tabs.slice(0, 1) }, [{ name: 'Stale', targetIds: ['gone'] }])?.[0]?.name).toBe('Global/default group')
  })

  it('shows recent success and failure with elapsed time and safe truncation', () => {
    const store = new BrowserStateStore()
    for (let i = 0; i < 6; i++) {
      const token = store.startTool('ego_click', `选择中文内容${i}`, 100)
      store.finishTool(token, { ok: i !== 5 }, 125)
    }
    const rows = layoutPanel(store.getSnapshot(), 28, 20, 0)
    expect(rows.filter(row => /[✓✗]/u.test(row.text))).toHaveLength(5)
    expect(rows.some(row => row.text.startsWith('✗ 25ms'))).toBe(true)
    expect(rows.every(row => displayWidth(row.text) <= 28)).toBe(true)
  })
})

describe('browser panel lifecycle', () => {
  it('polls only while visible, refreshes once on a hidden tool completion, and disposes', async () => {
    vi.useFakeTimers()
    const store = new BrowserStateStore(), wire = transport()
    const controller = createPanelController(store, { disableFrameRelay: false }, wire)
    await vi.advanceTimersByTimeAsync(6000)
    expect(wire.get).not.toHaveBeenCalled()
    controller.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(wire.get).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4000)
    expect(wire.get).toHaveBeenCalledTimes(3)
    controller.setVisible(false)
    await vi.advanceTimersByTimeAsync(6000)
    expect(wire.get).toHaveBeenCalledTimes(3)
    const token = store.startTool('ego_click', '#submit')
    store.finishTool(token, { ok: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(wire.get).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(6000)
    expect(wire.get).toHaveBeenCalledTimes(4)
    controller.dispose()
    const last = store.startTool('ego_click', '#submit')
    store.finishTool(last, { ok: true })
    await vi.advanceTimersByTimeAsync(6000)
    expect(wire.get).toHaveBeenCalledTimes(4)
  })
  it('keeps tab metadata available when the frame relay is disabled (text-only TUI)', async () => {
    const store = new BrowserStateStore(), wire = transport()
    const controller = createPanelController(store, { disableFrameRelay: true }, wire)
    controller.setVisible(true)
    await controller.refresh()
    expect(wire.readBrowserState).toHaveBeenCalled()
    expect(wire.readTaskSpaceGroups).toHaveBeenCalled()
    expect(wire.ensureWorker).toHaveBeenCalled()
    expect(wire.get).toHaveBeenCalledWith(1234, '/api/spaces')
    expect(store.getSnapshot().spaces[0]?.tabs).toHaveLength(9)
    expect(store.getSnapshot().frameRelayDisabled).toBe(false)
    controller.dispose()
  })
  it('does not continue an in-flight visible refresh after hiding', async () => {
    let release!: (state: { running: boolean; headless: boolean }) => void
    const store = new BrowserStateStore(), wire = transport()
    wire.readBrowserState.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const controller = createPanelController(store, { disableFrameRelay: false }, wire)
    controller.setVisible(true)
    controller.setVisible(false)
    release({ running: true, headless: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(wire.ensureWorker).not.toHaveBeenCalled()
    controller.dispose()
  })
  it('keeps one tool-completion refresh when an older visible refresh is canceled by hiding', async () => {
    vi.useFakeTimers()
    const store = new BrowserStateStore(), wire = transport()
    let release!: (state: { running: boolean; headless: boolean }) => void
    wire.readBrowserState.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const controller = createPanelController(store, { disableFrameRelay: false }, wire)
    controller.setVisible(true)
    controller.setVisible(false)
    const token = store.startTool('ego_click', '#submit')
    store.finishTool(token, { ok: true })
    release({ running: true, headless: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(wire.readBrowserState).toHaveBeenCalledTimes(2)
    expect(wire.get).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().spaces[0]?.tabs).toHaveLength(9)
    await vi.advanceTimersByTimeAsync(6000)
    expect(wire.get).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('does not start a worker for a stopped browser, and posts explicit selected targets', async () => {
    const store = new BrowserStateStore(), wire = transport()
    wire.readBrowserState.mockResolvedValue({ running: false, headless: false })
    const controller = createPanelController(store, { disableFrameRelay: false }, wire)
    await controller.refresh()
    expect(wire.ensureWorker).not.toHaveBeenCalled()
    await controller.close('selected-tab')
    expect(wire.post).toHaveBeenCalledWith(1234, '/api/close', { targetId: 'selected-tab' })
    await controller.flush()
    expect(wire.post).toHaveBeenCalledWith(1234, '/api/flush', {})
    controller.dispose()
  })
})

import { installBrowserPanel } from '../src/tui/panel.ts'
import type { EgoContext } from '../src/types.ts'
import type { TuiPanelProps, TuiPanelKeyEvent } from '../src/tui/types.ts'

function installHarness(services: Record<string, unknown> = {}) {
  const cleanups: (() => void)[] = []
  const ctx = {
    inject(names: string[], callback: (context: unknown) => void) {
      if (names.every(name => name in services)) callback({ ...services, effect: (effect: () => () => void) => cleanups.push(effect()) })
    },
  } as unknown as EgoContext
  const store = new BrowserStateStore(), wire = transport()
  const bridge = { toast: vi.fn(), hasToast: () => true, setStatusOverride: vi.fn((value?: { tone?: string; onClick?: () => void }) => {}) }
  const dependencies = { createTransport: vi.fn(() => wire), openAgentWindow: vi.fn(async () => ({ ok: true })) }
  return { ctx, store, wire, bridge, dependencies, dispose: () => cleanups.reverse().forEach(cleanup => cleanup()) }
}

describe('optional panel integration', () => {
  it('does no additional I/O or polling without tuiPanels', () => {
    const h = installHarness()
    installBrowserPanel(h.ctx, { disableFrameRelay: false, tuiAutoOpenPanel: false }, h.store, h.bridge, h.dependencies)
    h.store.startTool('ego_click', '#submit')
    expect(h.dependencies.createTransport).not.toHaveBeenCalled()
    expect(h.bridge.toast).not.toHaveBeenCalled()
  })
  it('badges the first tool without auto-opening, and warns once per human-check edge', () => {
    const panels = { register: vi.fn((descriptor: unknown) => vi.fn()), list: () => [{ id: 'owned:browser', title: 'Agent Browser' }], open: vi.fn(), badge: vi.fn() }
    const h = installHarness({ tuiPanels: panels })
    installBrowserPanel(h.ctx, { disableFrameRelay: false, tuiAutoOpenPanel: false }, h.store, h.bridge, h.dependencies)
    expect(panels.register.mock.calls[0]?.[0]).toMatchObject({ apiVersion: 1, id: 'browser', minColumns: 28 })
    h.store.startTool('ego_click', '#submit')
    expect(panels.badge).toHaveBeenCalledWith('owned:browser', { level: 'info', unread: 1 })
    expect(panels.open).not.toHaveBeenCalled()
    const spaces = [{ name: 'Global/default group', tabs: [{ ...tabs[0]!, humanCheck: { detected: true } }] }]
    h.store.update({ spaces })
    h.store.update({ browser: { running: true } })
    expect(h.bridge.toast).toHaveBeenCalledTimes(1)
    expect(panels.badge).toHaveBeenLastCalledWith('owned:browser', { level: 'warning', unread: 1 })
    expect(h.bridge.setStatusOverride).toHaveBeenLastCalledWith(expect.objectContaining({ tone: 'warning', onClick: expect.any(Function) }))
    h.store.update({ spaces: [] })
    h.store.update({ spaces })
    expect(h.bridge.toast).toHaveBeenCalledTimes(2)
    h.dispose()
  })
  it('uses the owned full id for opt-in opening and throttles status clicks', () => {
    vi.useFakeTimers()
    const panels = { register: vi.fn((descriptor: unknown) => vi.fn()), list: () => [{ id: 'owned:browser', title: 'Agent Browser' }], open: vi.fn(), badge: vi.fn() }
    const h = installHarness({ tuiPanels: panels })
    installBrowserPanel(h.ctx, { disableFrameRelay: false, tuiAutoOpenPanel: true }, h.store, h.bridge, h.dependencies)
    h.store.startTool('ego_click', '#submit')
    expect(panels.open).toHaveBeenCalledWith('owned:browser')
    h.store.update({ spaces: [{ name: 'Global', tabs: [{ ...tabs[0]!, humanCheck: { detected: true } }] }] })
    const click = h.bridge.setStatusOverride.mock.calls.at(-1)?.[0]?.onClick
    click?.()
    expect(panels.open).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5000)
    click?.()
    expect(panels.open).toHaveBeenCalledTimes(2)
    h.dispose()
  })
})

/** A small hook runner exercises the host-owned React boundary without importing React. */
function hookHost() {
  const cells: unknown[] = [], effects: { deps?: readonly unknown[]; cleanup?: () => void }[] = []
  let cursor = 0
  const scheduled: (() => void)[] = []
  const React = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useState(initial: unknown) {
      const index = cursor++
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
      return [cells[index], (value: unknown) => { cells[index] = typeof value === 'function' ? value(cells[index]) : value }]
    },
    useRef(initial: unknown) {
      const index = cursor++
      if (!(index in cells)) cells[index] = { current: initial }
      return cells[index]
    },
    useEffect(effect: () => (() => void) | undefined, deps?: readonly unknown[]) {
      const index = cursor++
      if (effects[index]?.deps && deps && deps.every((value, i) => Object.is(value, effects[index]?.deps?.[i])) && deps.length === effects[index]?.deps?.length) return
      scheduled.push(() => { effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: effect() } })
    },
  } as unknown as TuiPanelProps['React']
  return { React, render(component: (props: TuiPanelProps) => unknown, props: Omit<TuiPanelProps, 'React'>) { cursor = 0; const tree = component({ ...props, React }); scheduled.splice(0).forEach(run => run()); return tree }, unmount() { effects.forEach(effect => effect?.cleanup?.()) } }
}

it('uses host keys for selection, takeover, refresh, flush, and double-press close', async () => {
  const panels = { register: vi.fn((descriptor: { component: (props: TuiPanelProps) => unknown }) => vi.fn()), list: () => [{ id: 'owned:browser', title: 'Agent Browser' }], open: vi.fn(), badge: vi.fn() }
  const h = installHarness({ tuiPanels: panels })
  installBrowserPanel(h.ctx, { disableFrameRelay: false, tuiAutoOpenPanel: false }, h.store, h.bridge, h.dependencies)
  h.store.update({ spaces: [{ name: 'Global', tabs }] })
  const renderer = hookHost()
  let listener: ((event: TuiPanelKeyEvent) => void) | undefined
  const off = vi.fn(() => { listener = undefined })
  const props = { ui: { Box: 'div' as const, Text: 'span' as const, Image: 'img' as const }, host: { notify: vi.fn(), onKey: (handler: typeof listener) => { listener = handler; return off } }, width: 28, height: 10, visible: true, focused: true, mode: 'split' as const }
  const component = panels.register.mock.calls[0]![0].component
  const render = () => renderer.render(component, props)
  const key = (input: string, flags: TuiPanelKeyEvent['key'] = {}) => { const preventDefault = vi.fn(); listener?.({ input, key: flags, preventDefault }); return preventDefault }
  render()
  await vi.waitFor(() => expect(h.wire.get).toHaveBeenCalled())
  render()
  expect(key('q')).not.toHaveBeenCalled()
  expect(key('', { downArrow: true })).toHaveBeenCalledOnce()
  render()
  key('x'); render()
  expect(h.wire.post).not.toHaveBeenCalled()
  key('x')
  await vi.waitFor(() => expect(h.wire.post).toHaveBeenCalledWith(1234, '/api/close', { targetId: '1' }))
  render()
  key('o'); key('f'); key('r')
  await vi.waitFor(() => expect(h.wire.post).toHaveBeenCalledWith(1234, '/api/flush', {}))
  expect(h.dependencies.openAgentWindow).toHaveBeenCalledOnce()
  props.focused = false
  render()
  expect(listener).toBeUndefined()
  renderer.unmount()
  h.dispose()
})

it('requires the available host dialog confirmation before closing a tab', async () => {
  const panels = { register: vi.fn((descriptor: { component: (props: TuiPanelProps) => unknown }) => vi.fn()), list: () => [{ id: 'owned:browser', title: 'Agent Browser' }], open: vi.fn(), badge: vi.fn() }
  const confirm = vi.fn(async () => false)
  const h = installHarness({ tuiPanels: panels, tuiDialogs: { confirm } })
  installBrowserPanel(h.ctx, { disableFrameRelay: false, tuiAutoOpenPanel: false }, h.store, h.bridge, h.dependencies)
  h.store.update({ spaces: [{ name: 'Global', tabs }] })
  const renderer = hookHost()
  let listener: ((event: TuiPanelKeyEvent) => void) | undefined
  const props = { ui: { Box: 'div' as const, Text: 'span' as const, Image: 'img' as const }, host: { notify: vi.fn(), onKey: (handler: typeof listener) => { listener = handler; return () => { listener = undefined } } }, width: 28, height: 10, visible: true, focused: true, mode: 'split' as const }
  renderer.render(panels.register.mock.calls[0]![0].component, props)
  listener?.({ input: 'x', key: {}, preventDefault: vi.fn() })
  await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce())
  expect(h.wire.post).not.toHaveBeenCalled()
  renderer.unmount(); h.dispose()
})

it('maps row tones to dsh-TUI theme keys and dimColor', () => {
  // Themed Text treats `color` as a theme key; bare names like 'red' resolve to nothing.
  expect(rowTextProps({ text: 'a', tone: 'error' })).toEqual({ dimColor: false, color: 'error', wrap: 'truncate' })
  expect(rowTextProps({ text: 'a', tone: 'warning' })).toEqual({ dimColor: false, color: 'warning', wrap: 'truncate' })
  expect(rowTextProps({ text: 'a', tone: 'success' })).toEqual({ dimColor: false, color: 'success', wrap: 'truncate' })
  expect(rowTextProps({ text: 'a', tone: 'accent' })).toEqual({ dimColor: false, color: 'accent', wrap: 'truncate' })
  expect(rowTextProps({ text: 'a', tone: 'dim' })).toEqual({ dimColor: true, wrap: 'truncate' })
  expect(rowTextProps({ text: 'a' })).toEqual({ dimColor: false, wrap: 'truncate' })
})

vi.mock('../src/worker-client.ts', () => ({
  requestSnapshot: vi.fn(async () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGklEQVR4nGPgEpH7b2Ok0cBwYssCBxGNAAYAL2AFOuzF1YgAAAAASUVORK5CYII=', 'base64')),
}))

it('renders a text-only panel (no Image element) and unsubscribes when hidden', async () => {
  const panels = { register: vi.fn((descriptor: { component: (props: TuiPanelProps) => unknown }) => vi.fn()), list: () => [{ id: 'owned:browser', title: 'Agent Browser' }], open: vi.fn(), badge: vi.fn() }
  const h = installHarness({ tuiPanels: panels })
  installBrowserPanel(h.ctx, { disableFrameRelay: false, tuiAutoOpenPanel: false }, h.store, h.bridge, h.dependencies)
  h.store.update({ spaces: [{ name: 'Global', tabs }] })
  const renderer = hookHost()
  const props = { ui: { Box: 'div' as const, Text: 'span' as const, Image: 'img' as const }, host: { notify: vi.fn(), onKey: () => () => {} }, width: 28, height: 20, visible: true, focused: true, mode: 'split' as const }
  const component = panels.register.mock.calls[0]![0].component
  const originalSubscribe = h.store.subscribe
  const unsubscribe = vi.fn()
  h.store.subscribe = vi.fn(listener => { const off = originalSubscribe(listener); return () => { unsubscribe(); off() } })
  type Element = { type: string; props: Record<string, any>; children: Element[] }
  const tree = renderer.render(component, props) as Element
  expect(tree.type).toBe('div')
  expect(tree.children.length).toBeGreaterThan(0)
  expect(tree.children.every(child => child.type === 'span')).toBe(true)
  expect(tree.children.some(child => child.type === 'img')).toBe(false)
  props.visible = false
  renderer.render(component, props)
  expect(unsubscribe).toHaveBeenCalledOnce()
  props.visible = true
  renderer.render(component, props)
  expect(h.store.subscribe).toHaveBeenCalledTimes(2)
  renderer.unmount(); h.dispose()
})
