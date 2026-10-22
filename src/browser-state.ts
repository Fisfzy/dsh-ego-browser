import { truncateCells } from './tui/text.ts'

export interface BrowserToolActivity { readonly name: string; readonly summary: string; readonly startedAt: number }
export interface BrowserToolResult {
  readonly name: string; readonly summary: string; readonly ok: boolean; readonly ms: number
  readonly error?: string; readonly at: number
}
export interface BrowserTab {
  readonly targetId: string; readonly url: string; readonly title: string; readonly active: boolean
  readonly humanCheck?: { readonly detected: boolean; readonly kind?: string }
}
export interface BrowserSpace { readonly name: string; readonly tabs: readonly BrowserTab[] }
export interface BrowserSnapshot {
  readonly version: number
  readonly activeTool?: BrowserToolActivity
  readonly recent: readonly BrowserToolResult[]
  readonly browser?: { readonly running: boolean; readonly headless?: boolean }
  readonly capture?: { readonly backend: string; readonly state: string; readonly code?: string }
  readonly spaces: readonly BrowserSpace[]
  readonly frameRelayDisabled: boolean
  readonly lastError?: string
}
type BrowserPatch = { -readonly [K in 'browser' | 'capture' | 'spaces' | 'frameRelayDisabled' | 'lastError']?: BrowserSnapshot[K] }

/** Pure per-activation state: no process, filesystem, network or timer ownership. */
export class BrowserStateStore {
  private snapshot: BrowserSnapshot = Object.freeze({ version: 0, recent: Object.freeze([]), spaces: Object.freeze([]), frameRelayDisabled: false })
  private readonly listeners = new Set<() => void>()
  private readonly running = new Map<number, BrowserToolActivity>()
  private nextToken = 0
  getSnapshot = (): BrowserSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private publish(patch: Partial<BrowserSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch, version: this.snapshot.version + 1 })
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* Presentation subscribers cannot fail browser tools. */ }
    }
  }
  startTool(name: string, summary: string, at = Date.now()): number {
    const token = ++this.nextToken
    const activeTool = Object.freeze({ name, summary: truncateCells(summary, 48), startedAt: at })
    this.running.set(token, activeTool)
    this.publish({ activeTool })
    return token
  }
  finishTool(token: number, outcome: { ok: boolean; error?: string }, at = Date.now()): void {
    const activity = this.running.get(token)
    if (!activity) return
    this.running.delete(token)
    const error = outcome.error ? truncateCells(outcome.error, 160) : undefined
    const item = Object.freeze({ name: activity.name, summary: activity.summary, ok: outcome.ok,
      ms: Math.max(0, at - activity.startedAt), at, ...(error ? { error } : {}) })
    this.publish({ activeTool: [...this.running.values()].at(-1),
      recent: Object.freeze([...this.snapshot.recent, item].slice(-10)),
      ...(error ? { lastError: error } : {}) })
  }
  update(patch: BrowserPatch): void {
    const next: BrowserPatch = { ...patch }
    if (patch.browser) next.browser = Object.freeze({ ...patch.browser })
    if (patch.capture) next.capture = Object.freeze({ ...patch.capture })
    if (patch.spaces) next.spaces = Object.freeze(patch.spaces.map(space => Object.freeze({ name: space.name,
      tabs: Object.freeze(space.tabs.map(tab => Object.freeze({ ...tab,
        ...(tab.humanCheck ? { humanCheck: Object.freeze({ ...tab.humanCheck }) } : {}) }))) })))
    if (patch.lastError !== undefined) next.lastError = truncateCells(patch.lastError, 160)
    if (Object.keys(next).every(key => JSON.stringify(this.snapshot[key as keyof BrowserSnapshot]) === JSON.stringify(next[key as keyof BrowserPatch]))) return
    this.publish(next)
  }
}
