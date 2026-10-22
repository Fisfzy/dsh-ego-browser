/** Minimal structural contracts copied from dsh-tui-ref/src/dsh-adapter/status.ts. */
export type TuiStatusTone = 'dim' | 'accent' | 'success' | 'warning' | 'error'
export interface TuiStatusOptions {
  slot?: 'left-tail' | 'right-head' | 'right-tail'
  tone?: TuiStatusTone
  maxCells?: number
  detail?: string
  onClick?: () => void
}
export interface TuiStatusService {
  setField(key: string, text: string | undefined, options?: TuiStatusOptions): () => void
}
/** dsh-tui-ref/src/dsh-adapter/toast.ts; host owns transient delivery. */
export interface TuiToastService {
  show(text: string, options?: { color?: 'success' | 'warning' | 'error'; timeoutMs?: number }): unknown
}
/** dsh-tui-ref/src/adapter/ports/channel-settings.ts, lines 215–335. */
export interface TuiSettingsField {
  path: readonly string[]
  label: string
  descriptions?: Record<string, string>
  hint?: string
  hintDescriptions?: Record<string, string>
  kind: 'boolean' | 'number' | 'text' | 'select'
  options?: readonly { value: string; label: string; descriptions?: Record<string, string> }[]
}
export interface TuiSettingsSection {
  ns: string
  title: string
  descriptions?: Record<string, string>
  page?: { id: string; title: string; descriptions?: Record<string, string> }
  fields: readonly TuiSettingsField[]
}
export interface TuiSettingsSectionsService { register(section: TuiSettingsSection): () => void }

/** Minimal panel contracts: dsh-tui-ref/src/dsh-adapter/panels.ts, lines 223–337. */
export interface TuiPanelKeyEvent {
  readonly input: string
  readonly key: { readonly upArrow?: boolean; readonly downArrow?: boolean; readonly ctrl?: boolean; readonly meta?: boolean }
  preventDefault(): void
}
export interface TuiPanelHost {
  notify(level: 'info' | 'warning' | 'error', unread?: number): void
  onKey(listener: (event: TuiPanelKeyEvent) => void): () => void
}
export interface TuiPanelProps {
  readonly React: Pick<typeof import('react'), 'createElement' | 'useState' | 'useRef' | 'useEffect'>
  readonly ui: {
    readonly Box: import('react').ElementType
    readonly Text: import('react').ElementType
    /** dsh-tui-ref/src/ink/components/Image.tsx: pixels in source, cells in width/height. */
    readonly Image: import('react').ElementType
  }
  readonly host: TuiPanelHost
  readonly width: number
  readonly height: number
  readonly visible: boolean
  readonly focused: boolean
  readonly mode: 'split' | 'zoom' | 'fullscreen'
}
export interface TuiPanelsService {
  register(descriptor: { apiVersion: 1; id: string; title: string; icon: string; minColumns: number; component: (props: TuiPanelProps) => import('react').ReactNode }): (() => void) | undefined
  list(): readonly { id: string; title: string }[]
  open(id: string): boolean
  badge(id: string, badge: { level: 'info' | 'warning' | 'error'; unread: number } | null): boolean
}
/** dsh-tui-ref/tui-profile/docs/plugin-admission-and-development.md, lines 1042–1085. */
export interface TuiDialogsService {
  confirm(options: { title: string; message?: string; confirmLabel?: string; cancelLabel?: string }): Promise<boolean>
}
