#!/usr/bin/env node
/**
 * Offline trajectory checker/replay planner (P1-4).
 *
 * Reads a JSONL file written by the plugin's `trajectory` setting and prints the
 * ordered tool calls. It deliberately does NOT execute them: the host's tool
 * registry is only available inside a running DSH session, so live re-execution
 * needs a host API. Use --json to feed the plan to a harness that can execute it.
 *
 * Usage:
 *   node scripts/replay.mjs <trajectory.jsonl> [--json]
 *
 * Exit codes: 0 = all recorded steps succeeded; 1 = a step failed/malformed.
 */
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const file = args.find((arg) => !arg.startsWith('--'))
if (!file) {
  console.error('usage: node scripts/replay.mjs <trajectory.jsonl> [--json]')
  process.exit(2)
}
const json = args.includes('--json')

let lines
try {
  lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '')
} catch (error) {
  console.error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}

const steps = []
let failures = 0
for (const [index, line] of lines.entries()) {
  let row
  try {
    row = JSON.parse(line)
  } catch {
    console.error(`line ${index + 1}: invalid JSON`)
    failures++
    continue
  }
  if (typeof row.tool !== 'string' || typeof row.args !== 'object' || row.args === null) {
    console.error(`line ${index + 1}: missing tool/args`)
    failures++
    continue
  }
  if (row.ok === false) failures++
  steps.push({
    index: index + 1,
    ts: row.ts ?? null,
    tool: row.tool,
    args: row.args,
    ok: row.ok ?? null,
    code: row.code ?? null,
    actionSent: row.actionSent ?? null,
    url: row.url ?? null,
    snapshotId: row.snapshotId ?? null,
  })
}

if (json) {
  console.log(JSON.stringify({ file, steps, failures }, null, 2))
} else {
  for (const step of steps) {
    const status = step.ok === false ? 'FAIL' : step.ok === true ? 'ok' : '?'
    console.log(`${String(step.index).padStart(3)} ${status.padEnd(4)} ${step.tool} ${JSON.stringify(step.args)}`)
  }
  console.log(`\n${steps.length} steps, ${failures} failures`)
}
process.exit(failures === 0 ? 0 : 1)
