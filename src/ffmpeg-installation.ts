import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, chmod, copyFile, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { isIP } from 'node:net'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { platformManifest, rewriteGithubUrl } from './ffmpeg-manifest.ts'
import { probeFfmpeg, type SpawnFn } from './ffmpeg-probe.ts'

export function defaultFfmpegCacheRoot(home: string = homedir()): string {
  return join(home, '.dsh', 'cache', 'ego-browser', 'ffmpeg')
}

const SHARED_MANAGERS_KEY = Symbol.for('dsh-ego-browser.ffmpeg-installation-managers')

type SharedManagers = Map<string, FfmpegInstallationManager>

function getSharedManagers(): SharedManagers {
  const existing = (globalThis as unknown as Record<symbol, SharedManagers>)[SHARED_MANAGERS_KEY]
  if (existing) return existing
  const fresh: SharedManagers = new Map()
  ;(globalThis as unknown as Record<symbol, SharedManagers>)[SHARED_MANAGERS_KEY] = fresh
  return fresh
}

export type FfmpegState = 'unsupported' | 'missing' | 'checking' | 'ready' | 'downloading' | 'verifying' | 'extracting' | 'probing' | 'failed'

export interface FfmpegProgress {
  receivedBytes: number
  totalBytes: number | null
  percent: number | null
}

export interface FfmpegCandidate {
  source: string
  path: string
  usable?: boolean
  version?: string
  encoder?: string
  code?: string
  reason?: string
}

export interface FfmpegStatus {
  state: FfmpegState
  source: string | null
  path: string | null
  version: string | null
  encoder: string | null
  progress: FfmpegProgress | null
  canDownload: boolean
  canSelectFfmpeg: boolean
  updateAvailable: boolean
  reason: string | null
  candidates: FfmpegCandidate[]
  platform: NodeJS.Platform
  arch: string
  buildId: string | null
}

export interface FfmpegInstallationManagerOptions {
  getConfig?: () => Record<string, unknown>
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  cacheRoot?: string
  fetchImpl?: typeof globalThis.fetch
  spawn?: SpawnFn
}

export interface CheckOptions {
  configuredPath?: string
  requestedEncoder?: string
}

export interface InstallOptions {
  githubMirror?: string
  configuredPath?: string
  requestedEncoder?: string
}

export function getSharedFfmpegInstallationManager(options: FfmpegInstallationManagerOptions = {}): FfmpegInstallationManager {
  const platform = options.platform || process.platform
  const arch = options.arch || process.arch
  const cacheRoot = options.cacheRoot || defaultFfmpegCacheRoot()
  const key = `${platform}:${arch}:${cacheRoot}`
  const managers = getSharedManagers()
  if (!managers.has(key)) managers.set(key, new FfmpegInstallationManager({ ...options, platform, arch, cacheRoot }))
  return managers.get(key)!
}

export class FfmpegInstallationManager {
  getConfig: () => Record<string, unknown>
  platform: NodeJS.Platform
  arch: string
  env: NodeJS.ProcessEnv
  cacheRoot: string
  fetch: typeof globalThis.fetch
  spawn: SpawnFn
  manifest: ReturnType<typeof platformManifest>
  installPromise: Promise<FfmpegStatus> | null
  checkPromise: Promise<FfmpegStatus> | null
  checkKey: string | null
  statusValue: FfmpegStatus

  constructor({
    getConfig = () => ({}),
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    cacheRoot = defaultFfmpegCacheRoot(),
    fetchImpl = globalThis.fetch,
    spawn = nodeSpawn as unknown as SpawnFn,
  }: FfmpegInstallationManagerOptions = {}) {
    this.getConfig = getConfig
    this.platform = platform
    this.arch = arch
    this.env = env
    this.cacheRoot = cacheRoot
    this.fetch = fetchImpl
    this.spawn = spawn
    this.manifest = platformManifest(platform, arch)
    this.installPromise = null
    this.checkPromise = null
    this.checkKey = null
    this.statusValue = this.#baseStatus()
  }

