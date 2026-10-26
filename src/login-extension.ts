/**
 * #69 (A) — Chrome extension bridge.
 *
 * Modern Chrome (127+, Windows ABE) binds cookie decryption to the original
 * profile, so a copied profile cannot be read and booting the real profile is
 * destructive. The only side-effect-free way to obtain the daily Chrome's
 * cookies is to let Chrome itself hand them over through the `cookies`
 * extension API.
 *
 * Flow:
 *   1. `ego_login_import({ source: 'extension', domains: [...] })` starts a
 *      loopback HTTP receiver (127.0.0.1 only, bearer token) and waits.
 *   2. The user opens the companion extension popup (shipped under extension/)
 *      and clicks Export; it reads cookies for the listed domains and POSTs
 *      them to the receiver.
 *   3. The receiver validates the token, converts the cookies to CDP shape and
 *      writes them into the running agent browser (same jar logic as the
 *      profile-import path).
 *
 * Security: bind 127.0.0.1, random/known port, per-install token stored with
 * mode 0600; cookie VALUES never appear in logs or tool output.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  browserWsUrl,
  connectCdp,
  cookieMatchesDomains,
  resolveEgoStateDir,
  toCookieParam,
  type CdpCookie,
  type LoginImportReport,
} from './login-import.ts'

export const LOGIN_EXTENSION_PORT = 53820
const MAX_BODY = 5 * 1024 * 1024
const BATCH = 100

export function loginExtensionTokenPath(stateDir: string = resolveEgoStateDir()): string {
  return join(stateDir, 'login-extension-token')
}

/** Per-install bearer token shared with the companion extension. */
export async function getOrCreateLoginExtensionToken(stateDir: string = resolveEgoStateDir()): Promise<string> {
  const file = loginExtensionTokenPath(stateDir)
  try {
    const existing = (await readFile(file, 'utf8')).trim()
    if (existing.length >= 16) return existing
  } catch { /* create below */ }
  const token = randomBytes(24).toString('hex')
  await mkdir(dirname(file), { recursive: true }).catch(() => null)
  await writeFile(file, token, { encoding: 'utf8', mode: 0o600 }).catch(() => null)
  return token
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-ego-token',
    'cache-control': 'no-store',
  })
  res.end(text)
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > MAX_BODY) throw new Error('request body too large')
    chunks.push(buf)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function tokenMatches(expected: string, got: unknown): boolean {
  if (typeof got !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(got)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Accept cookies for one import job; resolves when the extension POSTs. */
export async function receiveExtensionCookies(opts: {
  token: string
  domains: readonly string[]
  port?: number
  timeoutMs?: number
}): Promise<{ cookies: CdpCookie[]; received: number }> {
  const port = opts.port ?? LOGIN_EXTENSION_PORT
  const timeoutMs = opts.timeoutMs ?? 120_000
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close(() => fn())
    }
    const server = createServer(async (req, res) => {
      try {
        if (req.method === 'OPTIONS') {
          sendJson(res, 204, {})
          return
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (req.method === 'GET' && url.pathname === '/ping') {
          sendJson(res, 200, { ok: true, app: 'ego-browser-login', port })
          return
        }
        if (req.method === 'POST' && url.pathname === '/cookies') {
          const body = (await readJsonBody(req)) as { token?: unknown; cookies?: unknown; domains?: unknown }
          if (!tokenMatches(opts.token, body.token)) {
            sendJson(res, 403, { ok: false, error: 'bad token' })
            return
          }
          const raw = Array.isArray(body.cookies) ? body.cookies : []
          const cookies = raw.map(toCdpCookie).filter((c): c is CdpCookie => c !== null)
          const filtered = cookies.filter((c) => cookieMatchesDomains(c.domain, opts.domains))
          sendJson(res, 200, { ok: true, received: cookies.length, matched: filtered.length })
          finish(() => resolve({ cookies: filtered, received: cookies.length }))
          return
        }
        sendJson(res, 404, { ok: false, error: 'not found' })
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String((err as Error)?.message || err) })
      }
    })
    server.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`could not start the login-extension receiver on 127.0.0.1:${port}: ${(err as Error).message}`))
    })
    server.listen(port, '127.0.0.1')
    const timer = setTimeout(() => {
      finish(() => reject(new Error(
        `the Chrome extension did not send cookies within ${Math.round(timeoutMs / 1000)}s — install/load extension/ and ` +
        `click Export (token file: ${loginExtensionTokenPath()})`,
      )))
    }, timeoutMs)
  })
}

