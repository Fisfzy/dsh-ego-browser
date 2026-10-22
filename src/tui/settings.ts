import manifest from '../../dsh-plugin.json'
import type { EgoContext } from '../types.ts'
import type { TuiSettingsField, TuiSettingsSection } from './types.ts'

/** The manifest is the single source for runtime field metadata. */
export const tuiSettingsFields = manifest.contributes['x-dsh-tui']
  .find(section => section.kind === 'SettingsSection')!.spec.fields as TuiSettingsField[]
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
