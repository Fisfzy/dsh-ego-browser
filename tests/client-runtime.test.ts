import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const runtimeId = '@deepseek-ai/dsh-client-runtime'
const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

describe('client runtime dependency', () => {
  it('loads the runtime package that the host registers in its module graph', () => {
    expect(source).toContain(`require('${runtimeId}')`)
    expect(manifest.peerDependencies).toHaveProperty(runtimeId)
    expect(manifest.dsh.client.inject).toContain(runtimeId)
    expect(source).not.toContain('@deepseek-ai/dsh-client-store')
  })
})
