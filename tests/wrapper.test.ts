import { describe, it, expect } from 'vitest'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureWrapperExecutable } from '../src/index.ts'

const WRAPPER = new URL('../bin/ego-chrome-wrapper.sh', import.meta.url)

describe('bundled chrome wrapper (#98)', () => {
  it('stays a POSIX shell script with exec + PATH fallback', async () => {
    const script = await readFile(WRAPPER, 'utf8')
    expect(script.startsWith('#!/bin/sh')).toBe(true)
    expect(script).toContain('EGO_LINUX_CHROME_BIN')
    expect(script).toContain('command -v')
    expect(script).toContain('--no-sandbox')
    // The wrapper must never exec itself (root hosts point EGO_LINUX_CHROME here).
    expect(script).toContain('!= "${SELF}"')
  })

  it.skipIf(process.platform === 'win32')('restores a dropped executable bit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ego-wrapper-'))
    const path = join(dir, 'wrapper.sh')
    try {
      await writeFile(path, '#!/bin/sh\nexit 0\n')
      await chmod(path, 0o600)
      expect((await stat(path)).mode & 0o111).toBe(0)
      expect(ensureWrapperExecutable(path)).toBe(true)
      expect((await stat(path)).mode & 0o111).not.toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns false for a missing wrapper instead of throwing', () => {
    expect(ensureWrapperExecutable(join(tmpdir(), 'definitely-missing-ego-wrapper.sh'))).toBe(false)
  })
})
