/**
 * ego-browser login-import — copy login cookies from the system's daily-use
 * Chromium (Chrome/Edge/Brave) into the running ego agent browser (issue #46).
 *
 * Why CDP passthrough instead of offline decryption: Chrome/Edge 127+ protect
 * cookies with App-Bound Encryption (the `v20` prefix) — the decryption chain
 * is bound to the genuine browser binary AND the original profile location
 * (verified empirically: a copied profile yields zero decryptable cookies
 * even under the genuine binary). So the classic "copy the profile to a temp
 * dir + boot headless" route is dead, as is the older "SQLite + DPAPI" one.
 *
 * What works: when the source browser is CLOSED, launch its genuine binary
 * headless on its REAL profile — reached through a JUNCTION/symlink alias.
 * Two upstream defenses make both halves of this necessary (verified
 * empirically on Edge 140 / Windows):
 *   - Chromium ≥ 136 refuses --remote-debugging-port on the DEFAULT
 *     user-data-dir (anti-scraping). The string comparison does not resolve
 *     junctions, so the alias path passes.
 *   - App-Bound Encryption (v20 cookies) binds decryption to the genuine
 *     binary AND the original profile location: a copied profile yields zero
 *     decryptable cookies, while the junction (which resolves to the real
 *     path) decrypts everything.
 * Then read plaintext cookies over CDP `Storage.getCookies`, filter by
 * domain, and write them into the ego browser's persistent profile with
 * `Storage.setCookies`. closeSource:true gracefully closes a running source
 * browser first (its windows restore on next launch).
 *
 * Security contract:
 *   - cookie VALUES never appear in logs, tool output, or reports — only
 *     domain names and counts;
 *   - nothing is written to the source profile except what a normal headless
 *     boot writes (same as the user opening and closing their browser);
 *   - import is a one-shot snapshot, never a continuous sync.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, symlink } from 'node:fs/promises'
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

async function connectCdp(wsUrl: string, timeoutMs: number): Promise<{ client: CdpClient; close: () => void }> {
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

async function browserWsUrl(port: number): Promise<string> {
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

interface BackupInfo {
  dir: string
  markers: number
}

/** Best-effort snapshot of the cookie store before we boot the profile. */
async function backupCookieStore(profileDir: string, backupRoot: string): Promise<BackupInfo | null> {
  const src = join(profileDir, 'Network', 'Cookies')
  if (!existsSync(src)) return null
  try {
    const dir = join(backupRoot, `backup-${Date.now()}`)
    await mkdir(dir, { recursive: true })
    const { copyFile, readdir } = await import('node:fs/promises')
    await copyFile(src, join(dir, 'Cookies'))
    try { await copyFile(src + '-journal', join(dir, 'Cookies-journal')) } catch { /* optional */ }
    const markers = countEncryptionMarkers(await readFile(src))
    // Prune: keep only the 3 newest backups.
    try {
      const entries = (await readdir(backupRoot)).filter((e) => e.startsWith('backup-')).sort()
      for (const old of entries.slice(0, Math.max(0, entries.length - 3))) {
        await rm(join(backupRoot, old), { recursive: true, force: true }).catch(() => null)
      }
    } catch { /* prune is best-effort */ }
    return { dir, markers }
  } catch {
    return null
  }
}

