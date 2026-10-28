import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The response-wait fix lives in the vendored runtime bundle (it has no TS
// source here), so these assertions pin the patched shape at the bundle level.
const runtimePath = fileURLToPath(
  new URL('../runtime/ego-browser/dist/out/index.js', import.meta.url),
)
const runtime = readFileSync(runtimePath, 'utf8')
const pluginSource = readFileSync(
  fileURLToPath(new URL('../src/index.ts', import.meta.url)),
  'utf8',
)

describe('waitForResponse buffered replay (runtime patch)', () => {
  it('enables the Network domain at session attach', () => {
    const block = runtime.slice(
      runtime.indexOf('async function enablePageEvents'),
      runtime.indexOf('async function enablePageEvents') + 1200,
    )
    expect(block).toContain('"Network.enable"')
  })

  it('keeps the domain enabled so earlier traffic stays buffered', () => {
    // Network.disable may only survive in the (now unused) owned-domain branch
    // if a future edit reintroduces it; the release path must not call it.
    const release = runtime.slice(
      runtime.indexOf('function acquireNetworkEvents'),
      runtime.indexOf('function acquireNetworkEvents') + 1600,
    )
    expect(release).not.toContain('Network.disable')
  })

  it('replays buffered events when includeBuffered is requested', () => {
    expect(runtime).toContain('function replayBufferedNetwork')
    expect(runtime).toContain('options?.includeBuffered')
    expect(runtime).toContain('bufferedWindowStart')
  })

  it('includes the document request that precedes Page.frameNavigated', () => {
    const block = runtime.slice(
      runtime.indexOf('function bufferedWindowStart'),
      runtime.indexOf('function bufferedWindowStart') + 1800,
    )
    expect(block).toContain('Page.frameNavigated')
    expect(block).toContain('Network.requestWillBeSent')
    // Walks back from the navigation, it must not simply slice after it.
    expect(block).toContain('return i')
  })

  it('explains a cache-served miss instead of a bare timeout', () => {
    expect(runtime).toContain('Network.requestServedFromCache')
    expect(runtime).toContain('cache-busting query')
  })
})

describe('ego_wait_for_response opt-in', () => {
  it('defaults includeBuffered to true and forwards it', () => {
    expect(pluginSource).toContain('includeBuffered')
    expect(pluginSource).toContain('bool(args.includeBuffered, true)')
  })
})

describe('glob matchers', () => {
  it('routes strings containing * through globToRegExp', () => {
    expect(runtime).toContain('matcher.includes("*")')
    expect(runtime).toContain('globToRegExp(matcher).test(facade.url())')
  })

  it('keeps exact-URL matching for plain strings', () => {
    expect(runtime).toContain('return facade.url() === matcher;')
  })
})
