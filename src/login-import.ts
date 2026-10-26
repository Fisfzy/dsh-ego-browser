/**
 * ego-browser login-import — copy login cookies from the system's daily-use
 * Chromium (Chrome/Edge/Brave) into the running ego agent browser (issue #46).
 *
 * #69 made the original design unsafe: it booted the REAL profile through a
 * junction alias and hard-killed the instance, which could wipe extensions /
 * reset settings. That path is gone. There are now two safe routes:
 *
 *  1. Extension bridge (recommended, modern Chrome/Edge): the companion
 *     `extension/` folder reads cookies via the browser's `cookies` API and
 *     POSTs them to a loopback receiver. No profile copy, no browser close,
 *     no ABE decryption — see login-extension.ts.
 *
 *  2. Safe copy (legacy browsers / closed browser): copy ONLY `Local State`
 *     and the Cookies DB into a throwaway profile and read it with a headless
 *     browser. The real profile is never opened, so no writes can occur.
 *     Chrome/Edge 127+ use App-Bound Encryption bound to the original profile
 *     path, so this copy reads 0 cookies; the caller reports that explicitly
 *     instead of falling back to the old destructive boot.
 *
 * Then filter by domain and write into the ego browser's persistent profile
 * with `Storage.setCookies`. `closeSource:true` still gracefully closes a
 * running source browser — only because Windows locks the cookie DB for the
 * copy (the browser is not opened on the profile).
 *
 * Security contract:
 *   - cookie VALUES never appear in logs, tool output, or reports — only
 *     domain names and counts;
 *   - the source profile is never opened by a browser and never written;
 *   - import is a one-shot snapshot, never a continuous sync.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { CdpClient } from './worker/cdp-client.ts'

const execFile = promisify(execFileCb)

// ── system browser detection ────────────────────────────────────────────────

export interface SystemBrowser {
  id: 'chrome' | 'edge' | 'brave'
  label: string
  exePath: string
  userDataDir: string
}

/** All candidate (exe, profile) pairs for the platform — existence NOT checked. */
export function chromiumCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): SystemBrowser[] {
  if (platform === 'win32') {
    const la = env.LOCALAPPDATA || ''
    const pf = env['ProgramFiles'] || 'C:\\Program Files'
    const pfx = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    return [
      { id: 'chrome', label: 'Google Chrome', exePath: `${pf}\\Google\\Chrome\\Application\\chrome.exe`, userDataDir: `${la}\\Google\\Chrome\\User Data` },
      { id: 'chrome', label: 'Google Chrome', exePath: `${pfx}\\Google\\Chrome\\Application\\chrome.exe`, userDataDir: `${la}\\Google\\Chrome\\User Data` },
      { id: 'edge', label: 'Microsoft Edge', exePath: `${pfx}\\Microsoft\\Edge\\Application\\msedge.exe`, userDataDir: `${la}\\Microsoft\\Edge\\User Data` },
      { id: 'edge', label: 'Microsoft Edge', exePath: `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`, userDataDir: `${la}\\Microsoft\\Edge\\User Data` },
      { id: 'brave', label: 'Brave', exePath: `${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, userDataDir: `${la}\\BraveSoftware\\Brave-Browser\\User Data` },
    ]
  }
  if (platform === 'darwin') {
    const home = env.HOME || ''
    return [
      { id: 'chrome', label: 'Google Chrome', exePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', userDataDir: `${home}/Library/Application Support/Google/Chrome` },
      { id: 'edge', label: 'Microsoft Edge', exePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', userDataDir: `${home}/Library/Application Support/Microsoft Edge` },
    ]
  }
  const home = env.HOME || ''
  return [
    { id: 'chrome', label: 'Google Chrome', exePath: '/usr/bin/google-chrome', userDataDir: `${home}/.config/google-chrome` },
    { id: 'chrome', label: 'Chromium', exePath: '/usr/bin/chromium', userDataDir: `${home}/.config/chromium` },
    { id: 'edge', label: 'Microsoft Edge', exePath: '/usr/bin/microsoft-edge', userDataDir: `${home}/.config/microsoft-edge` },
    { id: 'brave', label: 'Brave', exePath: '/usr/bin/brave-browser', userDataDir: `${home}/.config/BraveSoftware/Brave-Browser` },
  ]
}

/** Candidates that actually exist on disk (exe + Local State present). */
export function detectSystemBrowsers(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): SystemBrowser[] {
  const seen = new Set<string>()
  return chromiumCandidates(env, platform).filter((b) => {
    if (seen.has(b.exePath)) return false
    seen.add(b.exePath)
    return existsSync(b.exePath) && existsSync(join(b.userDataDir, 'Local State'))
  })
}

// ── profile enumeration ─────────────────────────────────────────────────────

export interface BrowserProfile {
  /** Absolute path of the profile directory. */
  dir: string
  /** Basename of the profile directory (e.g. "Default", "Profile 1"). */
  dirName: string
  /** Display name from Local State. */
  name: string
}

export function profilesFromLocalState(localStateJson: string, userDataDir: string): BrowserProfile[] {
  try {
    const j = JSON.parse(localStateJson) as { profile?: { info_cache?: Record<string, { name?: string }> } }
    const cache = j.profile?.info_cache || {}
    const out = Object.entries(cache).map(([dirName, info]) => ({
      dir: join(userDataDir, dirName),
      dirName,
      name: (info && typeof info.name === 'string' && info.name) || dirName,
    }))
    return out.length ? out : [{ dir: join(userDataDir, 'Default'), dirName: 'Default', name: 'Default' }]
  } catch {
    return [{ dir: join(userDataDir, 'Default'), dirName: 'Default', name: 'Default' }]
  }
}

// ── cookie filtering / conversion (pure) ────────────────────────────────────

/** Domain filter: "bilibili.com" matches ".bilibili.com" and any subdomain. */
export function cookieMatchesDomains(cookieDomain: string, domains: readonly string[]): boolean {
  if (!domains || domains.length === 0) return true
  const host = String(cookieDomain || '').replace(/^\./, '').toLowerCase()
  return domains.some((raw) => {
    const d = String(raw || '').replace(/^\./, '').trim().toLowerCase()
    return d !== '' && (host === d || host.endsWith('.' + d))
  })
}

export interface CdpCookie {
  name: string
  value: string
  domain: string
  path: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  session?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

/** Convert a CDP Network.Cookie to a Storage.setCookies CookieParam. */
export function toCookieParam(c: CdpCookie): Record<string, unknown> | null {
  if (!c || typeof c.name !== 'string' || c.name === '' || typeof c.value !== 'string' || typeof c.domain !== 'string' || c.domain === '') return null
  const p: Record<string, unknown> = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: typeof c.path === 'string' && c.path !== '' ? c.path : '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
  }
  if (c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None') p.sameSite = c.sameSite
  // Session cookies must NOT carry expires — CDP would reject a 0/past expiry
  // and silently drop the cookie.
  if (!c.session && typeof c.expires === 'number' && c.expires > 0) p.expires = c.expires
  return p
}

/** First line of DevToolsActivePort is the port number. */
export function parseDevToolsActivePort(text: string): number | null {
  const line = String(text || '').split(/\r?\n/)[0]?.trim()
  const n = Number(line)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null
}

// ── ego browser state-dir resolution (mirrors ego_auth_flush) ───────────────

export function resolveEgoStateDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const home = env.HOME || env.USERPROFILE || ''
  if (env.EGO_LINUX_STATE_DIR) return env.EGO_LINUX_STATE_DIR
  return platform === 'win32'
    ? (env.LOCALAPPDATA || `${home}\\AppData\\Local`) + '\\ego-lite-linux'
    : `${env.XDG_STATE_HOME || `${home}/.local/state`}/ego-lite-linux`
}

// ── CDP plumbing ────────────────────────────────────────────────────────────

interface WsLike {
  addEventListener(type: string, fn: (...args: unknown[]) => void, opts?: unknown): void
  send(data: string): void
  close(): void
}

export async function connectCdp(wsUrl: string, timeoutMs: number): Promise<{ client: CdpClient; close: () => void }> {
  const WsImpl = (globalThis as { WebSocket?: new (url: string) => WsLike }).WebSocket
  if (!WsImpl) throw new Error('global WebSocket is unavailable (Node >= 22 required)')
  const ws = new WsImpl(wsUrl)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP websocket open timed out: ${wsUrl}`)), timeoutMs)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`CDP websocket connect failed: ${wsUrl}`)) }, { once: true })
  })
  return { client: new CdpClient(ws as never), close: () => { try { ws.close() } catch { /* ignore */ } } }
}

