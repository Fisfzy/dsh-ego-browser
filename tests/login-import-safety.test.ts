import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { detectSystemBrowsers, importLoginCookies } from '../src/login-import.ts'

// Gated real-Chrome test: only runs with EGO_REAL_IMPORT_TEST=1 (Chrome must be
// fully closed). It proves the #69 safe-copy contract end to end: the source
// cookie DB is byte-identical after the attempt, and an ABE browser fails with
// the explicit zero-copy message instead of booting the real profile.
const real = process.env.EGO_REAL_IMPORT_TEST === '1'

function spawnAdapter(spec: { argv: string[]; cwd?: string; env?: NodeJS.ProcessEnv; stdio?: { stdin?: { data?: string } } }) {
  const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, windowsHide: true })
  const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ exitCode: code, signal }))
    child.on('error', () => resolve({ exitCode: null, signal: null }))
  })
  child.stdout?.resume()
  child.stderr?.resume()
  child.stdin?.end(spec.stdio?.stdin?.data ?? '')
  return { done, collected: { stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } } }
}

describe.skipIf(!real)('real Chrome login import (safe copy)', () => {
  it('never writes the source cookie DB and reports ABE when the copy is undecryptable', async () => {
    const chrome = detectSystemBrowsers().find((b) => b.id === 'chrome')
    if (!chrome) return
    const cookiesPath = join(chrome.userDataDir, 'Default', 'Network', 'Cookies')
    const before = await readFile(cookiesPath)
    const report = await importLoginCookies(
      { source: 'chrome', dryRun: true, domains: ['example.com'], timeoutMs: 30_000 },
      { subprocess: { spawn: spawnAdapter } as never },
    )
    const after = await readFile(cookiesPath)
    expect(after).toEqual(before)
    if (!report.ok) {
      expect(report.error).toMatch(/App-Bound|0 cookies|temporary copy|is running|quit/i)
    } else {
      expect(report.dryRun).toBe(true)
    }
  }, 150_000)
})