  #baseStatus(): FfmpegStatus {
    const unsupported = this.platform === 'linux' && (this.env.XDG_SESSION_TYPE === 'wayland' || this.env.WAYLAND_DISPLAY)
    return {
      state: unsupported ? 'unsupported' : 'missing', source: null, path: null, version: null, encoder: null,
      progress: null, canDownload: !unsupported && !!this.manifest, canSelectFfmpeg: false,
      updateAvailable: false, reason: unsupported ? 'Wayland capture is not supported' : null, candidates: [],
      platform: this.platform, arch: this.arch, buildId: this.manifest?.buildId || null,
    }
  }

  status(): FfmpegStatus {
    return structuredClone(this.statusValue)
  }

  managedPath(): string | null {
    if (!this.manifest) return null
    return join(this.cacheRoot, `${this.platform}-${this.arch}`, this.manifest.buildId, this.manifest.executableName)
  }

  async check({ configuredPath, requestedEncoder = 'auto' }: CheckOptions = {}): Promise<FfmpegStatus> {
    if (this.installPromise) return this.status()
    const key = JSON.stringify([configuredPath ?? '', requestedEncoder])
    if (this.checkPromise) {
      if (this.checkKey === key) return this.checkPromise
      await this.checkPromise.catch(() => {
        /* swallow */
      })
    }
    if (this.statusValue.state === 'unsupported') return this.status()
    this.checkKey = key
    const promise = this.#check(configuredPath, requestedEncoder).finally(() => {
      if (this.checkPromise === promise) {
        this.checkPromise = null
        this.checkKey = null
      }
    })
    this.checkPromise = promise
    return this.checkPromise
  }

  async #check(configuredPath?: string, requestedEncoder: string = 'auto'): Promise<FfmpegStatus> {
    this.#set({ state: 'checking', reason: null, progress: null, canSelectFfmpeg: false })
    const custom = configuredPath ?? (this.getConfig().ffmpegPath as string | undefined) ?? ''
    const candidates: FfmpegCandidate[] = []
    if (custom) candidates.push({ source: 'custom', path: custom })
    candidates.push({ source: 'system', path: 'ffmpeg' })
    const managed = this.managedPath()
    if (managed) candidates.push({ source: 'managed', path: managed })
    const results: FfmpegCandidate[] = []
    for (const candidate of candidates) {
      try {
        const probe = await probeFfmpeg(candidate.path, { platform: this.platform, env: this.env, spawn: this.spawn, requestedEncoder })
        results.push({ ...candidate, usable: true, version: probe.version, encoder: probe.encoder })
        this.#set({
          state: 'ready', source: candidate.source, path: candidate.path, version: probe.version, encoder: probe.encoder,
          canSelectFfmpeg: true, canDownload: !!this.manifest, reason: null, candidates: results,
          updateAvailable: candidate.source === 'managed' && !normalize(candidate.path).includes(normalize(this.manifest?.buildId || '')),
        })
        return this.status()
      } catch (error) {
        const e = error as CodedError
        results.push({ ...candidate, usable: false, code: e.code || 'ffmpeg-unavailable', reason: e.message })
      }
    }
    this.#set({ ...this.#baseStatus(), state: 'missing', candidates: results, reason: results[0]?.reason || 'No compatible FFmpeg installation was found' })
    return this.status()
  }

  async resolvedPath(): Promise<string | null> {
    const status = this.statusValue.state === 'ready' ? this.status() : await this.check()
    return status.canSelectFfmpeg ? status.path : null
  }

  install({ githubMirror, configuredPath, requestedEncoder = 'auto' }: InstallOptions = {}): Promise<FfmpegStatus> {
    if (this.installPromise) return this.installPromise
    if (!this.manifest) return Promise.reject(codedError('ffmpeg-platform-unsupported', `No managed FFmpeg build for ${this.platform}-${this.arch}`))
    this.installPromise = this.#install(githubMirror ?? (this.getConfig().githubMirror as string | undefined) ?? '', configuredPath ?? (this.getConfig().ffmpegPath as string | undefined) ?? '', requestedEncoder)
      .finally(() => {
        this.installPromise = null
      })
    return this.installPromise
  }

  startInstall(options: InstallOptions = {}): FfmpegStatus {
    void this.install(options).catch(() => {
      /* fire-and-forget */
    })
    return this.status()
  }

  async #install(githubMirror: string, configuredPath: string, requestedEncoder: string): Promise<FfmpegStatus> {
    const manifest = this.manifest!
    const platformRoot = join(this.cacheRoot, `${this.platform}-${this.arch}`)
    const tempRoot = join(platformRoot, `.install-${randomUUID()}`)
    const archivePath = join(tempRoot, `archive.${manifest.archiveType === 'gzip' ? 'gz' : 'pkg'}`)
    const extractedPath = join(tempRoot, manifest.executableName)
    const finalRoot = join(platformRoot, manifest.buildId)
    const finalPath = join(finalRoot, manifest.executableName)
    let releaseLock: (() => Promise<void>) | null = null
    let backup: string | null = null
    let published = false
    try {
      await mkdir(platformRoot, { recursive: true })
      releaseLock = await acquireInstallLock(platformRoot)
      await cleanupInterruptedInstalls(platformRoot)
      if (manifest.archiveType === 'tar') await ensureTarAvailable(this.spawn)
      await mkdir(tempRoot, { recursive: true })
      const url = rewriteGithubUrl(manifest.url, githubMirror)
      this.#set({ state: 'downloading', reason: null, progress: { receivedBytes: 0, totalBytes: manifest.size, percent: 0 }, canSelectFfmpeg: false })
      const digest = await downloadFile(url, archivePath, {
        fetchImpl: this.fetch, expectedSize: manifest.size,
        onProgress: (progress) => this.#set({ state: 'downloading', progress }),
      })
      this.#set({ state: 'verifying', progress: null })
      if (digest !== manifest.sha256) throw codedError('ffmpeg-checksum-mismatch', 'Downloaded FFmpeg archive failed SHA-256 verification')
      this.#set({ state: 'extracting' })
      if (manifest.archiveType === 'gzip') {
        await pipeline(createReadStream(archivePath), createGunzip(), createWriteStream(extractedPath, { mode: 0o755 }))
      } else {
        await extractWithTar(archivePath, tempRoot, extractedPath, manifest.archiveExecutable!, this.spawn)
      }
      if (this.platform !== 'win32') await chmod(extractedPath, 0o755)
      if (this.platform === 'darwin') await prepareMacExecutable(extractedPath, this.arch, this.spawn)
      this.#set({ state: 'probing' })
      const probe = await probeFfmpeg(extractedPath, { platform: this.platform, env: this.env, spawn: this.spawn, requestedEncoder })
      const executableSha256 = await hashFile(extractedPath)
      await writeFile(join(tempRoot, 'install.json'), JSON.stringify({
        provider: manifest.provider, buildId: manifest.buildId, archiveSha256: manifest.sha256,
        executableSha256, installedAt: new Date().toISOString(), version: probe.version, encoder: probe.encoder,
      }, null, 2))
      await rm(archivePath, { force: true })
      backup = `${finalRoot}.old-${randomUUID()}`
      let hadExisting = false
      try {
        await rename(finalRoot, backup)
        hadExisting = true
      } catch (error) {
        const e = error as NodeJS.ErrnoException
        if (e.code !== 'ENOENT') throw error
      }
      await mkdir(dirname(finalRoot), { recursive: true })
      await rename(tempRoot, finalRoot)
      published = true
      await access(finalPath, this.platform === 'win32' ? constants.F_OK : constants.X_OK)
      if (hadExisting) await rm(backup, { recursive: true, force: true })
      backup = null
      return await this.#check(configuredPath, requestedEncoder)
    } catch (error) {
      if (published) await rm(finalRoot, { recursive: true, force: true }).catch(() => {
        /* ignore */
      })
      if (backup) await rename(backup, finalRoot).catch(() => {
        /* ignore */
      })
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {
        /* ignore */
      })
      const e = error as Error
      this.#set({ state: 'failed', reason: e.message, progress: null, canSelectFfmpeg: false, canDownload: true })
      throw error
    } finally {
      await releaseLock?.()
    }
  }

  #set(patch: Partial<FfmpegStatus>): void {
    this.statusValue = { ...this.statusValue, ...patch }
  }
}

