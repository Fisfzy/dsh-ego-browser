#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { CdpClient } from './cdp-client.ts'
import { TargetSessions, CdpCaptureBackend } from './capture-cdp.ts'
import { CaptureManager } from './capture-manager.ts'
import { FfmpegCaptureBackend } from './capture-ffmpeg.ts'

const SENTINEL = '@@DSH_RESULT@@'
const HOME = homedir() || process.env.HOME || process.env.USERPROFILE || '/root'
const IS_WIN = platform() === 'win32'
const STATE_HOME = IS_WIN ? process.env.LOCALAPPDATA || join(HOME, 'AppData', 'Local') : process.env.XDG_STATE_HOME || join(HOME, '.local', 'state')
const STATE_DIR = process.env.EGO_LINUX_STATE_DIR || join(STATE_HOME, 'ego-lite-linux')
const BROWSER_STATE_FILE = join(STATE_DIR, 'browser.json')
const CAST_STATE_FILE = join(STATE_DIR, 'ego-cast.json')

interface CastConfig {
  captureBackend: string
  streamProfile: string
  ffmpegFallbackReason: string
  cdpFps: number
  cdpQuality: number
  cdpMaxWidth: number
  cdpBackstopIntervalMs: number
  ffmpegFps: number
  ffmpegMaxWidth: number
  ffmpegBitrateKbps: number
  ffmpegEncoder: string
  ffmpegPath: string
  ffmpegResolvedPath: string
}

const DEFAULT_CONFIG: CastConfig = {
  captureBackend: 'auto', streamProfile: 'balanced', ffmpegFallbackReason: '',
  cdpFps: 20, cdpQuality: 55, cdpMaxWidth: 960, cdpBackstopIntervalMs: 3000,
  ffmpegFps: 20, ffmpegMaxWidth: 1280, ffmpegBitrateKbps: 4000, ffmpegEncoder: 'auto', ffmpegPath: '', ffmpegResolvedPath: '',
}
let castConfig: CastConfig = { ...DEFAULT_CONFIG }
try { castConfig = { ...castConfig, ...JSON.parse(process.argv[2] || '{}') } as CastConfig } catch { /* ignore */ }

const HUMAN_PROBE_JS = `(() => {
  const el=document.querySelector('iframe[src*="recaptcha"],.g-recaptcha,.h-captcha,iframe[src*="hcaptcha"],.cf-turnstile,iframe[src*="turnstile"],iframe[src*="cloudflare"],#challenge-form,.challenge-form,#captcha,.captcha');
  if(el)return{detected:true,kind:/recaptcha/i.test(el.outerHTML)?'recaptcha':/hcaptcha/i.test(el.outerHTML)?'hcaptcha':/turnstile/i.test(el.outerHTML)?'turnstile':'captcha'};
  const t=((document.body&&document.body.innerText)||'').slice(0,120000).toLowerCase();
  return /verify you are human|your activity looks unusual|captcha|i.?m not a robot|人机验证|安全验证|我是人类|验证码|滑块验证/.test(t)?{detected:true,kind:'captcha'}:{detected:false,kind:null};
})()`

interface SseClient {
  res: ServerResponse
  blocked: boolean
  pendingFrame: unknown | null
  pendingEvents: Map<string, unknown>
}
interface VideoClient {
  res: ServerResponse
  generation: number
  blocked: boolean
  queue: Buffer[]
}
interface CachedFrame {
  frame: string
  lastActive: number
  viewportW: number | null
  viewportH: number | null
}
interface ActiveBrowser {
  wsUrl: string
  port: number | null
  ws: WebSocket
  cdp: CdpClient
  sessions: TargetSessions
  pid?: number
}
interface JpegFrame {
  targetId: string
  data: string
  vw: number | null
  vh: number | null
  ts: number
  backstop?: boolean
}

