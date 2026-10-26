const $ = (id) => document.getElementById(id)

async function load() {
  const saved = await chrome.storage.local.get({ port: '53820', token: '' })
  $('port').value = saved.port || '53820'
  if (saved.token) {
    $('status').innerHTML = '<span class="ok">Connected.</span> Use “复用 Chrome 登录态” in the Agent Browser panel.'
    $('code').disabled = true
    $('pair').disabled = true
  }
}

async function pair() {
  const port = Number($('port').value) || 53820
  const code = $('code').value.trim()
  if (!/^\d{6}$/.test(code)) {
    $('status').textContent = 'Enter the 6-digit code shown in the Agent Browser panel.'
    return
  }
  $('pair').disabled = true
  $('status').textContent = 'Pairing...'
  try {
    const res = await fetch(`http://127.0.0.1:${port}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.ok !== true) throw new Error(body.error || ('HTTP ' + res.status))
    await chrome.storage.local.set({ token: body.token, port: String(port) })
    try { await chrome.runtime.sendMessage({ type: 'ego-poke' }) } catch { /* alarm will retry */ }
    $('status').innerHTML = '<span class="ok">Connected.</span> Use “复用 Chrome 登录态” in the Agent Browser panel.'
    $('code').disabled = true
    $('pair').disabled = true
  } catch (err) {
    $('status').textContent = 'Pairing failed: ' + (err && err.message ? err.message : String(err)) + '\nIs ego_login_import/panel bridge running?'
    $('pair').disabled = false
  }
}

async function disconnect() {
  await chrome.storage.local.set({ token: '' })
  $('code').disabled = false
  $('pair').disabled = false
  $('status').textContent = 'Disconnected.'
}

document.addEventListener('DOMContentLoaded', () => {
  void load()
  $('pair').addEventListener('click', () => { void pair() })
  $('disconnect').addEventListener('click', () => { void disconnect() })
})
