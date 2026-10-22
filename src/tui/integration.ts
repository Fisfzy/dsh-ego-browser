import type { EgoContext } from '../types.ts'
import type { BrowserStateStore } from '../browser-state.ts'
import type { TuiStatusTone } from './types.ts'
import { installTuiSettings } from './settings.ts'
import { truncateCells } from './text.ts'

export interface TuiStatusOverride { text: string; tone: TuiStatusTone; detail: string; onClick?: () => void }
export interface TuiBridge {
  toast(text: string, color: 'success' | 'warning' | 'error'): void
  hasToast(): boolean
  setStatusOverride(value?: TuiStatusOverride): void
}
/** Service discovery stays inside independently injected activation scopes. */
export function installTui(ctx: EgoContext, store: BrowserStateStore): TuiBridge {
  installTuiSettings(ctx)
  let override: TuiStatusOverride | undefined
  let refreshStatus: (() => void) | undefined
  let deliverToast: TuiBridge['toast'] | undefined
  ctx.inject?.(['tuiStatus'], sctx => {
    let previous = ''
    let previousClick: (() => void) | undefined
    let disposeField: (() => void) | undefined
    const render = (): void => {
      const snapshot = store.getSnapshot()
      const active = snapshot.activeTool
      const lastError = snapshot.lastError ?? snapshot.recent.findLast(result => result.error)?.error
      const text = override?.text ?? (active ? `◎ ${active.name}` : '◎ idle')
      const tone = override?.tone ?? (active ? 'accent' : 'dim')
      const detail = truncateCells(override?.detail ?? (active
        ? [[active.name, active.summary].filter(Boolean).join(' · '), lastError].filter(Boolean).join(' | ')
        : lastError ?? 'Agent Browser is idle'), 160)
      const key = JSON.stringify([text, tone, detail])
      if (key === previous && previousClick === override?.onClick) return
      previous = key
      previousClick = override?.onClick
      disposeField?.()
      disposeField = sctx.tuiStatus!.setField('ego-browser', text, {
        slot: 'right-head', tone, maxCells: 24, detail,
        ...(override?.onClick ? { onClick: override.onClick } : {}),
      })
    }
    refreshStatus = render
    render()
    const off = store.subscribe(render)
    sctx.effect?.(() => () => {
      off()
      disposeField?.()
      if (refreshStatus === render) refreshStatus = undefined
    })
  })
  ctx.inject?.(['tuiToast'], sctx => {
    let sent: number[] = []
    const deliver: TuiBridge['toast'] = (text, color) => {
      const now = Date.now()
      sent = sent.filter(at => now - at < 60_000)
      if (sent.length >= 20) return
      sent.push(now)
      try { sctx.tuiToast!.show(truncateCells(text, 200), { color, timeoutMs: 4000 }) } catch { /* Optional presentation must not fail browser operations. */ }
    }
    deliverToast = deliver
    sctx.effect?.(() => () => { if (deliverToast === deliver) deliverToast = undefined })
  })
  return {
    toast: (text, color) => deliverToast?.(text, color),
    hasToast: () => deliverToast !== undefined,
    setStatusOverride: value => { override = value; refreshStatus?.() },
  }
}