export async function browserWsUrl(port: number): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) })
  if (!r.ok) throw new Error(`/json/version HTTP ${r.status} on port ${port}`)
  const j = (await r.json()) as { webSocketDebuggerUrl?: string }
  if (!j.webSocketDebuggerUrl) throw new Error('browser did not expose webSocketDebuggerUrl')
  return j.webSocketDebuggerUrl
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── source browser process handling ─────────────────────────────────────────

/**
 * Is the source browser currently running ON THE TARGET PROFILE? For a real
 * source (default profile) that means instances WITHOUT --user-data-dir; for
 * an override/synthetic profile it means instances whose command line names
 * THAT directory. Only main processes count (renderer/GPU helpers carry
 * --type= and follow the main process).
 */
async function sourceBrowserPids(browserExe: string, userDataDir: string | null = null, platform: NodeJS.Platform = process.platform): Promise<number[]> {
  const exeBase = basename(browserExe)
  try {
    if (platform === 'win32') {
      const filter = userDataDir
        ? `$_.CommandLine -match [regex]::Escape('--user-data-dir=${userDataDir}') -or $_.CommandLine -match [regex]::Escape('--user-data-dir="${userDataDir}"')`
        : `$_.CommandLine -notmatch '--user-data-dir='`
      const ps = [
        `Get-CimInstance Win32_Process -Filter "Name='${exeBase}'"`,
        `| Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'crashpad' -and (${filter}) }`,
        `| Select-Object -ExpandProperty ProcessId`,
      ].join(' ')
      const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { timeout: 10_000 })
      return String(stdout).split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0)
    }
    const { stdout } = await execFile('pgrep', ['-x', exeBase.replace(/\.exe$/, '')], { timeout: 10_000 }).catch(() => ({ stdout: '' }))
    return String(stdout).split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}

