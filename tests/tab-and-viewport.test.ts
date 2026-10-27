import { describe, it, expect } from 'vitest'
import {
  createTargetTracker,
  ensureRealTab,
  rawScriptPrelude,
  recordPinnedTarget,
  selectOptionScript,
  stripTargetMarkers,
  tabParam,
  viewportPrelude,
} from '../src/index.ts'
import { resolveConfig } from '../src/config.ts'

describe('tab targeting prelude', () => {
  it('prefers the active tab over the first real tab', () => {
    const script = ensureRealTab()
    expect(script).toContain('t.active === true')
    // The active-tab branch must be consulted BEFORE the first-real-tab fallback.
    expect(script.indexOf('t.active === true')).toBeLessThan(
      script.indexOf("!t.url.startsWith('about:')"),
    )
    expect(script).toContain('__active ?? __tabs.find')
  })

  it('pins an explicit target id ahead of the active tab', () => {
    const script = ensureRealTab('ABC123')
    expect(script).toContain('const __want = "ABC123"')
    expect(script).toContain('__tabs.find(t => t.targetId === __want)')
    expect(script.indexOf('t.targetId === __want')).toBeLessThan(script.indexOf('t.active === true'))
  })

  it('matches nothing when no target is supplied', () => {
    expect(ensureRealTab()).toContain('const __want = null')
    expect(ensureRealTab('')).toContain('const __want = null')
  })

  it('switches to the resolved tab', () => {
    expect(ensureRealTab()).toContain('await browser.switchTab(__real.targetId)')
  })

  it('emits the viewport override after the switch', () => {
    const script = ensureRealTab(undefined, { viewportWidth: 1440, viewportHeight: 900 })
    expect(script).toContain('Emulation.setDeviceMetricsOverride')
    expect(script.indexOf('browser.switchTab')).toBeLessThan(
      script.indexOf('Emulation.setDeviceMetricsOverride'),
    )
  })

  it('has no viewport override when none is configured', () => {
    expect(ensureRealTab()).not.toContain('Emulation.setDeviceMetricsOverride')
  })

  it('documents the tab parameter on tools that accept it', () => {
    expect(tabParam.type).toBe('string')
    expect(tabParam.description).toMatch(/targetId/)
  })
})

describe('viewport prelude', () => {
  it('is empty when the viewport is unset or half-set', () => {
    expect(viewportPrelude({})).toBe('')
    expect(viewportPrelude({ viewportWidth: 1440 })).toBe('')
    expect(viewportPrelude({ viewportHeight: 900 })).toBe('')
  })

  it('emits a CDP device-metrics override with the configured size', () => {
    const script = viewportPrelude({
      viewportWidth: 1440,
      viewportHeight: 900,
      deviceScaleFactor: 1,
    })
    expect(script).toContain('Emulation.setDeviceMetricsOverride')
    expect(script).toContain('width: 1440')
    expect(script).toContain('height: 900')
    expect(script).toContain('deviceScaleFactor: 1')
    expect(script).toContain('mobile: false')
  })

  it('defaults the scale factor to 1 and rounds fractional sizes', () => {
    const script = viewportPrelude({ viewportWidth: 1200.6, viewportHeight: 799.4 })
    expect(script).toContain('width: 1201')
    expect(script).toContain('height: 799')
    expect(script).toContain('deviceScaleFactor: 1')
  })
})

describe('raw heredoc prelude', () => {
  it('is guarded so a browser-less diagnostic script still runs', () => {
    const script = rawScriptPrelude({}, '')
    expect(script.startsWith('try {\n')).toBe(true)
    expect(script.trimEnd().endsWith('} catch {}')).toBe(true)
  })

  it('carries both the viewport and the tab prelude', () => {
    const script = rawScriptPrelude(
      { viewportWidth: 1280, viewportHeight: 720 },
      'TAB42',
    )
    expect(script).toContain('Emulation.setDeviceMetricsOverride')
    expect(script).toContain('const __want = "TAB42"')
  })

  it('applies the viewport only AFTER a tab is attached', () => {
    // Regression: emitting the override first made every tool fail on a cold
    // browser with "no active tab to attach session" (cdp needs a session).
    const script = rawScriptPrelude({ viewportWidth: 1440, viewportHeight: 900 }, '')
    expect(script.indexOf('browser.switchTab')).toBeLessThan(
      script.indexOf('Emulation.setDeviceMetricsOverride'),
    )
  })
})

