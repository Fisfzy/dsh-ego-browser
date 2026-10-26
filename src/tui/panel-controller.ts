import type { BrowserSnapshot, BrowserStateStore, BrowserTab } from '../browser-state.ts'
import type { TaskSpaceGroup } from '../worker-client.ts'
import { sanitizeText, truncateCells } from './text.ts'

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

/** Optional capture status comes from the existing spaces response, never a new request. */
export function parseCapture(value: unknown): BrowserSnapshot['capture'] {
  if (!value || typeof value !== 'object') return undefined
  const capture = (value as { capture?: unknown }).capture
  if (!capture || typeof capture !== 'object') return undefined
  const fields = capture as Record<string, unknown>
  if (typeof fields.backend !== 'string' || typeof fields.state !== 'string') return undefined
  return { backend: truncateCells(sanitizeText(fields.backend), 40), state: truncateCells(sanitizeText(fields.state), 40),
    ...(typeof fields.code === 'string' ? { code: truncateCells(sanitizeText(fields.code), 40) } : {}) }
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
  let queued = false
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    // The TUI panel is text-only and never displays frames, so metadata
    // (tabs/spaces/status) must keep working even when the web preview relay is
    // disabled. disableFrameRelay only affects frame/snapshot delivery.
    if (pending) { queued = true; return pending }
    const epoch = generation
    pending = (async () => {
      const browser = await transport.readBrowserState()
      if (disposed || epoch !== generation) return
      store.update({ browser, frameRelayDisabled: false })
      if (!browser.running) { store.update({ spaces: [], capture: undefined }); return }
      const port = await transport.ensureWorker()
      if (disposed || epoch !== generation) return
      if (!port) { store.update({ lastError: 'Browser worker unavailable' }); return }
      const payload = await transport.get(port, '/api/spaces')
      if (disposed || epoch !== generation) return
      const groups = payload ? await transport.readTaskSpaceGroups?.() ?? [] : []
      if (disposed || epoch !== generation) return
      store.update(payload ? { spaces: parseSpaces(payload, groups), capture: parseCapture(payload), lastError: undefined } : { lastError: 'Could not refresh browser tabs' })
    })().catch(error => {
      if (!disposed && epoch === generation) store.update({ lastError: sanitizeText(String(error)) })
    }).finally(() => {
      pending = undefined
      if (queued) { queued = false; void refresh() }
    })
    return pending
  }
  const post = async (path: string, body: unknown): Promise<void> => {
    if (disposed) return
    const port = await transport.ensureWorker()
    if (!port || disposed) return
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
      if (!visible) queued = false
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
      queued = false
      generation++
      if (timer) clearInterval(timer)
      unsubscribe()
    },
  }
}
