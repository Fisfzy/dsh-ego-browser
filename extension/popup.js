const DEFAULTS = { domains: '', port: '53820', token: '' }

const $ = (id) => document.getElementById(id)

async function load() {
  const saved = await chrome.storage.local.get(DEFAULTS)
  $('domains').value = saved.domains || ''
  $('port').value = saved.port || '53820'
  $('token').value = saved.token || ''
}

async function save() {
  await chrome.storage.local.set({
    domains: $('domains').value,
    port: $('port').value,
    token: $('token').value,
  })
}

function domainsFrom(text) {
  return String(text || '')
    .split(/[\s,]+/)
    .map((s) => s.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean)
}

async function exportCookies() {
  const domains = domainsFrom($('domains').value)
  if (domains.length === 0) {
    $('status').textContent = 'Enter at least one domain.'
    return
  }
  const port = Number($('port').value) || 53820
  const token = $('token').value.trim()
  if (!token) {
    $('status').textContent = 'Paste the token from <stateDir>/login-extension-token.'
    return
  }
  $('export').disabled = true
  $('status').textContent = 'Reading cookies...'
  try {
    const cookies = []
    for (const domain of domains) {
      const list = await chrome.cookies.getAll({ domain })
      for (const c of list) {
        cookies.push({
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
    // Deduplicate by name|domain|path (same cookie can match overlapping domains).
    const seen = new Set()
    const unique = cookies.filter((c) => {
      const key = c.name + '|' + c.domain + '|' + c.path
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    $('status').textContent = `Sending ${unique.length} cookies for ${domains.length} domain(s)...`
    const res = await fetch(`http://127.0.0.1:${port}/cookies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ego-token': token },
      body: JSON.stringify({ token, domains, cookies: unique }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.ok !== true) {
      $('status').textContent = 'Failed: ' + (body.error || res.status)
      return
    }
    $('status').textContent = `Done: sent ${body.received} cookies, ${body.matched} matched the requested domains.`
    await save()
  } catch (err) {
    $('status').textContent = 'Failed: ' + (err && err.message ? err.message : String(err)) + '\nIs ego_login_import (source="extension") running?'
  } finally {
    $('export').disabled = false
  }
}

document.addEventListener('DOMContentLoaded', () => {
  void load()
  $('export').addEventListener('click', () => { void exportCookies() })
  for (const id of ['domains', 'port', 'token']) {
    $(id).addEventListener('change', () => { void save() })
  }
})
