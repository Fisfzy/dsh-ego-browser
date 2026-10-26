import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyProfileForImport } from '../src/login-import.ts'

// #69: the safe-copy path must never open the real profile. This synthetic test
// pins the contract: only Local State + the cookie DB are copied, and the source
// bytes stay untouched.
describe('login-import safe copy (#69)', () => {
  it('copies only the cookie-jar files and leaves the source profile untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ego-import-copy-test-'))
    try {
      const userDataDir = join(root, 'User Data')
      const profileDir = join(userDataDir, 'Default')
      await mkdir(join(profileDir, 'Network'), { recursive: true })
      await writeFile(join(userDataDir, 'Local State'), '{"os_crypt":{}}')
      await writeFile(join(profileDir, 'Network', 'Cookies'), 'SQLite-format-cookie-db')
      await writeFile(join(profileDir, 'Network', 'Cookies-journal'), 'journal')
      const before = await readFile(join(profileDir, 'Network', 'Cookies'))

      const dest = await copyProfileForImport(
        { id: 'chrome', label: 'Google Chrome', exePath: 'chrome.exe', userDataDir },
        { name: 'Default', dirName: 'Default', dir: profileDir },
      )
      try {
        expect(await readFile(join(dest, 'Local State'), 'utf8')).toContain('os_crypt')
        expect(await readFile(join(dest, 'Default', 'Network', 'Cookies'), 'latin1')).toBe(before.toString('latin1'))
        // The journal is intentionally not copied: it is not needed to read the
        // snapshot, and copying a live journal could look like a write path.
        await expect(readFile(join(dest, 'Default', 'Network', 'Cookies-journal'))).rejects.toThrow()
        // Source remains byte-identical.
        expect(await readFile(join(profileDir, 'Network', 'Cookies'))).toEqual(before)
      } finally {
        await rm(dest, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
