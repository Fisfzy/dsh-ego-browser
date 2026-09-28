/**
 * src/captcha.ts — human-verification (CAPTCHA) detection probe.
 *
 * Standalone data module: HUMAN_CHECK_PROBE is a string that gets serialized
 * into a `page.evaluate` call to identify reCAPTCHA / hCaptcha / Turnstile /
 * Cloudflare / generic captcha. When changing probe heuristics, note that
 * bin/ego-cast-worker.mjs (now src/worker/ego-cast-worker.ts) has a similar
 * probe (HUMAN_PROBE_JS) — the two must stay in sync.
 */
export const HUMAN_CHECK_PROBE = `(() => {
  const sel = [
    'iframe[src*="recaptcha"]', '.g-recaptcha', '[data-sitekey]',
    '.h-captcha', 'iframe[src*="hcaptcha"]',
    '.cf-turnstile', 'iframe[src*="turnstile"]',
    'iframe[src*="cloudflare"]', '#challenge-form', '.challenge-form',
    '#captcha', '.captcha'
  ].join(',');
  const el = document.querySelector(sel);
  if (el) {
    const html = (el.outerHTML || '') + (el.closest('body') && el.closest('body').innerHTML ? '' : '');
    const s = String(html);
    if (/recaptcha|g-recaptcha/i.test(s)) return { detected: true, kind: 'recaptcha' };
    if (/hcaptcha|h-captcha/i.test(s)) return { detected: true, kind: 'hcaptcha' };
    if (/turnstile|cf-turnstile/i.test(s)) return { detected: true, kind: 'turnstile' };
    if (/cloudflare|challenge-form/i.test(s)) return { detected: true, kind: 'cloudflare' };
    return { detected: true, kind: 'captcha' };
  }
  // [#62] Text-only fallback. It used to match a bare /captcha/ word, which
  // fires on ANY page that merely discusses captchas — including a local
  // dashboard rendering an agent session whose transcript quotes this plugin's
  // own source. Two guards: loopback origins are never text-probed (a locally
  // served page is the user's own tooling, not a challenge page), and the
  // pattern requires a challenge *phrase* rather than the bare noun.
  const loc = String(location.hostname || '');
  if (loc === 'localhost' || loc === '127.0.0.1' || loc === '::1' || loc === '[::1]' || loc.endsWith('.localhost')) {
    return { detected: false, kind: null };
  }
  const txt = (document.body ? document.body.innerText || '' : '').slice(0, 120000);
  const lower = txt.toLowerCase();
  if (/verify (that )?you are (a )?human|your activity looks unusual|i.?m not a robot|confirm you.?re human|人机验证|安全验证|我是人类|滑块验证|拖动滑块|点击.{0,8}验证/.test(lower)) {
    return { detected: true, kind: 'captcha' };
  }
  return { detected: false, kind: null };
})()`
