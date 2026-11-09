/**
 * Manual smoke test for 0.9.13 (NEWTOOL1). Runs the BUILT plugin (lib/index.js)
 * against a local HTTP server and the vendored ego runtime in an isolated state
 * dir, so it does not disturb the user's live browser session.
 *
 * Run: npm run build && node scripts/smoke-0.9.13.mjs
 *
 * Covers: rules-prompt gating, structured failures, navigate reuse policies,
 * snapshot diff, screenshot fullPage/clip, tabs+space ownership, help registry,
 * and an 8-cycle observation stability loop.
 */
import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const EGO_BIN = join(REPO, 'runtime/ego-linux/bin/ego-browser.mjs')
const stateDir = await mkdtemp(join(tmpdir(), 'ego-smoke-0913-'))
process.env.EGO_LINUX_STATE_DIR = stateDir
process.env.EGO_LINUX_HEADLESS = '1'

const results = []
let failures = 0
function check(name, condition, detail = '') {
  const ok = Boolean(condition)
  if (!ok) failures++
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}
function parsePng(buffer) {
  if (buffer.length < 24 || buffer.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

// ── fake DSH context ────────────────────────────────────────────────────────
function makeSpawn() {
  return (spec) => {
    const [exe, ...args] = spec.argv
    const child = spawn(exe, args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    if (spec.stdio.stdin.data !== undefined) child.stdin.end(spec.stdio.stdin.data)
    const done = new Promise((resolveDone, reject) => {
      const timer = setTimeout(() => {
        child.kill()
        resolveDone({ exitCode: null, signal: 'SIGKILL' })
      }, spec.graceMs + 30_000)
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('exit', (code, signal) => { clearTimeout(timer); resolveDone({ exitCode: code, signal }) })
    })
    return {
      done,
      collected: {
        stdout: { readFrom: (offset) => ({ text: stdout.slice(offset), nextOffset: stdout.length, lossy: false }) },
        stderr: { readFrom: (offset) => ({ text: stderr.slice(offset), nextOffset: stderr.length, lossy: false }) },
      },
    }
  }
}

function bench(config = {}) {
  const tools = new Map()
  const sections = []
  const systemPrompt = { section: (spec) => { sections.push(spec); return () => {} } }
  const ctx = {
    tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    subprocess: { spawn: makeSpawn() },
    effect: (fn) => { try { return fn() } catch { return undefined } },
    inject: () => {},
    on: () => () => {},
    get: (name) => (name === 'systemPrompt' ? systemPrompt : undefined),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    config: {},
  }
  const { apply } = plugin
  apply(ctx, {
    defaultSpace: 'smoke-0913',
    sessionScopedSpaces: false,
    disableFrameRelay: true,
    idleTimeoutMin: 0,
    residentExecutor: false,
    captureBackend: 'cdp',
    ...config,
  })
  const exec = { callId: 'smoke', name: 'smoke', arguments: {}, signal: new AbortController().signal }
  return {
    tools,
    sections,
    call: (name, args = {}) => tools.get(name).execute(args, exec),
  }
}

// ── local pages ─────────────────────────────────────────────────────────────
const PAGE_A = `<!doctype html><html><head><title>Page A</title></head>
<body style="min-height:2000px;margin:0;font:16px sans-serif">
<h1>Page A</h1>
<button id="add">Add</button>
<ul id="list"></ul>
<input id="q" placeholder="query">
<script>
let n = 0;
document.getElementById('add').onclick = () => {
  const li = document.createElement('li');
  li.textContent = 'item-' + (++n);
  document.getElementById('list').appendChild(li);
};
</script>
</body></html>`
const PAGE_B = `<!doctype html><html><head><title>Page B</title></head>
<body style="margin:0;font:16px sans-serif"><h1>Page B</h1></body></html>`

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(req.url?.startsWith('/b') ? PAGE_B : PAGE_A)
})
await new Promise((resolveListen) => server.listen(0, resolveListen))
const port = server.address().port
const BASE = `http://127.0.0.1:${port}`

const plugin = await import('../lib/index.js')
const b = bench()
console.log(`\n=== 0.9.13 smoke (state dir ${stateDir}) ===\n`)

try {
  // 1. rules section registered but empty before first use
  check('rules section registered', b.sections.length === 1, b.sections[0]?.name)
  check('rules empty before first ego call', b.sections[0].text({}) === '')

  // 2. status onboarding
  const status = await b.call('ego_status')
  check('ego_status available', status.ok === true && status.available === true)
  check('status rulesSummary present', typeof status.rulesSummary === 'string' && status.rulesSummary.includes('先观察'))
  check('rules active after first call', typeof b.sections[0].text({}) === 'string' && b.sections[0].text({}).includes('ego-browser 操作规则'))

  // 3. navigate reuse policies
  const nav1 = await b.call('ego_navigate', { url: `${BASE}/a` })
  check('navigate first visit', nav1.ok === true && nav1.reused === 'none' && nav1.navigated === true, nav1.page?.url)
  const nav2 = await b.call('ego_navigate', { url: `${BASE}/a` })
  check('navigate exact reuse', nav2.ok === true && nav2.reused === 'exact' && nav2.navigated === false)
  const nav3 = await b.call('ego_navigate', { url: `${BASE}/b` })
  check('navigate same-origin reuse', nav3.ok === true && nav3.reused === 'origin' && nav3.navigated === true, nav3.page?.url)
  const nav4 = await b.call('ego_navigate', { url: `http://localhost:${port}/a` })
  check('navigate reuse=none keeps one tab', nav4.ok === true && nav4.reused === 'none', nav4.page?.url)

  // 4. snapshot + diff
  const full = await b.call('ego_snapshot', {})
  check('snapshot returns tree with refs', full.ok === true && full.text.includes('button "Add"'), `${full.text?.split('\n').length} lines`)
  const click = await b.call('ego_click', { selector: '#add' })
  check('click succeeds', click.ok === true)
  check('click carries success hint', typeof click.hint === 'string' && click.hint.includes('不要重复同一动作'))
  const diff1 = await b.call('ego_snapshot', { diff: true })
  check('diff after click reports added item', diff1.ok === true && diff1.changed === true && diff1.addedCount >= 1, JSON.stringify(diff1.summary))
  const diff2 = await b.call('ego_snapshot', { diff: true })
  check('diff with no change is stable', diff2.ok === true && diff2.changed === false, diff2.summary)
  const fill = await b.call('ego_fill', { selector: '#q', text: 'hello' })
  check('fill succeeds', fill.ok === true)
  const diff3 = await b.call('ego_snapshot', { diff: true })
  check('diff reports input value change', diff3.ok === true && diff3.changedCount >= 1, JSON.stringify(diff3.changedLines?.[0]))

  // 5. screenshots
  const normal = await b.call('ego_screenshot', {})
  const fullShot = await b.call('ego_screenshot', { fullPage: true })
  const clipShot = await b.call('ego_screenshot', { clip: { x: 10, y: 10, width: 100, height: 50 } })
  const normalSize = parsePng(await readFile(normal.path))
  const fullSize = parsePng(await readFile(fullShot.path))
  const clipSize = parsePng(await readFile(clipShot.path))
  check('screenshot files written', Boolean(normalSize && fullSize && clipSize))
  check('fullPage is taller than viewport', fullSize.height > normalSize.height, `${normalSize.height} → ${fullSize.height}`)
  check('clip honours requested box', clipSize.width <= 100 && clipSize.height <= 50 && clipSize.width > 0, `${clipSize.width}x${clipSize.height}`)
  let invalidShot = false
  try {
    await b.call('ego_screenshot', { selector: '#add', fullPage: true })
  } catch (error) {
    invalidShot = String(error?.message ?? error).includes('fullPage/clip only apply')
  }
  check('selector+fullPage rejected', invalidShot)

  // 6. tabs + spaces ownership
  const tabs = await b.call('ego_tabs', { action: 'list' })
  check('tabs list returns tabs', tabs.ok === true && Array.isArray(tabs.tabs) && tabs.tabs.length >= 1, `${tabs.tabs?.length} tab(s)`)
  check('tabs list returns spaces with ownership', tabs.ok === true && Array.isArray(tabs.spaces) && tabs.spaces.length >= 1, JSON.stringify(tabs.spaces?.[0]))

  // 7. structured failure contract
  const missing = await b.call('ego_click', { selector: '#does-not-exist-0913' })
  check('missing selector is a structured failure', missing.ok === false && typeof missing.code === 'string', `${missing.code} actionSent=${missing.actionSent} retry=${missing.retry}`)
  check('failure carries hint + reobserve', missing.retry === 'reobserve' && typeof missing.hint === 'string' && missing.actionSent === true)
  const cliFail = await b.call('ego_cli', { script: "throw new Error('smoke-boom')" })
  check('ego_cli failure is structured', cliFail.ok === false && typeof cliFail.code === 'string' && typeof cliFail.retry === 'string', `${cliFail.code} retry=${cliFail.retry}`)

  // 8. help registry
  const helpList = await b.call('ego_help', { topic: 'list' })
  check('help list groups topics', helpList.ok === true && helpList.text.includes('inline:') && helpList.text.includes('lookup:'))
  check('help list exposes login-import on win32', helpList.text.includes('login-import') && helpList.text.includes('discipline'))
  const gui = await b.call('ego_help', { topic: 'gui-test' })
  check('help gui-test topic', gui.ok === true && gui.text.includes('黑盒测试'))

  // 9. stability loop
  const timings = []
  let loopOk = true
  for (let i = 0; i < 8; i++) {
    const started = Date.now()
    const info = await b.call('ego_page_info')
    const d = await b.call('ego_snapshot', { diff: true })
    timings.push(Date.now() - started)
    if (info.ok !== true || d.ok !== true) loopOk = false
  }
  check('8 observe cycles stable', loopOk, `min ${Math.min(...timings)}ms / max ${Math.max(...timings)}ms`)
  check('observe cycle under 15s', Math.max(...timings) < 15_000, `${Math.max(...timings)}ms`)

  // 10. rulesPrompt=false suppresses the block
  const b2 = bench({ rulesPrompt: false, defaultSpace: 'smoke-0913-off' })
  await b2.call('ego_help')
  check('rulesPrompt=false renders empty', b2.sections[0].text({}) === '')
} catch (error) {
  failures++
  console.error('\nUNEXPECTED ERROR:', error)
} finally {
  server.close()
  try {
    execFileSync(process.execPath, [EGO_BIN, '--stop'], {
      env: { ...process.env, EGO_LINUX_STATE_DIR: stateDir, EGO_LINUX_HEADLESS: '1' },
      timeout: 20_000,
      stdio: 'ignore',
    })
  } catch { /* best effort */ }
  await rm(stateDir, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n=== ${results.length - failures}/${results.length} passed, ${failures} failed ===`)
process.exit(failures === 0 ? 0 : 1)
