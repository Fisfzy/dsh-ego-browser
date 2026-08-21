import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

export type SpawnFn = (command: string, argv: readonly string[], options?: SpawnOptions) => ChildProcess

export interface FfmpegProbeOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  spawn?: SpawnFn
  timeoutMs?: number
  requestedEncoder?: string
}

export interface FfmpegProbeResult {
  version: string
  encoder: string
}

export interface RunFfmpegProbeResult {
  ok: boolean
  output: string
}

export interface RunFfmpegProbeOptions {
  spawn?: SpawnFn
  timeoutMs?: number
}

export function runFfmpegProbe(
  path: string,
  argv: readonly string[],
  { spawn = nodeSpawn as unknown as SpawnFn, timeoutMs = 3000 }: RunFfmpegProbeOptions = {},
): Promise<RunFfmpegProbeResult> {
  return new Promise((resolve) => {
    let child: ChildProcess
    let output = ''
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, output })
    }
    try {
      child = spawn(path, argv, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve({ ok: false, output })
      return
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.once('error', () => finish(false))
    child.once('exit', (code) => finish(code === 0))
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      finish(false)
    }, timeoutMs)
  })
}

export async function probeFfmpeg(
  path: string,
  { platform = process.platform, env = process.env, spawn = nodeSpawn as unknown as SpawnFn, requestedEncoder = 'auto' }: FfmpegProbeOptions = {},
): Promise<FfmpegProbeResult> {
  const versionResult = await runFfmpegProbe(path, ['-version'], { spawn })
  if (!versionResult.ok) throw codedError('ffmpeg-not-executable', `FFmpeg is not executable: ${path}`)
  const version = versionResult.output.split(/\r?\n/, 1)[0] || 'FFmpeg'
  if (platform === 'win32') {
    const support = await runFfmpegProbe(path, ['-hide_banner', '-h', 'filter=gfxcapture'], { spawn })
    if (!support.ok || !/Filter gfxcapture\b/.test(support.output)) throw codedError('ffmpeg-gfxcapture-unavailable', 'FFmpeg does not support Windows gfxcapture')
  } else if (platform === 'darwin') {
    const devices = await runFfmpegProbe(path, ['-hide_banner', '-devices'], { spawn })
    if (!devices.ok || !/avfoundation/i.test(devices.output)) throw codedError('ffmpeg-capture-input-unavailable', 'FFmpeg does not support avfoundation capture')
  } else if (platform === 'linux') {
    if (env.XDG_SESSION_TYPE === 'wayland' || env.WAYLAND_DISPLAY) throw codedError('ffmpeg-platform-unsupported', 'Wayland capture is not supported')
    const devices = await runFfmpegProbe(path, ['-hide_banner', '-devices'], { spawn })
    if (!devices.ok || !/x11grab/i.test(devices.output)) throw codedError('ffmpeg-capture-input-unavailable', 'FFmpeg does not support x11grab capture')
  }
  const automatic = platform === 'win32' ? ['h264_mf', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264']
    : platform === 'darwin' ? ['h264_videotoolbox', 'libx264'] : ['h264_nvenc', 'h264_vaapi', 'h264_qsv', 'libx264']
  const encoders = requestedEncoder === 'auto' ? automatic : [requestedEncoder === 'software' ? 'libx264' : requestedEncoder]
  for (const encoder of encoders) {
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=64x64:rate=1', '-frames:v', '1', '-c:v', encoder, '-f', 'null', '-']
    if ((await runFfmpegProbe(path, args, { spawn, timeoutMs: 5000 })).ok) return { version, encoder }
  }
  throw codedError('ffmpeg-encoder-unavailable', 'FFmpeg has no usable H.264 encoder')
}

export interface CodedError extends Error {
  code: string
}

function codedError(code: string, message: string): CodedError {
  const error = new Error(message) as CodedError
  error.code = code
  return error
}
