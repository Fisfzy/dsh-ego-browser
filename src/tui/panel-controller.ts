import type { BrowserSnapshot, BrowserStateStore, BrowserTab } from '../browser-state.ts'
import type { TaskSpaceGroup } from '../worker-client.ts'
import { sanitizeText } from './text.ts'

export interface PanelTransport {
  readTaskSpaceGroups?(): Promise<readonly TaskSpaceGroup[]>
  readBrowserState(): Promise<{ running: boolean; headless?: boolean }>
  ensureWorker(): Promise<number | null>
  get(port: number, path: string): Promise<unknown | null>
  post(port: number, path: string, body: unknown): Promise<{ status: number; body: unknown } | null>
}

/** The worker currently calls its flat target list `spaces`; do not invent task spaces. */
export function parseSpaces(value: unknown, groups: readonly TaskSpaceGroup[] = []): BrowserSnapshot['spaces'] {
  if (!value || typeof value !== 'object') return []
  const rows = (value as { spaces?: unknown }).spaces
  if (!Array.isArray(rows)) return []
  const parseTabs = (values: unknown[]): BrowserTab[] => values.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const tab = value as Record<string, unknown>
    if (typeof tab.targetId !== 'string') return []
    return [{ targetId: tab.targetId, url: sanitizeText(typeof tab.url === 'string' ? tab.url : ''), title: sanitizeText(typeof tab.title === 'string' ? tab.title : ''), active: tab.active === true, humanCheck: tab.humanCheck && typeof tab.humanCheck === 'object' && (tab.humanCheck as { detected?: unknown }).detected === true ? { detected: true, kind: typeof (tab.humanCheck as { kind?: unknown }).kind === 'string' ? sanitizeText((tab.humanCheck as { kind: string }).kind) : undefined } : undefined } as BrowserTab]
  })
  if (rows.some(row => row && typeof row === 'object' && Array.isArray(row.tabs))) {
    return rows.filter(row => row && typeof row === 'object' && Array.isArray(row.tabs)).map(row => ({ name: sanitizeText(typeof row.name === 'string' ? row.name : 'Unnamed space'), tabs: parseTabs(row.tabs) }))
  }
  const tabs = parseTabs(rows)
  const remaining = new Map(tabs.map(tab => [tab.targetId, tab]))
  const spaces = groups.flatMap(group => {
    const members = group.targetIds.flatMap(id => { const tab = remaining.get(id); if (!tab) return []; remaining.delete(id); return [tab] })
    return members.length ? [{ name: sanitizeText(group.name), tabs: members }] : []
  })
  if (!spaces.length) return [{ name: 'Global/default group', tabs }]
  if (remaining.size) spaces.push({ name: 'Unassigned / global', tabs: [...remaining.values()] })
  return spaces
}

export interface PanelController {
  setVisible(visible: boolean): void
  refresh(): Promise<void>
  close(targetId: string): Promise<void>
  flush(): Promise<void>
  dispose(): void
}

/** One lifecycle owner for polling; component hooks stop it immediately on hide/unmount. */
export function createPanelController(store: BrowserStateStore, config: { readonly disableFrameRelay: boolean }, transport: PanelTransport): PanelController {
  let disposed = false
  let visible = false
  let generation = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let pending: Promise<void> | undefined
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (config.disableFrameRelay) {
      store.update({ frameRelayDisabled: true, spaces: [], lastError: undefined })
      return Promise.resolve()
    }
    if (pending) return pending
    const epoch = generation
    pending = (async () => {
      const browser = await transport.readBrowserState()
      if (disposed || epoch !== generation || config.disableFrameRelay) return
      store.update({ browser, frameRelayDisabled: false })
      if (!browser.running) { store.update({ spaces: [] }); return }
      const port = await transport.ensureWorker()
      if (disposed || epoch !== generation || config.disableFrameRelay) return
      if (!port) { store.update({ lastError: 'Browser worker unavailable' }); return }
      const payload = await transport.get(port, '/api/spaces')
      if (disposed || epoch !== generation || config.disableFrameRelay) return
      const groups = payload ? await transport.readTaskSpaceGroups?.() ?? [] : []
      if (disposed || epoch !== generation || config.disableFrameRelay) return
      store.update(payload ? { spaces: parseSpaces(payload, groups), lastError: undefined } : { lastError: 'Could not refresh browser tabs' })
    })().catch(error => {
      if (!disposed && epoch === generation) store.update({ lastError: sanitizeText(String(error)) })
    }).finally(() => { pending = undefined })
    return pending
  }
  const post = async (path: string, body: unknown): Promise<void> => {
    if (disposed || config.disableFrameRelay) return
    const port = await transport.ensureWorker()
    if (!port || disposed || config.disableFrameRelay) return
    const result = await transport.post(port, path, body)
    if (disposed) return
    if (!result || result.status < 200 || result.status >= 300) {
      store.update({ lastError: path === '/api/close' ? 'Could not close tab' : 'Could not flush browser cookies' })
      return
    }
    await refresh()
  }
  let latest = store.getSnapshot().recent.at(-1)
  const unsubscribe = store.subscribe(() => {
    const next = store.getSnapshot().recent.at(-1)
    if (next === latest) return
    latest = next
    if (next) void refresh()
  })
  return {
    setVisible(next) {
      if (disposed || next === visible) return
      visible = next
      generation++
      if (timer) clearInterval(timer)
      timer = undefined
      if (visible) {
        void refresh()
        timer = setInterval(() => void refresh(), 2000)
      }
    },
    refresh,
    close: targetId => post('/api/close', { targetId }).catch(error => { if (!disposed) store.update({ lastError: sanitizeText(String(error)) }) }),
    flush: () => post('/api/flush', {}).catch(error => { if (!disposed) store.update({ lastError: sanitizeText(String(error)) }) }),
    dispose() {
      disposed = true
      generation++
      if (timer) clearInterval(timer)
      unsubscribe()
    },
  }
}