async function acquireInstallLock(platformRoot: string): Promise<() => Promise<void>> {
  const lockPath = join(platformRoot, '.install.lock')
  const token = randomUUID()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx')
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }))
      return async () => {
        await handle.close().catch(() => {
          /* ignore */
        })
        const owner = await readFile(lockPath, 'utf8').then((text) => JSON.parse(text) as LockOwner).catch(() => null)
        if (owner?.token === token) await rm(lockPath, { force: true }).catch(() => {
          /* ignore */
        })
      }
    } catch (error) {
      const e = error as NodeJS.ErrnoException
      if (e.code !== 'EEXIST') throw error
      const owner = await readFile(lockPath, 'utf8').then((text) => JSON.parse(text) as LockOwner).catch(() => null)
      if (!owner?.pid || !isProcessAlive(owner.pid)) {
        await rm(lockPath, { force: true })
        continue
      }
      throw codedError('ffmpeg-install-busy', 'Another FFmpeg installation is already running')
    }
  }
  throw codedError('ffmpeg-install-busy', 'Another FFmpeg installation is already running')
}

interface LockOwner {
  token?: string
  pid?: number
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (error) {
    const e = error as NodeJS.ErrnoException
    return e?.code === 'EPERM'
  }
}

async function cleanupInterruptedInstalls(platformRoot: string): Promise<void> {
  const entries = await readdir(platformRoot, { withFileTypes: true }).catch((error) => {
    const e = error as NodeJS.ErrnoException
    return e.code === 'ENOENT' ? [] : Promise.reject(error) as Promise<import('node:fs').Dirent[]>
  })
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('.install-'))
      .map((entry) => rm(join(platformRoot, entry.name), { recursive: true, force: true })),
  )
}