/**
 * Gracefully close the source browser on its default profile: WM_CLOSE to the
 * main process(es) (helpers follow on their own), then wait for exit.
 * The ego agent browser (different --user-data-dir) is never touched.
 */
async function closeSourceBrowser(browserExe: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  try {
    const pids = await sourceBrowserPids(browserExe, null, platform)
    if (pids.length === 0) return true
    if (platform === 'win32') {
      // taskkill without /F sends WM_CLOSE — a graceful shutdown, session
      // tabs restore on the next launch per the user's startup setting.
      for (const pid of pids) {
        await execFile('taskkill', ['/PID', String(pid)], { timeout: 8_000 }).catch(() => null)
      }
    } else {
      for (const pid of pids) {
        try { process.kill(pid, 'SIGTERM') } catch { /* ignore */ }
      }
    }
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if ((await sourceBrowserPids(browserExe, null, platform)).length === 0) return true
      await sleep(500)
    }
    return false
  } catch {
    return false
  }
}

// ── cookie-store backup insurance ───────────────────────────────────────────
//
// Hard lesson (2026-09-15, dev incident on a real Edge profile): an instance
// that considers the cookie store corrupt may RESET it — after a force-killed
// probe, a later boot rewrote the DB with zero rows. Always snapshot the
// store before booting the real profile, and restore if a wipe is detected.

/** Count v10/v20 encrypted-value markers in a cookie DB (0 = wiped/plain). */
export function countEncryptionMarkers(buf: Buffer | string): number {
  const s = typeof buf === 'string' ? buf : buf.toString('latin1')
  let n = 0
  for (let i = 0; i < s.length - 3; i++) {
    const t = s.slice(i, i + 3)
    if (t === 'v10' || t === 'v20') n++
  }
  return n
}

// ── main flow ───────────────────────────────────────────────────────────────

