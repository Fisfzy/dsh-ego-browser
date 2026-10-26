import type { BrowserSnapshot, BrowserTab } from '../browser-state.ts'
import { truncateCells } from './text.ts'

export interface PanelRow {
  text: string
  tone?: 'dim' | 'accent' | 'success' | 'warning' | 'error'
}

/**
 * Host `ui.Text` props for a row. dsh-TUI's themed Text resolves `color` as a
 * theme key (bare names such as 'red' resolve to nothing) and dims via
 * `dimColor`; every non-dim tone here is also a theme key.
 */
export function rowTextProps(row: PanelRow): { dimColor: boolean; color?: Exclude<PanelRow['tone'], 'dim'>; wrap: 'truncate' } {
  return row.tone === 'dim' || row.tone === undefined
    ? { dimColor: row.tone === 'dim', wrap: 'truncate' }
    : { dimColor: false, color: row.tone, wrap: 'truncate' }
}

export function panelTabs(snapshot: BrowserSnapshot): readonly BrowserTab[] {
  return (snapshot.spaces ?? []).flatMap(space => space.tabs)
}

export function hasHumanCheck(snapshot: BrowserSnapshot): boolean {
  return panelTabs(snapshot).some(tab => tab.humanCheck?.detected === true)
}

/** Pure, cell-bounded text layout. Selection scrolls within the available tab rows. */
export function layoutPanel(snapshot: BrowserSnapshot, width: number, height: number, selected: number): PanelRow[] {
  const rows: PanelRow[] = []
  const add = (text: string, tone?: PanelRow['tone']) => rows.push({ text: truncateCells(text, width), tone })
  const tabs = panelTabs(snapshot)
  const active = tabs.find(tab => tab.active)
  // Text-only panel: TUI has no image surface, so no preview/capture rows.
  add(snapshot.spaces?.length === 1 ? `◎ Agent Browser · ${snapshot.spaces[0]?.name ?? ''}` : '◎ Agent Browser', 'dim')
  if (snapshot.browser) add(snapshot.browser.running ? `◎ running${snapshot.browser.headless === undefined ? '' : snapshot.browser.headless ? ' · headless' : ' · windowed'}` : '◎ stopped', snapshot.browser.running ? 'success' : 'dim')
  if (active) {
    add(active.title || '(untitled)', 'accent')
    add(active.url, 'dim')
  }
  if (hasHumanCheck(snapshot)) add('! Human check · o to take over', 'warning')
  if (snapshot.activeTool) add(`▶ ${snapshot.activeTool.name} · ${snapshot.activeTool.summary}`, 'accent')
  if (snapshot.lastError) add(`! ${snapshot.lastError}`, 'error')
  const actions = snapshot.recent.slice(-Math.min(5, Math.max(3, height - rows.length - 6)))
  const tabBudget = Math.max(0, height - rows.length - actions.length - 3)
  const flattened = (snapshot.spaces ?? []).flatMap(space => space.tabs.map(tab => ({ tab, group: space.name })))
  const tabRows = Math.max(0, tabBudget - 1)
  const start = Math.max(0, Math.min(selected - tabRows + 1, flattened.length - tabRows))
  if (tabBudget > 0) {
    add(`Tabs (${tabs.length}) · ${snapshot.spaces?.length === 1 ? snapshot.spaces[0]?.name : 'groups'}`, 'dim')
    for (let i = start; i < Math.min(flattened.length, start + tabRows); i++) {
      const item = flattened[i]!
      const group = (snapshot.spaces?.length ?? 0) > 1 ? `[${item.group}] ` : ''
      add(`${i === selected ? '›' : ' '} ${item.tab.active ? '*' : ' '} ${group}${item.tab.title || item.tab.url}`, i === selected ? 'accent' : undefined)
    }
  }
  if (actions.length) add('Recent actions', 'dim')
  for (const action of actions) add(`${action.ok ? '✓' : '✗'} ${action.ms}ms ${action.name} · ${action.summary}`, action.ok ? 'success' : 'error')
  const hint: PanelRow = { text: truncateCells('↑↓ select · o open · x close · f login · r refresh', width), tone: 'dim' }
  return [...rows.slice(0, Math.max(0, height - 1)), hint].slice(0, Math.max(0, height))
}
