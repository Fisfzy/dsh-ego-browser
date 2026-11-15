/**
 * src/snapshot-diff.ts — content-level diff for `ego_snapshot({ diff: true })`.
 *
 * Why a content diff (not a ref diff): the semantic tree is rebuilt from
 * `DOMSnapshot.captureSnapshot` on every call, and `ref=` is the stable
 * `backendNodeId`. Nodes that persist keep their ref; nodes that went away
 * disappear. So comparing the rendered lines by a ref-anchored identity is
 * enough to answer "what changed", without claiming that a line's ref is still
 * clickable — the tool tells the caller to take a fresh snapshot before acting.
 *
 * Mutable marks (`value=`, `checked`, `disabled`) are excluded from the
 * identity but still surface as `changed` pairs, so a toggled checkbox or a
 * filled input reads as a change instead of a removed+added node.
 */

export interface SnapshotLine {
  indent: string
  /** Role + accessible name, without the `[...]` marks. */
  base: string
  /** The `ref=` mark, used as the identity anchor. */
  ref: string
  /** Normalized identity: indent + base + ref. */
  identity: string
  raw: string
}

export interface SnapshotDiff {
  changed: boolean
  addedCount: number
  removedCount: number
  changedCount: number
  added: string[]
  removed: string[]
  changedLines: { before: string; after: string }[]
  summary: string
}

const MAX_SAMPLES = 15

/**
 * Split one rendered snapshot line into identity + raw text.
 *
 * Snapshot lines look like:
 *   `  button "Save" [ref=812, loc=testid:save, action=click, value=x]`
 * A line without marks is its own identity.
 */
export function parseSnapshotLine(raw: string): SnapshotLine {
  const indentMatch = /^(\s*)/.exec(raw)
  const indent = indentMatch?.[1] ?? ''
  const body = raw.slice(indent.length)
  const marksMatch = /^(.*?)\s*\[([^\]]*)\]$/.exec(body)
  const base = marksMatch ? marksMatch[1]! : body
  const marks = marksMatch
    ? marksMatch[2]!
        .split(',')
        .map((mark) => mark.trim())
        .filter((mark) => mark !== '')
    : []
  const ref = marks.find((mark) => mark.startsWith('ref=')) ?? ''
  return { indent, base, ref, identity: `${indent}${base}${ref === '' ? '' : ` ${ref}`}`, raw }
}

/** Parse a whole snapshot text into lines (blank lines dropped). */
export function parseSnapshotText(text: string): SnapshotLine[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(parseSnapshotLine)
}

function groupByIdentity(lines: SnapshotLine[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const line of lines) {
    const bucket = map.get(line.identity)
    if (bucket === undefined) map.set(line.identity, [line.raw])
    else bucket.push(line.raw)
  }
  return map
}

function under(bucket: string[] | undefined, index: number): string | undefined {
  return bucket !== undefined && index < bucket.length ? bucket[index] : undefined
}

/** Compare two full snapshot texts. Pure, deterministic, no I/O. */
export function diffSnapshots(previous: string, next: string): SnapshotDiff {
  const before = parseSnapshotText(previous)
  const after = parseSnapshotText(next)
  const beforeByIdentity = groupByIdentity(before)
  const afterByIdentity = groupByIdentity(after)

  const added: string[] = []
  const removed: string[] = []
  const changedLines: { before: string; after: string }[] = []
  const identities = new Set([...beforeByIdentity.keys(), ...afterByIdentity.keys()])

  for (const identity of identities) {
    const beforeRaws = beforeByIdentity.get(identity) ?? []
    const afterRaws = afterByIdentity.get(identity) ?? []
    if (beforeRaws.length === 0) {
      added.push(...afterRaws)
      continue
    }
    if (afterRaws.length === 0) {
      removed.push(...beforeRaws)
      continue
    }
    const shared = Math.min(beforeRaws.length, afterRaws.length)
    for (let i = 0; i < shared; i += 1) {
      const left = under(beforeRaws, i)
      const right = under(afterRaws, i)
      if (left !== undefined && right !== undefined && left !== right) {
        changedLines.push({ before: left, after: right })
      }
    }
    for (let i = shared; i < afterRaws.length; i += 1) added.push(afterRaws[i]!)
    for (let i = shared; i < beforeRaws.length; i += 1) removed.push(beforeRaws[i]!)
  }

  const changed = added.length > 0 || removed.length > 0 || changedLines.length > 0
  const summary = changed
    ? `页面有变化：新增 ${added.length} 行，移除 ${removed.length} 行，变化 ${changedLines.length} 处`
    : '页面无变化'
  return {
    changed,
    addedCount: added.length,
    removedCount: removed.length,
    changedCount: changedLines.length,
    added: added.slice(0, MAX_SAMPLES),
    removed: removed.slice(0, MAX_SAMPLES),
    changedLines: changedLines.slice(0, MAX_SAMPLES),
    summary,
  }
}

export interface SnapshotObserveResult {
  /** Full text on a non-diff call or the first (baseline) diff call. */
  text?: string
  ok: true
  /** Generation the refs in this result belong to (also set on diffs). */
  snapshotId?: string
  baseline?: boolean
  tries?: number
  changed?: boolean
  addedCount?: number
  removedCount?: number
  changedCount?: number
  added?: string[]
  removed?: string[]
  changedLines?: { before: string; after: string }[]
  summary?: string
  note?: string
}

interface SnapshotEntry {
  text: string
  id: string
}

/** A bounded per-key cache of the last snapshot text. */
export class SnapshotCache {
  private readonly entries = new Map<string, SnapshotEntry>()
  private seq = 0
  constructor(private readonly maxEntries = 32) {}

  private nextId(): string {
    this.seq = (this.seq + 1) >>> 0
    return `s${this.seq.toString(16).padStart(8, '0').slice(-8)}`
  }

  get(key: string): string | undefined {
    return this.entries.get(key)?.text
  }

  /** Current ref generation for a key; undefined when no snapshot exists. */
  currentId(key: string): string | undefined {
    return this.entries.get(key)?.id
  }

  set(key: string, text: string, id?: string): void {
    this.entries.delete(key)
    this.entries.set(key, { text, id: id ?? this.nextId() })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }

  clear(): void {
    this.entries.clear()
  }

  /**
   * Record one successful snapshot and optionally return a diff.
   *
   * The first diff call has no baseline, so it returns the full tree with
   * `baseline: true` (mirroring ZCode's "first observation is always complete").
   */
  observe(key: string, text: string, opts: { diff: boolean; tries?: number }): SnapshotObserveResult {
    if (!opts.diff) {
      const snapshotId = this.nextId()
      this.set(key, text, snapshotId)
      return { ok: true, text, tries: opts.tries, snapshotId }
    }
    const previous = this.entries.get(key)
    if (previous === undefined) {
      const snapshotId = this.nextId()
      this.set(key, text, snapshotId)
      return {
        ok: true,
        baseline: true,
        changed: true,
        text,
        tries: opts.tries,
        snapshotId,
        summary: '首次快照（无上一份基线），返回完整树；下一次 diff 才能比较',
        note: diffNote(),
      }
    }
    const diff = diffSnapshots(previous.text, text)
    // A diff describes the same ref generation as its baseline. Do not advance
    // the generation here: only a full snapshot can make old refs stale.
    this.set(key, text, previous.id)
    return { ok: true, baseline: false, tries: opts.tries, snapshotId: previous.id, ...diff, note: diffNote() }
  }
}

function diffNote(): string {
  return 'diff 只说明页面变化；要点击/输入，先重新 ego_snapshot 取完整树（ref/loc 才是可操作依据）。'
}