function toCdpCookie(raw: unknown): CdpCookie | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  if (typeof c.name !== 'string' || c.name === '' || typeof c.value !== 'string') return null
  if (typeof c.domain !== 'string' || c.domain === '') return null
  const rawSite = c.sameSite
  const sameSite = rawSite === 'strict' ? 'Strict'
    : rawSite === 'lax' ? 'Lax'
    : (rawSite === 'none' || rawSite === 'no_restriction') ? 'None'
    : undefined
  const expires = typeof c.expirationDate === 'number' ? c.expirationDate : undefined
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: typeof c.path === 'string' && c.path !== '' ? c.path : '/',
    secure: c.secure === true,
    httpOnly: c.httpOnly === true,
    sameSite: sameSite === 'Strict' || sameSite === 'Lax' || sameSite === 'None' ? sameSite : undefined,
    session: expires === undefined,
    ...(expires !== undefined ? { expires } : {}),
  }
}

/** Write CDP cookies into the running agent browser (default jar + spaces). */
export async function writeCookiesToEgo(
  cookies: CdpCookie[],
  stateDir: string = resolveEgoStateDir(),
): Promise<{ written: number; error?: string }> {
  let egoPort: number
  try {
    const bj = JSON.parse(await readFile(join(stateDir, 'browser.json'), 'utf8')) as { port?: unknown }
    if (typeof bj.port !== 'number' || bj.port <= 0) throw new Error('no port in browser.json')
    egoPort = bj.port
  } catch {
    return { written: 0, error: 'agent browser is not running (no browser.json) — call ego_status or any ego_* tool first, then retry' }
  }
  const egoCdp = await connectCdp(await browserWsUrl(egoPort), 5000)
  const params = cookies.map(toCookieParam).filter((p): p is Record<string, unknown> => p !== null)
  const jarTargets: (string | undefined)[] = [undefined]
  try {
    const spacesRaw = await readFile(join(stateDir, 'task-spaces.json'), 'utf8')
    const parsed = JSON.parse(spacesRaw) as { spaces?: { browserContextId?: unknown }[] }
    for (const space of parsed.spaces ?? []) {
      const id = space?.browserContextId
      if (typeof id === 'string' && id !== '') jarTargets.push(id)
    }
  } catch { /* no isolated spaces */ }
  const jarKey = (domain: unknown, name: unknown, path: unknown): string =>
    `${String(name)}|${String(domain).replace(/^\./, '')}|${String(path ?? '/')}`
  const writeJar = async (contextId: string | undefined): Promise<number> => {
    const scoped = contextId === undefined ? {} : { browserContextId: contextId }
    for (let i = 0; i < params.length; i += BATCH) {
      await egoCdp.client.call('Storage.setCookies', { cookies: params.slice(i, i + BATCH), ...scoped })
    }
    const back = (await egoCdp.client.call('Storage.getCookies', scoped)) as { cookies?: CdpCookie[] }
    const have = new Set((back.cookies ?? []).map((c) => jarKey(c.domain, c.name, c.path)))
    return params.filter((p) => have.has(jarKey(p.domain, p.name, p.path))).length
  }
  try {
    let written = await writeJar(undefined)
    for (const contextId of jarTargets.slice(1)) {
      try { await writeJar(contextId) } catch { /* space gone */ }
    }
    if (params.length > 0 && written === 0) {
      return { written: 0, error: 'the agent browser accepted no cookies — restart it (ego_status after closing it) and retry' }
    }
    return { written }
  } catch (err) {
    return { written: -1, error: String((err as Error)?.message || err) }
  } finally {
    try { egoCdp.close() } catch { /* ignore */ }
  }
}

export interface ExtensionImportOptions {
  domains?: string[]
  dryRun?: boolean
  stateDir?: string
  port?: number
  timeoutMs?: number
}

/** #69 (A): import cookies from the companion Chrome extension. */
export async function importLoginCookiesFromExtension(opts: ExtensionImportOptions = {}): Promise<LoginImportReport> {
  const stateDir = opts.stateDir ?? resolveEgoStateDir()
  const token = await getOrCreateLoginExtensionToken(stateDir)
  let received
  try {
    received = await receiveExtensionCookies({
      token,
      domains: opts.domains ?? [],
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    })
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err) }
  }
  const cookies = received.cookies
  const byDomain = new Map<string, number>()
  for (const c of cookies) byDomain.set(c.domain, (byDomain.get(c.domain) || 0) + 1)
  const domains = [...byDomain.entries()].map(([domain, count]) => ({ domain, cookies: count })).sort((a, b) => b.cookies - a.cookies)
  if (opts.dryRun) {
    return { ok: true, source: 'Chrome extension', profile: 'extension', dryRun: true, closedSource: false, totalRead: received.received, matched: cookies.length, written: 0, domains }
  }
  const write = await writeCookiesToEgo(cookies, stateDir)
  if (write.error !== undefined) {
    return { ok: false, source: 'Chrome extension', profile: 'extension', dryRun: false, closedSource: false, totalRead: received.received, matched: cookies.length, written: write.written, domains, error: write.error }
  }
  return { ok: true, source: 'Chrome extension', profile: 'extension', dryRun: false, closedSource: false, totalRead: received.received, matched: cookies.length, written: write.written, domains }
}
