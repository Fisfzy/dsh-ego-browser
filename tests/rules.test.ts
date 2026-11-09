import { describe, it, expect, beforeEach } from 'vitest'
import {
  EGO_RULES_TEXT,
  hasUsedEgo,
  noteEgoToolUse,
  registerEgoRulesSection,
  resetEgoRulesForTests,
  rulesTextForContext,
  type SystemPromptSectionSpec,
} from '../src/rules.ts'

describe('native rules prompt', () => {
  beforeEach(() => resetEgoRulesForTests())

  it('stays empty until an ego tool has run', () => {
    expect(hasUsedEgo()).toBe(false)
    expect(rulesTextForContext(undefined)).toBe('')
    expect(rulesTextForContext({ agent: { session: { id: 's1' } } })).toBe('')
  })

  it('activates after the first use and keeps the rule text', () => {
    noteEgoToolUse('s1')
    expect(hasUsedEgo()).toBe(true)
    expect(hasUsedEgo('s1')).toBe(true)
    expect(rulesTextForContext({ agent: { session: { id: 's1' } } })).toBe(EGO_RULES_TEXT)
  })

  it('gates per session when the assembly context exposes one', () => {
    noteEgoToolUse('s1')
    // A different session must not inherit the section when the host names it.
    expect(rulesTextForContext({ agent: { session: { id: 's2' } } })).toBe('')
    expect(rulesTextForContext({ session: { id: 's2' } })).toBe('')
  })

  it('degrades to the process-wide flag when the context has no session id', () => {
    noteEgoToolUse('s1')
    expect(rulesTextForContext({})).toBe(EGO_RULES_TEXT)
  })

  it('registers a section only when the systemPrompt service exists', () => {
    const sections: SystemPromptSectionSpec[] = []
    const registered = registerEgoRulesSection({
      get: (name: string) =>
        name === 'systemPrompt' ? { section: (spec: SystemPromptSectionSpec) => sections.push(spec) } : undefined,
    })
    expect(registered).toBe(true)
    expect(sections).toHaveLength(1)
    expect(sections[0]!.name).toBe('plugin:ego-browser:rules')
    expect(typeof sections[0]!.text).toBe('function')
  })

  it('respects the rulesPrompt switch on every assembly pass', () => {
    noteEgoToolUse('s1')
    expect(rulesTextForContext({}, false)).toBe('')
    const sections: SystemPromptSectionSpec[] = []
    registerEgoRulesSection(
      { get: () => ({ section: (spec: SystemPromptSectionSpec) => sections.push(spec) }) },
      { isEnabled: () => false },
    )
    expect(sections).toHaveLength(1)
    expect((sections[0]!.text as (context: unknown) => string)({})).toBe('')
  })

  it('is a silent no-op on a host without the service', () => {
    expect(registerEgoRulesSection({ get: () => undefined })).toBe(false)
    expect(registerEgoRulesSection({})).toBe(false)
    expect(registerEgoRulesSection({ get: () => ({}) })).toBe(false)
  })
})
