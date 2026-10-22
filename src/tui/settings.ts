import manifest from '../../dsh-plugin.json'
import type { EgoContext } from '../types.ts'
import type { TuiSettingsField, TuiSettingsSection } from './types.ts'

/** Manifest vocabulary (tui.dsh/v1alpha1 SettingsSection): `titles` / `hintTitles`. */
interface ManifestSettingsField {
  path: string[]
  label: string
  titles?: Record<string, string>
  hint?: string
  hintTitles?: Record<string, string>
  kind: TuiSettingsField['kind']
  options?: { value: string; label: string; titles?: Record<string, string> }[]
}

export const manifestSettingsFields = manifest.contributes['x-dsh-tui']
  .find(section => section.kind === 'SettingsSection')!.spec.fields as ManifestSettingsField[]

/**
 * The manifest is the single source for field metadata; the runtime registry
 * names the same translations `descriptions` / `hintDescriptions`.
 */
export const tuiSettingsFields: TuiSettingsField[] = manifestSettingsFields.map(({ titles, hintTitles, options, ...field }) => ({
  ...field,
  ...(titles ? { descriptions: titles } : {}),
  ...(hintTitles ? { hintDescriptions: hintTitles } : {}),
  ...(options ? { options: options.map(({ titles: optionTitles, ...option }) => ({ ...option, ...(optionTitles ? { descriptions: optionTitles } : {}) })) } : {}),
}))
export const tuiSettingsSection: TuiSettingsSection = {
  ns: 'ego-browser', title: 'Agent Browser', descriptions: { zh: 'Agent 浏览器' },
  page: { id: 'ego-browser', title: 'Agent Browser', descriptions: { zh: 'Agent 浏览器' } },
  fields: tuiSettingsFields,
}
export function installTuiSettings(ctx: EgoContext): void {
  ctx.inject?.(['tuiSettingsSections'], sctx => {
    const dispose = sctx.tuiSettingsSections!.register(tuiSettingsSection)
    sctx.effect?.(() => dispose)
  })
}