const sseClients = new Set<SseClient>()
const videoClients = new Set<VideoClient>()
const probeCache = new Map<string, { at: number; human: unknown }>()
const frameCache = new Map<string, CachedFrame>()
let active: ActiveBrowser | null = null
let currentStatus: Record<string, unknown> = { backend: 'cdp', state: 'idle', targetId: null, generation: 0, watchers: 0 }
let videoInit: { generation: number; mime: string; buffer: Buffer } | null = null

function normalizeConfig(input: Record<string, unknown>): CastConfig {
  const next: CastConfig = { ...castConfig }
  const enumValue = (key: keyof CastConfig, values: readonly unknown[]): void => {
    if (values.includes(input[key])) (next as unknown as Record<string, unknown>)[key as string] = input[key]
  }
  const numberValue = (key: keyof CastConfig, min: number, max: number): void => {
    const v = input[key]
    if (Number.isFinite(v) && (v as number) >= min && (v as number) <= max) (next as unknown as Record<string, unknown>)[key as string] = v
  }
  enumValue('captureBackend', ['auto', 'cdp', 'ffmpeg'])
  if (typeof input.ffmpegFallbackReason === 'string') next.ffmpegFallbackReason = input.ffmpegFallbackReason
  enumValue('streamProfile', ['low', 'balanced', 'high'])
  enumValue('ffmpegEncoder', ['auto', 'software', 'h264_mf', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox', 'h264_vaapi'])
  numberValue('cdpFps', 5, 30); numberValue('cdpQuality', 1, 100); numberValue('cdpMaxWidth', 320, 1920); numberValue('cdpBackstopIntervalMs', 1000, 10000)
  numberValue('ffmpegFps', 5, 30); numberValue('ffmpegMaxWidth', 320, 1920); numberValue('ffmpegBitrateKbps', 500, 20000)
  if (typeof input.ffmpegPath === 'string') next.ffmpegPath = input.ffmpegPath
  if (typeof input.ffmpegResolvedPath === 'string') next.ffmpegResolvedPath = input.ffmpegResolvedPath
  return next
}
castConfig = normalizeConfig(castConfig as unknown as Record<string, unknown>)

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' })
  res.end(payload)
}

async function readJson(req: IncomingMessage, maxBytes = 8192): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('body too large')
    chunks.push(Buffer.from(chunk as Uint8Array))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
}

function writeSse(res: ServerResponse, event: string, payload: unknown): boolean {
  return res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
}

function queueSse(client: SseClient, event: string, payload: unknown): void {
  if (event === 'frame') client.pendingFrame = payload
  else client.pendingEvents.set(event, payload)
}

function sendSse(client: SseClient, event: string, payload: unknown): void {
  if (client.blocked) { queueSse(client, event, payload); return }
  try {
    if (!writeSse(client.res, event, payload)) {
      client.blocked = true
      client.res.once('drain', () => {
        client.blocked = false
        const pendingEvents = [...client.pendingEvents]
        const pendingFrame = client.pendingFrame
        client.pendingEvents.clear()
        client.pendingFrame = null
        for (const [pendingEvent, pendingPayload] of pendingEvents) sendSse(client, pendingEvent, pendingPayload)
        if (pendingFrame) sendSse(client, 'frame', pendingFrame)
      })
    }
  } catch { sseClients.delete(client) }
}

function broadcast(event: string, payload: unknown): void {
  for (const client of sseClients) sendSse(client, event, payload)
}

function publishStatus(status: Record<string, unknown>): void {
  currentStatus = { ...currentStatus, ...status }
  broadcast('capture-status', currentStatus)
}

function publishJpeg(frame: JpegFrame): void {
  frameCache.delete(frame.targetId)
  frameCache.set(frame.targetId, { frame: frame.data, lastActive: frame.ts, viewportW: frame.vw, viewportH: frame.vh })
  while (frameCache.size > 30) frameCache.delete(frameCache.keys().next().value as string)
  broadcast('frame', frame)
}

function publishVideoInit(event: { generation: number; buffer: Buffer }): void {
  videoInit = { generation: event.generation, mime: '', buffer: event.buffer }
  for (const client of videoClients) {
    if (client.generation === event.generation) writeVideo(client, event.buffer)
  }
}

