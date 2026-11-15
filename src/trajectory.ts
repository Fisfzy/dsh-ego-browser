/**
 * Per-session tool-call trajectories (P1-4).
 *
 * This module is deliberately host-only: records are JSONL files under the
 * DSH plugin-data directory, never inside the plugin package. Writing must
 * never break a browser action, so callers get a best-effort function that
 * swallows filesystem errors.
 */
import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_BYTES = 2 * 1024 * 1024

export interface TrajectoryEntry {
  ts: string
  tool: string
  args: Record<string, unknown>
  ok: boolean | null
  code: string | null
  actionSent: boolean | null
  durationMs: number
  url: string | null
  space: string | null
  snapshotId: string | null
}

/** Directory override is exposed for tests; production uses plugin-data. */
export function trajectoryDir(): string {
  return process.env.EGO_TRAJECTORY_DIR || join(homedir(), '.dsh', 'plugin-data', 'ego-browser', 'trajectories')
}

/** Redact credentials-like free text unless the user opted in. */
export function redactTrajectoryArgs(
  tool: string,
  args: Record<string, unknown>,
  recordText: boolean,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...args }
  if (!recordText && (tool === 'ego_fill' || tool === 'ego_key')) {
    for (const key of ['text', 'value']) {
      if (typeof copy[key] === 'string' && copy[key] !== '') copy[key] = '<redacted>'
    }
  }
  return copy
}

export interface TrajectoryValueLike {
  ok?: unknown
  code?: unknown
  actionSent?: unknown
  page?: unknown
  url?: unknown
}

function valueMeta(value: unknown): { ok: boolean | null; code: string | null; actionSent: boolean | null; url: string | null } {
  if (value === null || typeof value !== 'object') return { ok: null, code: null, actionSent: null, url: null }
  const v = value as TrajectoryValueLike
  const page = v.page && typeof v.page === 'object' ? v.page as { url?: unknown } : null
  return {
    ok: typeof v.ok === 'boolean' ? v.ok : null,
    code: typeof v.code === 'string' ? v.code : null,
    actionSent: typeof v.actionSent === 'boolean' ? v.actionSent : null,
    url: page && typeof page.url === 'string' ? page.url : typeof v.url === 'string' ? v.url : null,
  }
}

/** Append one JSONL record. Returns false when disabled or the write failed. */
export function recordTrajectory(
  enabled: boolean,
  recordText: boolean,
  sessionId: string | undefined,
  entry: {
    tool: string
    args: Record<string, unknown>
    value: unknown
    durationMs: number
    space?: string | number
  },
): boolean {
  if (!enabled) return false
  try {
    const meta = valueMeta(entry.value)
    const safeSession = String(sessionId ?? 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default'
    const dir = trajectoryDir()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${safeSession}.jsonl`)
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`)
    } catch {
      // No existing file.
    }
    const record: TrajectoryEntry = {
      ts: new Date().toISOString(),
      tool: entry.tool,
      args: redactTrajectoryArgs(entry.tool, entry.args, recordText),
      ok: meta.ok,
      code: meta.code,
      actionSent: meta.actionSent,
      durationMs: Math.max(0, Math.round(entry.durationMs)),
      url: meta.url,
      space: entry.space === undefined ? (typeof entry.args.space === 'string' ? entry.args.space : null) : String(entry.space),
      snapshotId: typeof entry.args.snapshotId === 'string' ? entry.args.snapshotId : null,
    }
    appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    return true
  } catch {
    return false
  }
}
