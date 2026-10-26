import type { EgoContext } from '../types.ts'
import type { BrowserStateStore } from '../browser-state.ts'
import { createPanelController, type PanelTransport } from './panel-controller.ts'
import { hasHumanCheck, layoutPanel, panelTabs, rowTextProps } from './panel-layout.ts'
import { truncateCells } from './text.ts'
import type { TuiBridge } from './integration.ts'
import type { TuiPanelProps, TuiPanelsService, TuiDialogsService, TuiPanelHost } from './types.ts'

interface PanelConfig {
  readonly disableFrameRelay: boolean
  readonly tuiAutoOpenPanel: boolean
}

/** All optional services are resolved in their own declared injection scope. */
export function installBrowserPanel(ctx: EgoContext, config: PanelConfig, store: BrowserStateStore, tui: TuiBridge, dependencies: {
  createTransport(): PanelTransport
  openAgentWindow(): Promise<{ ok: boolean; error?: string }>
}): void {
  let dialogs: TuiDialogsService | undefined
  ctx.inject?.(['tuiDialogs'], dctx => {
    dialogs = (dctx as EgoContext & { tuiDialogs?: TuiDialogsService }).tuiDialogs
    dctx.effect?.(() => () => { dialogs = undefined })
  })
  ctx.inject?.(['tuiPanels'], pctx => {
    const panels = (pctx as EgoContext & { tuiPanels?: TuiPanelsService }).tuiPanels
    if (!panels) return
    const transport = dependencies.createTransport()
    const controller = createPanelController(store, config, transport)
    let host: TuiPanelHost | undefined
    let disposed = false
    let firstTool = false
    let previousHuman = false
    let lastOpen = -Infinity
    let panelId = ''
    const openPanel = () => {
      if (!panelId || disposed || Date.now() - lastOpen < 5000) return
      lastOpen = Date.now()
      panels.open(panelId)
    }
    const notify = (level: 'info' | 'warning') => {
      if (host) host.notify(level, 1)
      else if (panelId) panels.badge(panelId, { level, unread: 1 })
    }
    const onSnapshot = () => {
      const snapshot = store.getSnapshot()
      if (!firstTool && snapshot.activeTool) {
        firstTool = true
        notify('info')
        if (config.tuiAutoOpenPanel) openPanel()
      }
      const human = hasHumanCheck(snapshot)
      if (human && !previousHuman) {
        notify('warning')
        tui.toast('Browser needs human verification. Press o in Agent Browser to take over.', 'warning')
      }
      if (human !== previousHuman) {
        previousHuman = human
        tui.setStatusOverride(human ? { text: '◎ human check', tone: 'warning', detail: 'Human verification required. Open Agent Browser, then press o to take over.', onClick: openPanel } : undefined)
      }
    }
    const unsubscribe = store.subscribe(onSnapshot)
    function BrowserPanel(props: TuiPanelProps) {
      const { React, ui } = props
      const [snapshot, setSnapshot] = React.useState(store.getSnapshot)
      // Selection is kept by targetId, not by list index: tabs can be added,
      // removed, or reordered while the panel is open (agent activity, task
      // space changes, idle reaper), and an index would then point at a
      // different tab — x/o could close or open the wrong page.
      const [selectedId, setSelectedId] = React.useState<string | undefined>(undefined)
      const [closeArmed, setCloseArmed] = React.useState<string | undefined>(undefined)
      const [message, setMessage] = React.useState('')
      const closing = React.useRef(false)
      const mounted = React.useRef(true)
      React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
      React.useEffect(() => {
        if (!props.visible) return
        setSnapshot(store.getSnapshot())
        return store.subscribe(() => setSnapshot(store.getSnapshot()))
      }, [props.visible])
      React.useEffect(() => {
        host = props.host
        return () => { if (host === props.host) host = undefined }
      }, [props.host])
      React.useEffect(() => {
        controller.setVisible(props.visible)
        return () => controller.setVisible(false)
      }, [props.visible])
      const tabs = panelTabs(snapshot)
      let selection = tabs.findIndex(tab => tab.targetId === selectedId)
      if (selection < 0) selection = tabs.findIndex(tab => tab.active)
      if (selection < 0) selection = 0
      const targetId = tabs[selection]?.targetId
      const move = (delta: number) => {
        if (tabs.length === 0) return
        const next = Math.max(0, Math.min(tabs.length - 1, selection + delta))
        const id = tabs[next]?.targetId
        if (id) setSelectedId(id)
        setCloseArmed(undefined)
      }
      React.useEffect(() => { setCloseArmed(undefined) }, [targetId, props.visible, props.focused])
      React.useEffect(() => {
        if (!props.visible || !props.focused) return
        return props.host.onKey(event => {
          if (event.key.ctrl || event.key.meta) return
          let action: (() => void) | undefined
          if (event.key.upArrow) action = () => move(-1)
          else if (event.key.downArrow) action = () => move(1)
          else if (event.input === 'o') action = () => {
            setCloseArmed(undefined)
            void dependencies.openAgentWindow().then(result => { if (!disposed && mounted.current && !result.ok) setMessage(result.error || 'Could not open browser window') }).catch(error => { if (!disposed && mounted.current) setMessage(String(error)) })
          }
          else if (event.input === 'r') action = () => { setCloseArmed(undefined); void controller.refresh() }
          else if (event.input === 'f') action = () => { setCloseArmed(undefined); void controller.flush() }
          else if (event.input === 'x' && targetId) action = () => {
            if (closing.current) return
            if (!dialogs && closeArmed !== targetId) { setCloseArmed(targetId); return }
            closing.current = true
            void (async () => {
              const confirmed = dialogs ? await dialogs.confirm({ title: 'Close browser tab?', message: truncateCells(tabs[selection]?.title || tabs[selection]?.url || targetId, 200), confirmLabel: 'Close tab', cancelLabel: 'Keep tab' }) : true
              if (confirmed && !disposed && mounted.current) await controller.close(targetId)
            })().finally(() => { closing.current = false; if (mounted.current) setCloseArmed(undefined) })
          }
          if (!action) { setCloseArmed(undefined); return }
          event.preventDefault()
          action()
        })
      }, [props.host, props.visible, props.focused, snapshot, selection, closeArmed, targetId])
      const rows = layoutPanel(snapshot, props.width, props.height, selection)
      if (closeArmed && rows.length) rows[rows.length - 1] = { text: truncateCells('Press x again to close this tab', props.width), tone: 'warning' }
      else if (message && rows.length) rows[rows.length - 1] = { text: truncateCells(message, props.width), tone: 'error' }
      return React.createElement(ui.Box, { flexDirection: 'column', width: props.width, height: props.height }, ...rows.map((row, index) => React.createElement(ui.Text, { key: index, ...rowTextProps(row) }, row.text)))
    }
    const unregister = panels.register({ apiVersion: 1, id: 'browser', title: 'Agent Browser', icon: '◎', minColumns: 28, component: BrowserPanel })
    // register prefixes the plugin id, while open/badge require that full owned id.
    panelId = panels.list().find(panel => panel.id.endsWith(':browser'))?.id ?? ''
    pctx.effect?.(() => () => {
      disposed = true
      controller.dispose()
      unsubscribe()
      tui.setStatusOverride(undefined)
      if (typeof unregister === 'function') unregister()
    })
  })
}
