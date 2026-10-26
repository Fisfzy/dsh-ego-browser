import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createLoginExtensionPairingCode,
  getOrCreateLoginExtensionToken,
  importLoginCookiesFromExtension,
  loginExtensionTokenPath,
  receiveExtensionCookies,
  startLoginExtensionJob,
  stopLoginExtensionBridge,
  LOGIN_EXTENSION_PORT,
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
    const port = LOGIN_EXTENSION_PORT
    try {
      const pending = importLoginCookiesFromExtension({ domains: ['example.com'], dryRun: true, timeoutMs: 8000 })
      await waitForPing(port)
      const token = await getOrCreateLoginExtensionToken()
      const res = await fetch(`http://127.0.0.1:${port}/cookies`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, domains: ['example.com'], cookies: [cookie] }),
      })
      expect(res.ok).toBe(true)
      const report = await pending
      expect(report).toMatchObject({ ok: true, dryRun: true, source: 'Chrome extension', totalRead: 1, matched: 1, written: 0 })
      expect(report.domains).toEqual([{ domain: '.example.com', cookies: 1 }])
    } finally {
      stopLoginExtensionBridge()
      await rm(state, { recursive: true, force: true })
    }
  })

  it('pairs with a one-time code and lets the extension poll a waiting job', async () => {
    const port = LOGIN_EXTENSION_PORT
    try {
      const pairing = await createLoginExtensionPairingCode()
      expect(pairing.ok).toBe(true)
      expect(pairing.code).toMatch(/^\d{6}$/)
      const pairRes = await fetch(`http://127.0.0.1:${port}/pair`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: pairing.code }),
      })
      const paired = (await pairRes.json()) as { ok?: boolean; token?: string }
      expect(paired.ok).toBe(true)
      expect(paired.token).toBeTruthy()
      const job = await startLoginExtensionJob({ domains: ['example.com'], dryRun: true, timeoutMs: 5000 })
      const pending = await fetch(`http://127.0.0.1:${port}/pending`, { headers: { 'x-ego-token': paired.token! } })
      const pj = (await pending.json()) as { jobId?: string }
      expect(pj.jobId).toBe(job.jobId)
      await fetch(`http://127.0.0.1:${port}/cookies`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: paired.token, jobId: job.jobId, cookies: [cookie] }),
      })
      const report = await job.done
      expect(report).toMatchObject({ ok: true, dryRun: true, totalRead: 1, matched: 1, written: 0 })
    } finally {
      stopLoginExtensionBridge()
    }
  })
})
