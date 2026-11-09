import { describe, it, expect } from 'vitest'
import {
  SnapshotCache,
  diffSnapshots,
  parseSnapshotLine,
  parseSnapshotText,
} from '../src/snapshot-diff.ts'

const TREE_A = [
  'heading1 "Search"',
  '  form',
  '    textbox "Query" [ref=12, loc=css:#q, action=type]',
  '    button "Go" [ref=13, loc=testid:go, action=click]',
  '  list',
  '    listitem "Alpha" [ref=20]',
  '    listitem "Beta" [ref=21]',
].join('\n')

describe('parseSnapshotLine', () => {
  it('uses the ref as the identity anchor and drops mutable marks', () => {
    const line = parseSnapshotLine('  button "Save" [ref=812, loc=testid:s, action=click, value=x]')
    expect(line.indent).toBe('  ')
    expect(line.base).toBe('button "Save"')
    expect(line.ref).toBe('ref=812')
    expect(line.identity).toBe('  button "Save" ref=812')
  })

  it('keeps plain lines addressable by their own text', () => {
    const line = parseSnapshotLine('heading1 "Search"')
    expect(line.ref).toBe('')
    expect(line.identity).toBe('heading1 "Search"')
  })

  it('ignores blank lines when parsing a whole tree', () => {
    expect(parseSnapshotText(`${TREE_A}\n\n`)).toHaveLength(7)
  })
})

describe('diffSnapshots', () => {
  it('reports no change for an identical tree', () => {
    const diff = diffSnapshots(TREE_A, TREE_A)
    expect(diff.changed).toBe(false)
    expect(diff.summary).toBe('页面无变化')
    expect(diff.addedCount).toBe(0)
    expect(diff.removedCount).toBe(0)
    expect(diff.changedCount).toBe(0)
  })

  it('detects added and removed nodes', () => {
    const next = TREE_A.replace(
      '    listitem "Beta" [ref=21]',
      '    listitem "Beta" [ref=21]\n    listitem "Gamma" [ref=22]',
    ).replace('    listitem "Alpha" [ref=20]\n', '')
    const diff = diffSnapshots(TREE_A, next)
    expect(diff.addedCount).toBe(1)
    expect(diff.added[0]).toContain('Gamma')
    expect(diff.removedCount).toBe(1)
    expect(diff.removed[0]).toContain('Alpha')
    expect(diff.changed).toBe(true)
  })

  it('treats a value change as a changed line, not remove+add', () => {
    const next = TREE_A.replace('action=type]', 'action=type, value=hello]')
    const diff = diffSnapshots(TREE_A, next)
    expect(diff.addedCount).toBe(0)
    expect(diff.removedCount).toBe(0)
    expect(diff.changedCount).toBe(1)
    expect(diff.changedLines[0]!.before).not.toContain('value=hello')
    expect(diff.changedLines[0]!.after).toContain('value=hello')
  })

  it('counts duplicate identical lines as multiset entries', () => {
    const before = 'button "Delete" [ref=1]\nbutton "Delete" [ref=2]'
    const after = 'button "Delete" [ref=1]'
    const diff = diffSnapshots(before, after)
    expect(diff.removedCount).toBe(1)
    expect(diff.addedCount).toBe(0)
  })

  it('caps the samples but keeps the full counts', () => {
    const before = ''
    const after = Array.from({ length: 40 }, (_, i) => `listitem "Item ${i}" [ref=${100 + i}]`).join('\n')
    const diff = diffSnapshots(before, after)
    expect(diff.addedCount).toBe(40)
    expect(diff.added).toHaveLength(15)
  })
})

describe('SnapshotCache', () => {
  it('stores on a non-diff call and returns the full text unchanged', () => {
    const cache = new SnapshotCache()
    const result = cache.observe('k', TREE_A, { diff: false, tries: 0 })
    expect(result.text).toBe(TREE_A)
    expect(result.changed).toBeUndefined()
    expect(cache.get('k')).toBe(TREE_A)
  })

  it('returns the full tree as a baseline on the first diff call', () => {
    const cache = new SnapshotCache()
    const result = cache.observe('k', TREE_A, { diff: true })
    expect(result.baseline).toBe(true)
    expect(result.text).toBe(TREE_A)
  })

  it('diffs against the previous snapshot and updates the baseline', () => {
    const cache = new SnapshotCache()
    cache.observe('k', TREE_A, { diff: false })
    const next = TREE_A.replace('action=type]', 'action=type, value=abc]')
    const first = cache.observe('k', next, { diff: true })
    expect(first.baseline).toBe(false)
    expect(first.changedCount).toBe(1)
    expect(first.note).toContain('重新 ego_snapshot')
    // Baseline advanced: the same tree again is "no change".
    const second = cache.observe('k', next, { diff: true })
    expect(second.changed).toBe(false)
  })

  it('isolates keys and evicts the oldest entry beyond capacity', () => {
    const cache = new SnapshotCache(2)
    cache.observe('a', 'x', { diff: false })
    cache.observe('b', 'y', { diff: false })
    cache.observe('c', 'z', { diff: false })
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe('y')
    expect(cache.get('c')).toBe('z')
  })
})
