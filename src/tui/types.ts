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
