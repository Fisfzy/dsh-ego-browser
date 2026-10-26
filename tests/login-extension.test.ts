import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getOrCreateLoginExtensionToken,
  importLoginCookiesFromExtension,
  loginExtensionTokenPath,
  receiveExtensionCookies,
} from '../src/login-extension.ts'

const cookie = {
  name: 'sid',
  value: 'secret-value',
  domain: '.example.com',
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'lax',
  expirationDate: 4102444800,
}

async function waitForPing(port: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ping`)
      if (res.ok) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('receiver did not start')
}

describe('login extension bridge (#69 A)', () => {
  it('creates a persistent per-install token file', async () => {
    const state = await mkdtemp(join(tmpdir(), 'ego-ext-token-'))
    try {
      const a = await getOrCreateLoginExtensionToken(state)
      const b = await getOrCreateLoginExtensionToken(state)
      expect(a).toBe(b)
      expect(a.length).toBeGreaterThanOrEqual(16)
      expect((await readFile(loginExtensionTokenPath(state), 'utf8')).trim()).toBe(a)
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })

  it('rejects a wrong token and resolves filtered cookies for the right one', async () => {
    const state = await mkdtemp(join(tmpdir(), 'ego-ext-recv-'))
    const port = 53821
    try {
      const token = await getOrCreateLoginExtensionToken(state)
      const pending = receiveExtensionCookies({ token, domains: ['example.com'], port, timeoutMs: 8000 })
      await waitForPing(port)
      const bad = await fetch(`http://127.0.0.1:${port}/cookies`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'wrong', domains: ['example.com'], cookies: [cookie] }),
      })
      expect(bad.status).toBe(403)
      await fetch(`http://127.0.0.1:${port}/cookies`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, domains: ['example.com'], cookies: [cookie, { ...cookie, domain: 'other.test' }] }),
      })
      const result = await pending
      expect(result.received).toBe(2)
      expect(result.cookies).toHaveLength(1)
      expect(result.cookies[0]).toMatchObject({ name: 'sid', domain: '.example.com', sameSite: 'Lax' })
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })

  it('runs a dry-run import through the loopback receiver', async () => {
    const state = await mkdtemp(join(tmpdir(), 'ego-ext-import-'))
    const port = 53822
    try {
      const pending = importLoginCookiesFromExtension({ domains: ['example.com'], dryRun: true, stateDir: state, port, timeoutMs: 8000 })
      await waitForPing(port)
      const token = await getOrCreateLoginExtensionToken(state)
      const res = await fetch(`http://127.0.0.1:${port}/cookies`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, domains: ['example.com'], cookies: [cookie] }),
      })
      expect(res.ok).toBe(true)
      const report = await pending
      expect(report).toMatchObject({ ok: true, dryRun: true, source: 'Chrome extension', totalRead: 1, matched: 1, written: 0 })
      expect(report.domains).toEqual([{ domain: '.example.com', cookies: 1 }])
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })
})