describe('ego_select option fallback', () => {
  it('tries value first, then label, then index', () => {
    const script = selectOptionScript('#pick', 'Two')
    expect(script).toContain('selectOption(__v)')
    expect(script).toContain('{ label: v }')
    expect(script).toContain('{ index: v }')
    // Label fallback comes before the index fallback in the generated body.
    expect(script.indexOf('{ label: v }')).toBeLessThan(script.indexOf('{ index: v }'))
  })

  it('embeds the caller selector and value', () => {
    const script = selectOptionScript('[name="my-select"]', 2)
    expect(script).toContain('const __sel = "[name=\\"my-select\\"]"')
    expect(script).toContain('const __v = 2')
  })
})

describe('per-space tab cursor', () => {
  it('stores a target per space and ignores empty values', () => {
    const tracker = createTargetTracker()
    tracker.set('default', 'TAB1')
    tracker.set('research', 'TAB2')
    expect(tracker.get('default')).toBe('TAB1')
    expect(tracker.get('research')).toBe('TAB2')
    tracker.set('default', '')
    expect(tracker.get('default')).toBe('TAB1')
    expect(tracker.get('missing')).toBeUndefined()
  })

  it('records the target reported by the prelude', () => {
    const tracker = createTargetTracker()
    recordPinnedTarget(tracker, 'default', 'noise\n@@EGO_TARGET@@ABC123\n{"ok":true}')
    expect(tracker.get('default')).toBe('ABC123')
  })

  it('keeps the last report when the prelude runs twice', () => {
    const tracker = createTargetTracker()
    recordPinnedTarget(tracker, 'default', '@@EGO_TARGET@@OLD\n@@EGO_TARGET@@NEW\n')
    expect(tracker.get('default')).toBe('NEW')
  })

  it('leaves the cursor alone when no marker is present', () => {
    const tracker = createTargetTracker()
    tracker.set('default', 'KEEP')
    recordPinnedTarget(tracker, 'default', 'ordinary stdout only')
    expect(tracker.get('default')).toBe('KEEP')
  })

  it('strips the side channel before stdout reaches the model', () => {
    const raw = 'hello\n@@EGO_TARGET@@ABC123\nworld'
    expect(stripTargetMarkers(raw)).toBe('hello\nworld')
    expect(stripTargetMarkers('untouched')).toBe('untouched')
  })

  it('emits the marker line from the prelude', () => {
    expect(ensureRealTab()).toContain('@@EGO_TARGET@@')
  })
})

describe('viewport config resolution', () => {
  it('defaults to off (0) so existing behaviour is unchanged', () => {
    const config = resolveConfig({})
    expect(config.viewportWidth).toBe(0)
    expect(config.viewportHeight).toBe(0)
    expect(config.deviceScaleFactor).toBe(0)
  })

  it('keeps valid values', () => {
    const config = resolveConfig({
      viewportWidth: 1440,
      viewportHeight: 900,
      deviceScaleFactor: 1.5,
    })
    expect(config.viewportWidth).toBe(1440)
    expect(config.viewportHeight).toBe(900)
    expect(config.deviceScaleFactor).toBe(1.5)
  })

  it('rejects out-of-range and non-numeric values', () => {
    expect(resolveConfig({ viewportWidth: 99_999 }).viewportWidth).toBe(0)
    expect(resolveConfig({ viewportWidth: -10 }).viewportWidth).toBe(0)
    expect(resolveConfig({ viewportHeight: 99_999 }).viewportHeight).toBe(0)
    expect(resolveConfig({ deviceScaleFactor: 9 }).deviceScaleFactor).toBe(0)
    expect(resolveConfig({ viewportWidth: 'wide' as unknown as number }).viewportWidth).toBe(0)
  })

  it('accepts an explicit zero device scale factor', () => {
    expect(
      resolveConfig({ viewportWidth: 800, viewportHeight: 600, deviceScaleFactor: 0 })
        .deviceScaleFactor,
    ).toBe(0)
  })
})