export interface DownloadFileOptions {
  fetchImpl?: typeof globalThis.fetch
  expectedSize?: number | null
  onProgress?: (progress: FfmpegProgress) => void
  maxBytes?: number
}

export async function downloadFile(
  url: string,
  target: string,
  { fetchImpl = globalThis.fetch, expectedSize = null, onProgress = () => {}, maxBytes = 250 * 1024 * 1024 }: DownloadFileOptions = {},
): Promise<string> {
  let current = url
  let response: Response | undefined
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    assertSafeDownloadUrl(current)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      response = await fetchImpl(current, { redirect: 'manual', signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location')
    if (!location) throw codedError('ffmpeg-download-failed', 'FFmpeg download redirect omitted Location')
    current = new URL(location, current).toString()
    await response.body?.cancel().catch(() => {
      /* ignore */
    })
    if (!current.startsWith('https://')) throw codedError('ffmpeg-download-failed', 'FFmpeg download refused a non-HTTPS redirect')
    if (redirects === 5) throw codedError('ffmpeg-download-failed', 'Too many FFmpeg download redirects')
  }
  if (!response?.ok || !response.body) throw codedError('ffmpeg-download-failed', `FFmpeg download failed with HTTP ${response?.status || 0}`)
  const declared = Number(response.headers.get('content-length')) || expectedSize || null
  const hash = createHash('sha256')
  const file = await open(target, 'w')
  let received = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await readChunk(reader, 30000)
      if (done) break
      const buffer = Buffer.from(value)
      received += buffer.length
      if (received > maxBytes) throw codedError('ffmpeg-download-failed', 'FFmpeg archive exceeds the allowed size')
      hash.update(buffer)
      await file.write(buffer)
      onProgress({ receivedBytes: received, totalBytes: declared, percent: declared ? Math.min(100, Math.round((received * 100) / declared)) : null })
    }
  } finally {
    await reader.cancel().catch(() => {
      /* ignore */
    })
    await file.close()
  }
  return hash.digest('hex')
}

