// MV3 service worker: polls the local ego-browser bridge on a 30s alarm (the
// minimum MV3 alarm period), with an immediate poll after pairing. This avoids
// relying on an offscreen document's API surface.
const ALARM = 'ego-bridge-poll'

async function readCookies(domains) {
  const out = []
  const seen = new Set()
  for (const domain of domains) {
    const list = await chrome.cookies.getAll({ domain })
    for (const c of list) {
      const key = c.name + '|' + c.domain + '|' + c.path
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: c.expirationDate,
        hostOnly: c.hostOnly,
      })
    }
  }
  return out
}

async function poll() {
  try {
    const { token, port } = await chrome.storage.local.get({ token: '', port: '53820' })
    if (!token) return
    const res = await fetch(`http://127.0.0.1:${port}/pending`, {
      headers: { 'x-ego-token': token },
      cache: 'no-store',
    })
    if (res.status === 204 || !res.ok) return
    const job = await res.json()
    if (!job || !job.jobId) return
    const cookies = await readCookies(Array.isArray(job.domains) ? job.domains : [])
    const post = await fetch(`http://127.0.0.1:${port}/cookies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ego-token': token },
      body: JSON.stringify({ token, jobId: job.jobId, cookies }),
    })
    const body = await post.json().catch(() => ({}))
    await chrome.storage.local.set({
      lastExport: { at: Date.now(), jobId: job.jobId, sent: cookies.length, ok: post.ok && body.ok === true, error: post.ok && body.ok === true ? '' : (body.error || post.status) },
    })
  } catch (err) {
    try { await chrome.storage.local.set({ lastExport: { at: Date.now(), ok: false, error: String(err && err.message || err) } }) } catch { /* ignore */ }
  }
}

function ensureAlarm() {
  void chrome.alarms.create(ALARM, { periodInMinutes: 0.5 })
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); void poll() })
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); void poll() })
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) void poll() })
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return
  if (message.type === 'ego-poke') {
    ensureAlarm()
    void poll()
    sendResponse({ ok: true })
    return
  }
  if (message.type === 'ego-export-job') {
    // Manual/testing path: the popup can trigger a single job immediately.
    ;(async () => {
      try {
        const { token, port } = await chrome.storage.local.get({ token: '', port: '53820' })
        const cookies = await readCookies(Array.isArray(message.domains) ? message.domains : [])
        const res = await fetch(`http://127.0.0.1:${port}/cookies`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-ego-token': token },
          body: JSON.stringify({ token, jobId: message.jobId, cookies }),
        })
        const body = await res.json().catch(() => ({}))
        sendResponse({ ok: res.ok && body.ok === true, sent: cookies.length, matched: body.matched, error: body.error })
      } catch (err) { sendResponse({ ok: false, error: String(err && err.message || err) }) }
    })()
    return true
  }
})

ensureAlarm()
void poll()