export interface LoginImportOptions {
  /** 'auto' = first detected browser. */
  source?: 'chrome' | 'edge' | 'brave' | 'auto'
  /** Domain whitelist; empty/omitted = ALL cookies (prefer explicit domains). */
  domains?: string[]
  /** Source profile directory name (e.g. "Default"); default = first profile. */
  profile?: string
  /** Only report what would be imported; write nothing. */
  dryRun?: boolean
  /**
   * A running source browser holds an exclusive lock on its cookie store
   * (Windows). When true, gracefully close it (WM_CLOSE to the main process —
   * its windows/tabs restore on next launch), import, and report
   * closedSource:true. When false (default), a locked store yields an
   * actionable error instead.
   */
  closeSource?: boolean
  /** Ego state dir override (tests); defaults to resolveEgoStateDir(). */
  stateDir?: string
  timeoutMs?: number
  /**
   * TEST SEAM: bypass system detection with an explicit browser binary +
   * user-data-dir (e.g. a synthetic throwaway profile). Not exposed by the
   * ego_login_import tool — used by the e2e suite so it never touches real
   * user profiles.
   */
  browserOverride?: SystemBrowser
}

export interface LoginImportReport {
  ok: boolean
  source?: string
  profile?: string
  dryRun?: boolean
  totalRead?: number
  matched?: number
  written?: number
  closedSource?: boolean
  /** True when the source cookie store lost rows during the session and was restored from the pre-boot backup. */
  /** Domain → cookie count. Values never leave this module. */
  domains?: { domain: string; cookies: number }[]
  error?: string
}

interface SpawnLike {
  spawn(spec: {
    argv: readonly string[]
    cwd?: string
    env?: NodeJS.ProcessEnv
    stdio: { stdin: { data: string }; stdout: { maxBytes: number }; stderr: { maxBytes: number } }
    graceMs: number
  }): { done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> }
}

const BATCH = 200

/** Copy ONLY the files a headless Chrome needs to open the cookie jar. The
 *  source profile is never opened by a browser, so #69's destructive write path
 *  cannot run. ABE-bound cookies (Chrome/Edge 127+) will read as 0; the caller
 *  reports that explicitly instead of booting the real profile. */
export async function copyProfileForImport(browser: SystemBrowser, profile: BrowserProfile): Promise<string> {
  const { copyFile } = await import('node:fs/promises')
  const dest = join(tmpdir(), `ego-login-import-${process.pid}-${Date.now()}`)
  await mkdir(join(dest, profile.dirName, 'Network'), { recursive: true })
  const localState = join(browser.userDataDir, 'Local State')
  if (existsSync(localState)) await mkdir(dest, { recursive: true }).then(() => copyFile(localState, join(dest, 'Local State')))
  const cookieFiles: [string, string][] = [
    [join(profile.dir, 'Network', 'Cookies'), join(dest, profile.dirName, 'Network', 'Cookies')],
    [join(profile.dir, 'Cookies'), join(dest, profile.dirName, 'Cookies')],
  ]
  let copied = false
  for (const [src, dst] of cookieFiles) {
    if (!existsSync(src)) continue
    try {
      await copyFile(src, dst)
      copied = true
    } catch (err) {
      throw new Error(`cannot copy the ${browser.label} cookie store (${(err as Error)?.message || err}); quit ${browser.label} completely and retry`)
    }
  }
  if (!copied) throw new Error(`no Cookies database found in ${browser.label} profile ${profile.dirName}`)
  return dest
}

