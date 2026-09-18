// tests/fixtures/fake-cast-worker.cjs
// Minimal stand-in for bin/ego-cast-worker.mjs: only the loopback endpoints the
// host's /api/ego/* routes touch, so the frame-relay tests exercise real HTTP
// proxying against a REAL child process (a pid that can actually be SIGTERMed).
//
// Usage: node fake-cast-worker.cjs <port-file>
// Binds an OS-chosen port (0) and writes it to <port-file> so the test never
// has to pre-allocate a port (which races with every other listener on the box).
const http = require('node:http')
const fs = require('node:fs')
const portFile = process.argv[2]
const json = (res, body, status) => {
  res.writeHead(status || 200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const server = http.createServer((req, res) => {
  const path = String(req.url || '').split('?')[0]
  if (path === '/api/health') return json(res, { ok: true })
  if (path === '/api/spaces') return json(res, { ok: true, spaces: [{ targetId: 'tab-1' }] })
  if (path === '/api/watch/status') return json(res, { ok: true, state: 'streaming' })
  if (path === '/api/config') return json(res, { ok: true })
  if (path === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(':up\n\n')
    res.end()
    return
  }
  return json(res, {}, 404)
})
server.listen(0, '127.0.0.1', () => {
  try { fs.writeFileSync(portFile, String(server.address().port)) } catch (e) { process.exit(1) }
})