function publishVideoChunk(event: { generation: number; buffer: Buffer }): void {
  for (const client of videoClients) {
    if (client.generation === event.generation) writeVideo(client, event.buffer)
  }
}

function writeVideo(client: VideoClient, buffer: Buffer): void {
  if (client.blocked) {
    client.queue.push(buffer)
    if (client.queue.length > 8) {
      videoClients.delete(client)
      try { client.res.destroy(new Error('video client is too slow')) } catch { /* ignore */ }
    }
    return
  }
  try {
    if (!client.res.write(buffer)) {
      client.blocked = true
      client.res.once('drain', () => {
        client.blocked = false
        const pending = client.queue.shift()
        if (pending) writeVideo(client, pending)
      })
    } else if (client.queue.length > 0) writeVideo(client, client.queue.shift()!)
  } catch { videoClients.delete(client) }
}

function endVideo({ generation }: { generation?: number } = {}): void {
  for (const client of [...videoClients]) {
    if (generation === undefined || client.generation === generation) {
      videoClients.delete(client)
      try { client.res.end() } catch { /* ignore */ }
    }
  }
}

const manager = new CaptureManager({
  getConfig: () => castConfig,
  onStatus: publishStatus,
  backendFactories: {
    cdp: ({ onStatus }) => {
      if (!active) throw new Error('no live browser')
      return new CdpCaptureBackend({ cdp: active.cdp, sessions: active.sessions, getConfig: () => castConfig, onStatus, onJpegFrame: publishJpeg })
    },
    ffmpeg: ({ generation, onStatus }) => {
      if (!active) throw new Error('no live browser')
      return new FfmpegCaptureBackend({ sessions: active.sessions, browserPid: active.pid ?? 0, getConfig: () => castConfig, generation, onStatus, onVideoInit: publishVideoInit, onVideoChunk: publishVideoChunk, onVideoEnd: endVideo })
    },
  },
})

async function readBrowserState(): Promise<{ port?: number } | null> {
  try { return JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(BROWSER_STATE_FILE, 'utf8'))) as { port?: number } }
  catch { return null }
}

async function resolveBrowser(): Promise<{ wsUrl: string; port: number | null } | null> {
  if (process.env.EGO_LINUX_CDP_URL) return { wsUrl: process.env.EGO_LINUX_CDP_URL, port: null }
  const state = await readBrowserState()
  if (!state?.port) return null
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/json/version`, { signal: AbortSignal.timeout(1500) })
    const wsUrl = response.ok ? (await response.json() as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl : null
    return wsUrl ? { port: state.port ?? null, wsUrl } : null
  } catch { return null }
}

async function listTargets(): Promise<Array<{ targetId: string; url: string; title: string; type: string }>> {
  if (!active) return []
  const result = await active.cdp.call('Target.getTargets') as { targetInfos?: Array<{ targetId: string; url: string; title: string; type: string }> }
  return (result.targetInfos || []).filter((target) => target.type === 'page')
}

async function activeTargetId(): Promise<string | null> {
  if (!active?.port) return (currentStatus.targetId as string | null) || null
  try {
    const response = await fetch(`http://127.0.0.1:${active.port}/json/list`, { signal: AbortSignal.timeout(1500) })
    const list = response.ok ? await response.json() as Array<{ id?: string; type?: string }> : []
    return list.find((entry) => entry.type === 'page')?.id || (currentStatus.targetId as string | null) || null
  } catch { return (currentStatus.targetId as string | null) || null }
}

