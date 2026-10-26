import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoginExtensionPairingCode, stopLoginExtensionBridge, importLoginCookiesFromExtension } from '../src/login-extension.ts'
import { resolveEgoStateDir } from '../src/login-import.ts'

// Gated real-browser test for the #69 (A) extension bridge:
//   EGO_REAL_EXTENSION_TEST=1 pnpm vitest run tests/login-extension-e2e.test.ts
// It launches a throwaway headed Chrome with the extension loaded, sets a test
// cookie via CDP, opens the extension popup, clicks Export, and verifies the
// cookie lands in the running ego browser. The user's daily Chrome/profile is
// never opened.
const real = process.env.EGO_REAL_EXTENSION_TEST === '1'
const CHROME = process.env.EGO_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXTENSION = join(process.cwd(), 'extension')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Cdp = {
  call(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>
  close(): void
}

async function cdp(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true })
  })
  let id = 0
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data))
    if (typeof msg.id !== 'number') return
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
  })
  return {
    call(method, params = {}, sessionId) {
      const msgId = ++id
      return new Promise((resolve, reject) => {
        pending.set(msgId, { resolve, reject })
        ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }))
      })
    },
    close() { try { ws.close() } catch { /* ignore */ } },
  }
}

async function waitPort(dir: string): Promise<number> {
  for (let i = 0; i < 150; i++) {
    try {
      const line = (await readFile(join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]!.trim()
      const port = Number(line)
      if (port > 0) return port
    } catch { /* not yet */ }
    await sleep(100)
  }
  throw new Error('DevToolsActivePort never appeared')
}

async function attachPage(client: Cdp, targetId: string): Promise<string> {
  const r = await client.call('Target.attachToTarget', { targetId, flatten: true })
  return r.sessionId
}

describe.skipIf(!real)('login extension bridge (real Chrome)', () => {
  it('reads a cookie through the extension and writes it into the ego browser', async () => {
    const stateDir = resolveEgoStateDir()
    const profileDir = await mkdtemp(join(tmpdir(), 'ego-ext-e2e-profile-'))
    const port = 53831
    process.env.EGO_LOGIN_EXTENSION_PORT = String(port)
    const cookieName = '__ego_ext_test_' + Date.now()
    let child: ReturnType<typeof spawn> | null = null
    let client: Cdp | null = null
    try {
      const pending = importLoginCookiesFromExtension({ domains: ['example.com'], dryRun: false, stateDir, port, timeoutMs: 45_000 })
      for (let i = 0; i < 100; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/ping`)).ok) break } catch { /* wait */ }
        await sleep(50)
      }

      child = spawn(CHROME, [
        `--user-data-dir=${profileDir}`,
        `--load-extension=${EXTENSION}`,
        '--disable-features=DisableLoadExtensionCommandLineSwitch',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-position=0,0',
        '--window-size=900,700',
        'about:blank',
      ], { stdio: 'ignore', windowsHide: true })

      const cdpPort = await waitPort(profileDir)
      const version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()
      client = await cdp(version.webSocketDebuggerUrl)

      // Find our extension by opening the popup for each candidate service
      // worker (a fresh profile also has built-in extensions). The one whose
      // popup exposes #domains is ours.
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      let candidates: string[] = []
      for (let i = 0; i < 100 && candidates.length === 0; i++) {
        const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
        candidates = Array.from(new Set<string>(targets
          .filter((t: any) => typeof t.url === 'string' && t.url.startsWith('chrome-extension://') && t.url.endsWith('/background.js'))
          .map((t: any) => String(new URL(t.url).host))))
        if (candidates.length === 0) await sleep(100)
      }
      console.log('EXT CANDIDATES', candidates.length)
      let extensionId: string | null = null
      let popupSession = ''
      let popupTargetId = ''
      const evalIn = async (session: string, expression: string, awaitPromise = false): Promise<any> => {
        for (let i = 0; i < 100; i++) {
          try {
            return await client!.call('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, session)
          } catch (err) {
            if (!/execution context/i.test(String((err as Error)?.message || err))) throw err
            await sleep(100)
          }
        }
        throw new Error('popup execution context never became available')
      }
      for (const id of candidates) {
        try {
          const t = await client.call('Target.createTarget', { url: `chrome-extension://${id}/popup.html` })
          const s = await attachPage(client, t.targetId)
          await client.call('Page.enable', {}, s).catch(() => null)
          for (let i = 0; i < 50; i++) {
            const ready = await evalIn(s, 'document.readyState')
            if (ready.result?.value === 'complete') break
            await sleep(100)
          }
          const has = await evalIn(s, "!!document.getElementById('pair')")
          if (has.result?.value === true) {
            extensionId = id
            popupSession = s
            popupTargetId = t.targetId
            break
          }
        } catch { /* not ours */ }
      }
      console.log('EXT ID', extensionId)
      expect(extensionId).toBeTruthy()

      const about = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find((t: any) => t.type === 'page' && t.url === 'about:blank')
      const pageSession = await attachPage(client, about.id)
      await client.call('Network.setCookie', {
        name: cookieName, value: 'bridge-ok', url: 'https://example.com/', domain: '.example.com', path: '/', secure: true,
      }, pageSession)

      // Real pairing flow: fetch a one-time code from the bridge, then let the
      // extension exchange it for a token (exactly what the popup does).
      const pairing = await createLoginExtensionPairingCode()
      expect(pairing.ok).toBe(true)
      const paired = await evalIn(popupSession, `fetch('http://127.0.0.1:${port}/pair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: '${pairing.code}' }),
        }).then(r => r.json()).then(j => j.ok ? chrome.storage.local.set({ token: j.token, port: '${port}' }) : Promise.reject(j.error))`, true)
      expect(paired.exceptionDetails).toBeUndefined()

      const report = await pending
      expect(report.ok).toBe(true)
      expect(report.written || 0).toBeGreaterThanOrEqual(1)
      expect(report.domains?.some((d) => d.domain.includes('example.com'))).toBe(true)
    } finally {
      // Remove the test cookie from the ego browser (best effort).
      try {
        const bj = JSON.parse(await readFile(join(stateDir, 'browser.json'), 'utf8')) as { port?: number }
        if (bj.port) {
          const v = await (await fetch(`http://127.0.0.1:${bj.port}/json/version`)).json()
          const ego = await cdp(v.webSocketDebuggerUrl)
          const pages = (await (await fetch(`http://127.0.0.1:${bj.port}/json/list`)).json()).filter((t: any) => t.type === 'page')
          if (pages[0]) {
            const s = await attachPage(ego, pages[0].id)
            await ego.call('Network.deleteCookies', { name: cookieName, domain: '.example.com', path: '/' }, s)
          }
          ego.close()
        }
      } catch { /* best effort */ }
      try { if (client) await client.call('Browser.close') } catch { /* ignore */ }
      try { client?.close() } catch { /* ignore */ }
      try { child?.kill() } catch { /* ignore */ }
      await sleep(500)
      try { stopLoginExtensionBridge() } catch { /* ignore */ }
      delete process.env.EGO_LOGIN_EXTENSION_PORT
      await rm(profileDir, { recursive: true, force: true }).catch(() => null)
    }
  }, 180_000)
})
