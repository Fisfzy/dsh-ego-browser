import { describe, it, expect } from 'vitest'
import {
  EGO_HELP_DOCS,
  EGO_HELP_INDEX,
  isEgoHelpVisible,
  listEgoHelpTopics,
  renderEgoHelpList,
} from '../src/help.ts'

const WIN = { platform: 'win32' as NodeJS.Platform }
const MAC = { platform: 'darwin' as NodeJS.Platform }
const LINUX = { platform: 'linux' as NodeJS.Platform }

describe('ego_help documentation registry', () => {
  it('groups topics by mode', () => {
    const { inline, lookup } = listEgoHelpTopics(WIN)
    expect(inline).toEqual(expect.arrayContaining(['overview', 'discipline', 'errors', 'tools']))
    expect(lookup).toEqual(
      expect.arrayContaining(['navigate', 'tabs', 'observe', 'screenshots', 'gui-test', 'login-import']),
    )
    expect(inline).not.toContain('navigate')
  })

  it('hides Windows/macOS-only topics on Linux but keeps them visible there', () => {
    expect(isEgoHelpVisible('login-import', WIN)).toBe(true)
    expect(isEgoHelpVisible('login-import', MAC)).toBe(true)
    expect(isEgoHelpVisible('login-import', LINUX)).toBe(false)
    expect(listEgoHelpTopics(LINUX).hidden).toContain('login-import')
    expect(listEgoHelpTopics(WIN).hidden).not.toContain('login-import')
  })

  it('renders a grouped list, including the platform note only when something is hidden', () => {
    const windowsList = renderEgoHelpList(WIN)
    expect(windowsList).toContain('inline:')
    expect(windowsList).toContain('lookup:')
    expect(windowsList).not.toContain('本平台不可用')
    expect(renderEgoHelpList(LINUX)).toContain('本平台不可用: login-import')
  })

  it('keeps the legacy EGO_HELP_INDEX view in sync with the registry', () => {
    expect(Object.keys(EGO_HELP_INDEX).sort()).toEqual(Object.keys(EGO_HELP_DOCS).sort())
    expect(EGO_HELP_INDEX.overview).toBe(EGO_HELP_DOCS.overview!.text)
  })

  it('every entry has a non-empty text and a valid mode', () => {
    for (const [name, entry] of Object.entries(EGO_HELP_DOCS)) {
      expect(entry.text.length, name).toBeGreaterThan(20)
      expect(['inline', 'lookup']).toContain(entry.mode)
    }
  })
})