/** If the store lost its encrypted rows during our session, restore the backup. */
async function restoreIfWiped(profileDir: string, backup: BackupInfo | null): Promise<boolean> {
  if (!backup || backup.markers === 0) return false
  const src = join(profileDir, 'Network', 'Cookies')
  try {
    const current = countEncryptionMarkers(await readFile(src))
    if (current > 0) return false
    const { copyFile } = await import('node:fs/promises')
    await copyFile(join(backup.dir, 'Cookies'), src)
    try { await copyFile(join(backup.dir, 'Cookies-journal'), src + '-journal') } catch { /* optional */ }
    return true
  } catch {
    return false
  }
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
  restoredFromBackup?: boolean
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
  let backup: BackupInfo | null = null
  let pendingReport: LoginImportReport | null = null
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

    // Insurance: snapshot the cookie store BEFORE booting the real profile.
    // A boot that judges the store corrupt can reset it (observed in the
    // wild); restoreIfWiped in finally brings it back if that happens.
    backup = await backupCookieStore(profile.dir, join(opts.stateDir || resolveEgoStateDir(), 'login-import-backups'))

    // ── boot the genuine binary headless on the REAL profile ───────────────
    // Reached through a junction/symlink alias: Chromium ≥136 refuses CDP on
    // the default user-data-dir (string compare, alias passes), while ABE
    // resolves the junction to the genuine profile location (decryption
    // works). The only writes to the profile are what a normal headless boot
    // performs; Browser.close in finally keeps the shutdown graceful so no
    // crash-restore mark is earned.
    linkDir = join(tmpdir(), `ego-login-import-${process.pid}-${Date.now()}`)
    await symlink(browser.userDataDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir')
    // A previous import's instance may still be draining (Browser.close flushes
    // the cookie store before exit) while holding the profile singleton lock —
    // a new spawn would forward to it and never open a DevTools port. Wait for
    // any lingering import instance of this browser family to exit first.
    if (process.platform === 'win32') {
      const ps = [
        `Get-CimInstance Win32_Process -Filter "Name='${basename(browser.exePath)}'"`,
        `| Where-Object { $_.CommandLine -match 'ego-login-import-' -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'crashpad' }`,
        `| Select-Object -ExpandProperty ProcessId`,
      ].join(' ')
      const drainDeadline = Date.now() + 12_000
      let leftover: string[] = []
      while (Date.now() < drainDeadline) {
        try {
          const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { timeout: 8_000 })
          leftover = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
          if (leftover.length === 0) break
        } catch { break }
        await sleep(600)
      }
      // Headless instances ignore WM_CLOSE (no window) — after the grace
      // window, force-kill OUR OWN throwaway leftovers so the singleton frees.
      if (leftover.length > 0) {
        for (const line of leftover) {
          const pid = Number(line)
          if (Number.isInteger(pid) && pid > 0) await execFile('taskkill', ['/PID', String(pid), '/F'], { timeout: 5_000 }).catch(() => null)
        }
        await sleep(1500)
      }
    }
    // Clear any stale DevToolsActivePort from previous (normal or crashed)
    // launches so the poll below only ever reads THIS instance's port.
    let port: number | null = null
    // Back-to-back imports race the PREVIOUS instance's drain (cookie-store
    // flush can outlive the 12s drain window): a spawn while it still holds
    // the profile singleton forwards and never opens a port. Retry once with
    // a fresh junction after a longer drain.
    for (let attempt = 0; attempt < 2 && port === null; attempt++) {
      if (attempt > 0) {
        await sleep(6000)
        try { await rm(linkDir, { force: true }) } catch { /* ignore */ }
        linkDir = join(tmpdir(), `ego-login-import-${process.pid}-${Date.now()}-r1`)
        await symlink(browser.userDataDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir')
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
        cwd: browser.userDataDir,
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
    for (let attempt = 0; attempt < 8; attempt++) {
      const got = (await tempCdp.client.call('Storage.getCookies')) as { cookies?: CdpCookie[] }
      all = Array.isArray(got.cookies) ? got.cookies : []
      if (all.length > 0 || attempt === 7) break
      await sleep(800)
    }
    const matched = all.filter((c) => cookieMatchesDomains(c.domain, opts.domains || []))

    // Domain stats — the ONLY data that ever leaves this module about cookies.
    const byDomain = new Map<string, number>()
    for (const c of matched) byDomain.set(c.domain, (byDomain.get(c.domain) || 0) + 1)
    const domainStats = [...byDomain.entries()].map(([domain, cookies]) => ({ domain, cookies })).sort((a, b) => b.cookies - a.cookies)

    if (opts.dryRun) {
      pendingReport = { ok: true, source: browser.label, profile: profile.dirName, dryRun: true, closedSource, totalRead: all.length, matched: matched.length, written: 0, domains: domainStats }
      return pendingReport
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
    let written = 0
    for (let i = 0; i < params.length; i += BATCH) {
      await egoCdp.client.call('Storage.setCookies', { cookies: params.slice(i, i + BATCH) })
      written += Math.min(BATCH, params.length - i)
    }
    pendingReport = { ok: true, source: browser.label, profile: profile.dirName, dryRun: false, closedSource, totalRead: all.length, matched: matched.length, written, domains: domainStats }
    return pendingReport
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err) }
  } finally {
    // Every exit path: close CDP sockets, gracefully shut down the headless
    // source instance (Browser.close — no crash-restore mark), then remove
    // the junction alias. rm() on a junction/symlink removes the LINK only —
    // the real profile is never touched by cleanup.
    try { tempCdp?.close() } catch { /* ignore */ }
    try { egoCdp?.close() } catch { /* ignore */ }
    if (tempCdp) { try { await tempCdp.client.call('Browser.close', {}, undefined, 2000) } catch { /* ignore */ } }
    // Browser.close flushes the cookie store before the process exits — this
    // can take 10s+ on a warm profile, and the singleton is keyed on the
    // RESOLVED profile path, so the NEXT import on the same source blocks
    // until this instance is really gone. Wait properly; escalate only if it
    // still will not die (a throwaway headless instance, safe to close).
    if (srcHandle) {
      try { await Promise.race([srcHandle.done, sleep(25_000)]) } catch { /* ignore */ }
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
            // /F: a HEADLESS instance has no window for WM_CLOSE to reach —
            // a graceful taskkill is a no-op on it. The cookie store was
            // already flushed by Browser.close above (or the instance never
            // answered it, in which case the pre-boot backup has us covered).
            if (Number.isInteger(pid) && pid > 0) await execFile('taskkill', ['/PID', String(pid), '/F'], { timeout: 5_000 }).catch(() => null)
          }
          if (String(stdout).trim()) await Promise.race([srcHandle.done, sleep(5000)])
        } catch { /* ignore */ }
      }
    }
    if (linkDir) { try { await rm(linkDir, { force: true }) } catch { /* ignore */ } }
    // Restore insurance AFTER the instance is fully closed.
    if (await restoreIfWiped(profile.dir, backup)) {
      if (pendingReport) pendingReport.restoredFromBackup = true
    }
  }
}