export async function importLoginCookies(opts: LoginImportOptions, deps: { subprocess: SpawnLike }): Promise<LoginImportReport> {
  const timeoutMs = opts.timeoutMs ?? 20_000
  let browser: SystemBrowser | undefined
  if (opts.browserOverride) {
    browser = opts.browserOverride
  } else {
    const browsers = detectSystemBrowsers()
    if (browsers.length === 0) return { ok: false, error: 'no system Chromium browser found (looked for Chrome/Edge/Brave profile + binary)' }
    const wanted = !opts.source || opts.source === 'auto' ? null : opts.source
    browser = wanted ? browsers.find((b) => b.id === wanted) : browsers[0]
    if (!browser) return { ok: false, error: `source "${wanted}" not found on this machine; detected: ${browsers.map((b) => b.id).join(', ')}` }
  }

  // Pick the source profile (used for reporting/selection only — the headless
  // instance boots the REAL user-data-dir, see below).
  let profile: BrowserProfile
  try {
    const localState = await readFile(join(browser.userDataDir, 'Local State'), 'utf8')
    const profiles = profilesFromLocalState(localState, browser.userDataDir)
    profile = (opts.profile ? profiles.find((p) => p.dirName === opts.profile || p.name === opts.profile) : undefined) || profiles[0]
    if (opts.profile && !profiles.some((p) => p.dirName === profile.dirName)) {
      return { ok: false, error: `profile "${opts.profile}" not found in ${browser.label}; available: ${profiles.map((p) => p.dirName).join(', ')}` }
    }
  } catch (err) {
    return { ok: false, error: `cannot read ${browser.label} Local State: ${(err as Error)?.message || err}` }
  }

  // ── the source browser must be CLOSED ────────────────────────────────────
  // ABE (Chrome/Edge 127+) binds cookie decryption to the genuine binary AND
  // the original profile location — booting a copied profile yields zero
  // decryptable cookies, so we boot the real binary headless on the REAL
  // profile instead. That requires exclusive profile access, i.e. no running
  // instance on the default profile (the ego agent browser uses its own
  // --user-data-dir and never conflicts).
  let closedSource = false
  let srcHandle: { done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> } | null = null
  let tempCdp: { client: CdpClient; close: () => void } | null = null
  let egoCdp: { client: CdpClient; close: () => void } | null = null
  let linkDir: string | null = null
  try {
    const runningPids = await sourceBrowserPids(browser.exePath, opts.browserOverride ? browser.userDataDir : null)
    if (runningPids.length > 0) {
      if (opts.browserOverride) {
        return { ok: false, error: 'an instance is already running on the override profile — close it and retry' }
      }
      if (!opts.closeSource) {
        return {
          ok: false,
          error:
            `${browser.label} is running — fully quit it (check the system tray) and retry, ` +
            `or call with closeSource=true to let the tool close it gracefully for you (windows restore on next launch)`,
        }
      }
      const closed = await closeSourceBrowser(browser.exePath)
      if (!closed) return { ok: false, error: `failed to close ${browser.label} automatically — quit it manually and retry` }
      closedSource = true
    }

    // ── copy the minimum profile files to a throwaway directory ────────────
    // SAFETY (#69): never launch the user's REAL profile. The old junction
    // alias booted the genuine profile and could reset extensions / search
    // settings; the copy is the only thing Chrome ever opens here. ABE on
    // Chrome/Edge 127+ is bound to the original path, so this copy may yield 0
    // cookies — handled below as a clear, non-destructive failure.
    linkDir = await copyProfileForImport(browser, profile)
    // A previous import may still be draining (Browser.close flushes) while
    // holding its own singleton; the copy path is unique, but wait briefly so
    // cleanup does not race an old instance.
    if (process.platform === 'win32') {
      const ps = [
        `Get-CimInstance Win32_Process -Filter "Name='${basename(browser.exePath)}'"`,
        `| Where-Object { $_.CommandLine -match 'ego-login-import-' -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'crashpad' }`,
        `| Select-Object -ExpandProperty ProcessId`,
      ].join(' ')
      const drainDeadline = Date.now() + 8_000
      let leftover: string[] = []
      while (Date.now() < drainDeadline) {
        try {
          const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { timeout: 8_000 })
          leftover = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
          if (leftover.length === 0) break
        } catch { break }
        await sleep(600)
      }
      if (leftover.length > 0) {
        for (const line of leftover) {
          const pid = Number(line)
          if (Number.isInteger(pid) && pid > 0) await execFile('taskkill', ['/PID', String(pid), '/F'], { timeout: 5_000 }).catch(() => null)
        }
        await sleep(1000)
      }
    }
    let port: number | null = null
    for (let attempt = 0; attempt < 2 && port === null; attempt++) {
      if (attempt > 0) {
        await sleep(2000)
        try { await rm(linkDir, { recursive: true, force: true }) } catch { /* ignore */ }
        linkDir = await copyProfileForImport(browser, profile)
      }
      const portFile = join(linkDir!, 'DevToolsActivePort')
      await rm(portFile, { force: true }).catch(() => null)
      srcHandle = deps.subprocess.spawn({
        argv: [
          browser.exePath,
          '--headless=new',
          `--user-data-dir=${linkDir}`,
          `--profile-directory=${profile.dirName}`,
          '--remote-debugging-port=0',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
          '--disable-sync',
          '--hide-crash-restore-bubble',
          'about:blank',
        ],
        cwd: tmpdir(),
        env: { ...process.env },
        stdio: { stdin: { data: '' }, stdout: { maxBytes: 2048 }, stderr: { maxBytes: 4096 } },
        graceMs: 8_000,
      })
      srcHandle.done.catch(() => null)

      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        try {
          port = parseDevToolsActivePort(await readFile(portFile, 'utf8'))
          if (port !== null) break
        } catch { /* not written yet */ }
        await sleep(250)
      }
    }
    if (port === null) return { ok: false, closedSource, error: `${browser.label} headless instance did not expose a DevTools port within ${timeoutMs}ms (another instance may be holding the profile)` }

    tempCdp = await connectCdp(await browserWsUrl(port), 5000)
    // The DevTools endpoint comes up BEFORE the cookie store finishes loading
    // — an immediate Storage.getCookies can legitimately return 0 on a warm
    // profile. Poll briefly; an actually-empty jar just costs a few seconds.
    let all: CdpCookie[] = []
    // [#60-2] Cold start loads the cookie store PROGRESSIVELY — the old
    // "first non-empty wins" loop exited on a 1-cookie warmup reply and
    // imported 0 cookies while reporting ok. Exit on a STABLE count instead
    // (3 consecutive identical reads), bounded by the overall timeout.
    let stable = 0
    let lastCount = -1
    const readDeadline = Date.now() + timeoutMs
    while (Date.now() < readDeadline) {
      const got = (await tempCdp.client.call('Storage.getCookies')) as { cookies?: CdpCookie[] }
      all = Array.isArray(got.cookies) ? got.cookies : []
      if (all.length > 0 && all.length === lastCount) {
        stable += 1
        if (stable >= 2) break
      } else {
        stable = 0
      }
      lastCount = all.length
      await sleep(800)
    }
    if (all.length === 0) {
      return {
        ok: false,
        source: browser.label,
        profile: profile.dirName,
        dryRun: opts.dryRun === true,
        closedSource,
        totalRead: 0,
        matched: 0,
        written: 0,
        domains: [],
        error:
          `0 cookies readable from the temporary copy of ${browser.label}. Chrome/Edge 127+ use App-Bound Encryption bound to ` +
          'the original profile path, so a copied profile cannot be decrypted (the source profile was NOT modified). ' +
          'Use the Chrome extension bridge (A) or log in once inside the agent browser; the old real-profile boot path has been removed.',
      }
    }
    const matched = all.filter((c) => cookieMatchesDomains(c.domain, opts.domains || []))

    // Domain stats — the ONLY data that ever leaves this module about cookies.
    const byDomain = new Map<string, number>()
    for (const c of matched) byDomain.set(c.domain, (byDomain.get(c.domain) || 0) + 1)
    const domainStats = [...byDomain.entries()].map(([domain, cookies]) => ({ domain, cookies })).sort((a, b) => b.cookies - a.cookies)

    if (opts.dryRun) {
      return { ok: true, source: browser.label, profile: profile.dirName, dryRun: true, closedSource, totalRead: all.length, matched: matched.length, written: 0, domains: domainStats }
    }

    // ── write into the running ego agent browser ───────────────────────────
    const stateDir = opts.stateDir || resolveEgoStateDir()
    let egoPort: number
    try {
      const bj = JSON.parse(await readFile(join(stateDir, 'browser.json'), 'utf8')) as { port?: unknown }
      if (typeof bj.port !== 'number' || bj.port <= 0) throw new Error('no port in browser.json')
      egoPort = bj.port
    } catch {
      return { ok: false, closedSource, error: 'agent browser is not running (no browser.json) — call ego_status or any ego_* tool first, then retry the import' }
    }
    egoCdp = await connectCdp(await browserWsUrl(egoPort), 5000)

    const params = matched.map(toCookieParam).filter((p): p is Record<string, unknown> => p !== null)
    const egoClient = egoCdp.client

    // Every jar the import must reach: the default browser context, PLUS every
    // live ISOLATED space context. With EGO_ISOLATE_SPACES=1 a space owns a
    // context seeded from the default jar at CREATION time — a point-in-time
    // copy (runtime/egolinux/task-spaces.mjs createSeededContext), never live
    // shared state — so cookies imported later never reach an already-open
    // space and its pages keep looking logged out. With isolation off (the
    // default) no extra contexts exist and this list stays `[undefined]`.
    const jarTargets: (string | undefined)[] = [undefined]
    try {
      const spacesRaw = await readFile(join(stateDir, 'task-spaces.json'), 'utf8')
      const parsed = JSON.parse(spacesRaw) as { spaces?: { browserContextId?: unknown }[] }
      for (const space of parsed.spaces ?? []) {
        const id = space?.browserContextId
        if (typeof id === 'string' && id !== '') jarTargets.push(id)
      }
    } catch { /* no space state on disk = no isolated contexts to sync */ }

    // '|' cannot realistically appear inside a cookie name, domain, or path.
    const jarKey = (domain: unknown, name: unknown, path: unknown): string =>
      `${String(name)}|${String(domain).replace(/^\./, '')}|${String(path ?? '/')}`

    // [#60] Server-side confirmation: write each jar, then read it back and
    // count what actually landed. A stale browser.json (dead or replaced agent
    // instance) otherwise reports success while the user's logins never arrive.
    const writeJar = async (contextId: string | undefined): Promise<number> => {
      const scoped = contextId === undefined ? {} : { browserContextId: contextId }
      for (let i = 0; i < params.length; i += BATCH) {
        await egoClient.call('Storage.setCookies', { cookies: params.slice(i, i + BATCH), ...scoped })
      }
      const back = (await egoClient.call('Storage.getCookies', scoped)) as { cookies?: CdpCookie[] }
      const have = new Set((back.cookies ?? []).map((c) => jarKey(c.domain, c.name, c.path)))
      return params.filter((p) => have.has(jarKey(p.domain, p.name, p.path))).length
    }

    let written: number
    try {
      written = await writeJar(undefined)
      for (const contextId of jarTargets.slice(1)) {
        // A dead space context must not fail the whole import: the default jar
        // (what the agent uses with isolation off) already received its copy.
        try { await writeJar(contextId) } catch { /* space context gone */ }
      }
    } catch {
      written = -1
    }
    if (params.length > 0 && written === 0) {
      return {
        ok: false,
        source: browser.label,
        profile: profile.dirName,
        dryRun: false,
        closedSource,
        totalRead: all.length,
        matched: matched.length,
        written: 0,
        error:
          'the agent browser accepted no cookies — its CDP endpoint may belong to a stale or replaced instance; restart the agent browser (ego_status after closing it) and retry',
      }
    }
    return { ok: true, source: browser.label, profile: profile.dirName, dryRun: false, closedSource, totalRead: all.length, matched: matched.length, written, domains: domainStats }
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err) }
  } finally {
    try { tempCdp?.close() } catch { /* ignore */ }
    try { egoCdp?.close() } catch { /* ignore */ }
    // The temp copy is a normal profile for a throwaway headless instance; a
    // bounded wait is enough. Never touch the real profile: there is no backup
    // restore step anymore because no browser ever opened it.
    if (srcHandle) {
      try { await Promise.race([srcHandle.done, sleep(8_000)]) } catch { /* ignore */ }
      if (process.platform === 'win32' && linkDir) {
        try {
          const ps = [
            `Get-CimInstance Win32_Process -Filter "Name='${basename(browser.exePath)}'"`,
            `| Where-Object { $_.CommandLine -match 'ego-login-import-' -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'crashpad' }`,
            `| Select-Object -ExpandProperty ProcessId`,
          ].join(' ')
          const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { timeout: 8_000 })
          for (const line of String(stdout).split(/\r?\n/)) {
            const pid = Number(line.trim())
            if (Number.isInteger(pid) && pid > 0) await execFile('taskkill', ['/PID', String(pid), '/F'], { timeout: 5_000 }).catch(() => null)
          }
        } catch { /* ignore */ }
      }
    }
    if (linkDir) { try { await rm(linkDir, { recursive: true, force: true }) } catch { /* ignore */ } }
  }
}
