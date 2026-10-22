import { truncateCells } from './text.ts'

const selectorTools = new Set(['ego_click', 'ego_fill', 'ego_screenshot', 'ego_wait_for_selector',
  'ego_hover', 'ego_read_element', 'ego_select', 'ego_scroll', 'ego_upload', 'ego_check'])
const urlTools = new Set(['ego_navigate', 'ego_http', 'ego_wait_for_response'])
/** Only locator fields are eligible; values, headers, bodies and executable source never are. */
export function safeLocatorSummary(name: string, args: Record<string, unknown>): string {
  let summary = ''
  if (selectorTools.has(name) && typeof args.selector === 'string') summary = args.selector
  else if (urlTools.has(name) && typeof args.url === 'string') {
    try {
      const url = new URL(args.url)
      if (url.protocol === 'http:' || url.protocol === 'https:') summary = url.host + url.pathname
    } catch { /* Invalid URLs and patterns need no potentially sensitive fallback. */ }
  } else if (name === 'ego_drag' && typeof args.from === 'string' && typeof args.to === 'string') {
    summary = `${args.from} → ${args.to}`
  } else if (name === 'ego_download' && typeof args.triggerSelector === 'string') summary = args.triggerSelector
  return truncateCells(summary, 48)
}
export function toolCallTitle(name: string, args: Record<string, unknown>): string {
  const summary = safeLocatorSummary(name, args)
  return summary ? `${name} · ${summary}` : name
}