async function snapshotSpaces(): Promise<Array<Record<string, unknown>>> {
  const targets = await listTargets()
  const activeId = await activeTargetId()
  const spaces: Array<Record<string, unknown>> = []
  for (const target of targets.slice(0, 30)) {
    const frame = frameCache.get(target.targetId)
    const session = active!.sessions.get(target.targetId)
    const cached = probeCache.get(target.targetId)
    if (!cached || Date.now() - cached.at > 5000) {
      active!.sessions.call(target.targetId, 'Runtime.evaluate', { expression: HUMAN_PROBE_JS, returnByValue: true, awaitPromise: false }, 3000)
        .then((result) => { const r = result as { result?: { value?: unknown } }; probeCache.set(target.targetId, { at: Date.now(), human: r.result?.value || null }) }).catch(() => { /* ignore */ })
    }
    spaces.push({ targetId: target.targetId, url: target.url, title: target.title, active: target.targetId === activeId, lastActive: frame?.lastActive || 0, viewportW: frame?.viewportW || session?.viewportW, viewportH: frame?.viewportH || session?.viewportH, humanCheck: cached?.human || null })
  }
  spaces.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastActive as number) - (a.lastActive as number))
  return spaces
}

async function connectLoop(): Promise<void> {
  while (true) {
    const browser = await resolveBrowser()
    if (!browser) { await sleep(3000); continue }
    try {
      const ws = new WebSocket(browser.wsUrl)
      await new Promise<void>((resolve, reject) => { ws.addEventListener('open', () => resolve(), { once: true } as AddEventListenerOptions); ws.addEventListener('error', () => reject(new Error('ws error')), { once: true } as AddEventListenerOptions) })
      const cdp = new CdpClient(ws)
      const sessions = new TargetSessions(cdp)
      active = { ...browser, ws, cdp, sessions }
      publishStatus({ browserConnected: true })
      await manager.browserConnected()
      await new Promise<void>((resolve) => { ws.addEventListener('close', () => resolve(), { once: true } as AddEventListenerOptions); ws.addEventListener('error', () => resolve(), { once: true } as AddEventListenerOptions) })
      await manager.browserDisconnected()
      await sessions.dispose()
    } catch (error) {
      publishStatus({ state: 'failed', code: 'browser-disconnected', message: (error as Error).message, browserConnected: false })
    } finally {
      active = null
      await sleep(2000)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stopSiblingWorkers(): void {
  const self = String(process.pid)
  if (IS_WIN) {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*ego-cast-worker.mjs*' -and $_.ProcessId -ne ${self} } | Select-Object -ExpandProperty ProcessId`
    try {
      const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 8000 })
      for (const line of output.split(/\r?\n/)) if (/^\d+$/.test(line.trim())) try { execFileSync('taskkill', ['/PID', line.trim(), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
    } catch { /* ignore */ }
    return
  }
  try {
    const output = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 8000 })
    for (const line of output.split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(.+)$/)
      if (match && match[1] !== self && match[2].includes('ego-cast-worker.mjs')) try { process.kill(Number(match[1]), 'SIGTERM') } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

async function main(): Promise<void> {
  stopSiblingWorkers()
  rmSync(CAST_STATE_FILE, { force: true })
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    try {
      if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { workerOk: true, browserConnected: !!active, capture: manager.status() })
      if (req.method === 'GET' && url.pathname === '/api/spaces') return sendJson(res, 200, { ok: true, spaces: active ? await snapshotSpaces() : [], capture: manager.status() })
      if (req.method === 'GET' && url.pathname === '/api/watch/status') return sendJson(res, 200, { ok: true, ...manager.status() })
      if (req.method === 'GET' && url.pathname === '/api/video/status') return sendJson(res, 200, { ok: true, ...manager.status(), mime: videoInit?.mime || null })
      if (req.method === 'POST' && url.pathname === '/api/config') { castConfig = normalizeConfig(await readJson(req)); await manager.updateConfig(); return sendJson(res, 200, { ok: true, config: castConfig }) }
      if (req.method === 'POST' && url.pathname === '/api/watch/start') { if (!active) return sendJson(res, 409, { ok: false, error: 'no live browser' }); return sendJson(res, 200, { ok: true, ...await manager.startWatch(await readJson(req) as { clientId: string; targetId: string }) }) }
      if (req.method === 'POST' && url.pathname === '/api/watch/switch') return sendJson(res, 200, { ok: true, ...await manager.switchWatch(await readJson(req) as { clientId: string; targetId: string }) })
      if (req.method === 'POST' && url.pathname === '/api/watch/stop') return sendJson(res, 200, { ok: true, ...await manager.stopWatch(await readJson(req) as { clientId: string }) })
      if (req.method === 'POST' && url.pathname === '/api/input') {
        const body = await readJson(req)
        if (!active) return sendJson(res, 409, { ok: false, code: 'browser-disconnected', error: 'no live browser' })
        if (!body.targetId) return sendJson(res, 400, { ok: false, code: 'target-required', error: 'targetId required' })
        const targets = await listTargets()
        if (!targets.some((target) => target.targetId === body.targetId)) {
          return sendJson(res, 409, { ok: false, code: 'capture-target-stale', error: 'target is no longer available' })
        }
        try {
          return sendJson(res, 200, await active.sessions.sendInput(body.targetId as string, body))
        } catch (error) {
          return sendJson(res, 503, { ok: false, code: 'input-dispatch-failed', error: (error as Error).message || String(error) })
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/close') { const { targetId } = await readJson(req); if (!active || !targetId) return sendJson(res, 400, { ok: false, error: 'targetId required' }); await active.cdp.call('Target.closeTarget', { targetId }); return sendJson(res, 200, { ok: true }) }
      if (req.method === 'POST' && url.pathname === '/api/flush') { if (!active) return sendJson(res, 409, { ok: false, error: 'no live browser' }); await active.cdp.call('Storage.flushCookies').catch(() => { /* ignore */ }); return sendJson(res, 200, { ok: true }) }
      if (req.method === 'GET' && url.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
        res.write(':ok\n\n')
        const client: SseClient = { res, blocked: false, pendingFrame: null, pendingEvents: new Map() }
        sseClients.add(client)
        writeSse(res, 'capture-status', manager.status())
        snapshotSpaces().then((spaces) => { if (sseClients.has(client)) writeSse(res, 'spaces', spaces) }).catch(() => { /* ignore */ })
        const close = (): void => { sseClients.delete(client) }; req.on('close', close); res.on('close', close); return
      }
      if (req.method === 'GET' && url.pathname === '/api/video/stream') {
        const generation = Number(url.searchParams.get('generation'))
        if (!videoInit || generation !== currentStatus.generation || generation !== videoInit.generation) return sendJson(res, 409, { ok: false, error: 'stale video generation', generation: currentStatus.generation })
        res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store', 'x-ego-generation': String(generation), 'x-ego-backend': 'ffmpeg' })
        const client: VideoClient = { res, generation, blocked: false, queue: [] }
        videoClients.add(client); writeVideo(client, videoInit.buffer)
        const close = (): void => { videoClients.delete(client) }; req.on('close', close); res.on('close', close); return
      }
      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) { sendJson(res, 500, { ok: false, error: (error as Error).message || String(error) }) }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(CAST_STATE_FILE, JSON.stringify({ port, pid: process.pid }, null, 2))
  const metadataTimer = setInterval(() => {
    if (!active || sseClients.size === 0) return
    snapshotSpaces().then((spaces) => broadcast('spaces', spaces)).catch(() => { /* ignore */ })
  }, 1000)
  const shutdown = async (): Promise<void> => {
    clearInterval(metadataTimer)
    await manager.dispose().catch(() => { /* ignore */ })
    try { active?.ws?.close() } catch { /* ignore */ }
    try { const state = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(CAST_STATE_FILE, 'utf8'))) as { pid?: number }; if (state.pid === process.pid) rmSync(CAST_STATE_FILE, { force: true }) } catch { /* ignore */ }
    server.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown)
  console.log(`${SENTINEL}${JSON.stringify({ ok: true, port, pid: process.pid })}`)
  connectLoop().catch((error: Error) => console.error('ego-cast-worker: connect loop failed', error))
}

main().catch((error: Error) => { console.error('ego-cast-worker failed:', error.stack || error.message); process.exit(1) })