async function ensureTarAvailable(spawn: SpawnFn): Promise<void> {
  try {
    await runCommand('tar', ['--version'], spawn, 5000)
  } catch {
    throw codedError('ffmpeg-extractor-unavailable', 'The managed FFmpeg archive requires the system tar extractor')
  }
}

function assertSafeDownloadUrl(value: string): void {
  const url = new URL(value)
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (url.protocol !== 'https:' || host === 'localhost' || host.endsWith('.localhost') || isPrivateIp(host)) {
    throw codedError('ffmpeg-download-failed', 'FFmpeg downloads require a public HTTPS destination')
  }
}

function isPrivateIp(host: string): boolean {
  const family = isIP(host)
  if (family === 4) {
    const [a, b] = host.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  if (family === 6) return host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')
  return false
}

async function extractWithTar(archivePath: string, tempRoot: string, destination: string, matcher: RegExp, spawn: SpawnFn): Promise<void> {
  const listing = await runCommand('tar', ['-tf', archivePath], spawn, 15000)
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean)
  const matches = entries.filter((entry) => safeArchiveEntry(entry) && matcher.test(entry))
  if (matches.length !== 1) throw codedError('ffmpeg-executable-missing', `Expected one FFmpeg executable in archive, found ${matches.length}`)
  const entry = matches[0]!
  await runCommand('tar', ['-xf', archivePath, '-C', tempRoot, entry], spawn, 60000)
  const extracted = resolve(tempRoot, normalize(entry))
  if (!extracted.startsWith(resolve(tempRoot) + sep)) throw codedError('ffmpeg-archive-unsafe', 'FFmpeg archive path escaped the install directory')
  await copyFile(extracted, destination)
}

function safeArchiveEntry(entry: string): boolean {
  const value = entry.replaceAll('\\', '/')
  return value !== '' && !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && !value.split('/').includes('..')
}

async function prepareMacExecutable(path: string, arch: string, spawn: SpawnFn): Promise<void> {
  await runCommand('xattr', ['-d', 'com.apple.quarantine', path], spawn, 5000).catch(() => {
    /* ignore */
  })
  if (arch === 'arm64') await runCommand('codesign', ['--force', '--sign', '-', path], spawn, 15000).catch(() => {
    /* ignore */
  })
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(codedError('ffmpeg-download-timeout', 'FFmpeg download stalled')), timeoutMs)
    reader.read().then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

interface RunCommandResult {
  stdout: string
  stderr: string
}

function runCommand(command: string, argv: readonly string[], spawn: SpawnFn, timeoutMs: number): Promise<RunCommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child: ChildProcess = spawn(command, argv, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = <T>(callback: (value: T) => void, value: T): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk
    })
    child.once('error', (error) => finish(reject, error))
    child.once('exit', (code) => (code === 0 ? finish(resolvePromise, { stdout, stderr }) : finish(reject, codedError('ffmpeg-archive-invalid', stderr || `${command} exited with ${code}`))))
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      finish(reject, codedError('ffmpeg-archive-invalid', `${command} timed out`))
    }, timeoutMs)
  })
}

export interface CodedError extends Error {
  code: string
}

function codedError(code: string, message: string): CodedError {
  const error = new Error(message) as CodedError
  error.code = code
  return error
}
