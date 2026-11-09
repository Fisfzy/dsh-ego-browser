/**
 * src/errors.ts — structured failure contract for ego_* tools.
 *
 * ZCode's browser-use / computer-use return `code` + `actionSent` + `retry` on
 * failure so the model can decide between "observe again" and "retry". We keep
 * the same shape natively: a *domain* failure becomes a canonical tool value
 * instead of a thrown Error (DSH tools.md: infrastructure failures throw;
 * successful domain results, even unhappy ones, are values interpreted by the
 * renderer). The renderer turns that value into a short actionable message.
 *
 * `actionSent` answers "may the page-changing action already have reached the
 * page?". A retry of a non-idempotent action (click, fill, key) is only safe
 * when it is false; otherwise observe first.
 */

export type EgoFailureCode =
  | 'TIMEOUT'
  | 'LOCATOR_NOT_FOUND'
  | 'NAVIGATION_FAILED'
  | 'DIALOG_BLOCKING'
  | 'CAPTCHA'
  | 'USER_CONTROLLING'
  | 'SPACE_STALE'
  | 'BROWSER_DOWN'
  | 'NO_PAYLOAD'
  | 'INVALID_ARGS'
  | 'UNKNOWN'

export type EgoRetry = 'reobserve' | 'retry' | 'never'

export interface EgoFailure {
  code: EgoFailureCode
  actionSent: boolean
  retry: EgoRetry
  hint: string
}

/** Tools whose failure may mean the page action already reached the page. */
const ACTION_TOOLS = new Set([
  'ego_navigate',
  'ego_click',
  'ego_fill',
  'ego_key',
  'ego_select',
  'ego_check',
  'ego_drag',
  'ego_scroll',
  'ego_upload',
  'ego_dialog',
  'ego_download',
  'ego_js',
  'ego_cdp',
  'ego_http',
])

/** Codes that fail before anything reaches the page. */
const PRE_ACTION_CODES = new Set<EgoFailureCode>([
  'INVALID_ARGS',
  'BROWSER_DOWN',
  'SPACE_STALE',
  'USER_CONTROLLING',
])

const HINTS: Record<EgoFailureCode, string> = {
  TIMEOUT:
    '动作用时超时：先 ego_page_info / ego_snapshot 看当前状态，不要原样重试同一动作。',
  LOCATOR_NOT_FOUND:
    '目标没找到：重新 ego_snapshot 取最新 ref 或换定位方式，不要重试旧 selector/ref。',
  NAVIGATION_FAILED:
    '导航失败：核对 URL 与网络；先 ego_page_info 确认当前页，再决定下一步。',
  DIALOG_BLOCKING:
    '页面有未处理的对话框：先用 ego_dialog 接受/取消，再继续操作。',
  CAPTCHA:
    '页面出现人机验证：让用户在 ego 浏览器里完成，或用 ego_wait_for_human 等待；不要尝试绕过。',
  USER_CONTROLLING:
    '用户已接管浏览器：停下来询问用户，不要 takeOver 或重试。',
  SPACE_STALE:
    '任务空间已失效：插件会重置到空间名重试；仍失败就用 ego_space_open 重新打开。',
  BROWSER_DOWN:
    '浏览器不可用：跑 ego_doctor 体检；等待冷启动或重启后再试。',
  NO_PAYLOAD:
    '脚本没有产生结果：先用 ego_page_info 确认页面状态，再重试。',
  INVALID_ARGS:
    '参数不合法：按提示修正后重试，不要原样发送。',
  UNKNOWN:
    '先观察再决定：用 ego_page_info / ego_snapshot 看当前状态，不要重复同一动作。',
}

const RETRY: Record<EgoFailureCode, EgoRetry> = {
  TIMEOUT: 'reobserve',
  LOCATOR_NOT_FOUND: 'reobserve',
  NAVIGATION_FAILED: 'reobserve',
  DIALOG_BLOCKING: 'reobserve',
  CAPTCHA: 'never',
  USER_CONTROLLING: 'never',
  SPACE_STALE: 'retry',
  BROWSER_DOWN: 'retry',
  NO_PAYLOAD: 'retry',
  INVALID_ARGS: 'never',
  UNKNOWN: 'reobserve',
}

/**
 * Classify a failure message into the stable contract.
 *
 * Order matters: user-control / stale-space / browser-down are checked before
 * the generic timeout/not-found patterns, because their messages often contain
 * those words too and misclassifying them would invite an unsafe retry.
 */
export function classifyEgoFailure(tool: string, error: string): EgoFailure {
  const message = error.trim()
  let code: EgoFailureCode = 'UNKNOWN'
  if (/user is controlling|user-owned|not assigned to an agent|ownership/i.test(message)) {
    code = 'USER_CONTROLLING'
  } else if (/task space not found/i.test(message)) {
    code = 'SPACE_STALE'
  } else if (
    /cdp channel is not open|could not connect|econnrefused|browser (was |is )?not (reachable|running|ready)|failed to spawn|cli could not be started|enoent/i.test(
      message,
    )
  ) {
    code = 'BROWSER_DOWN'
  } else if (/^(ego_[a-z_]+:\s*)?(provide|url is required|missing|requires|invalid|expected )/i.test(message)) {
    // Our own pre-action validation. Checked before the locator patterns
    // because such a message often names a selector/x-y pair and would
    // otherwise be misread as a missing element.
    code = 'INVALID_ARGS'
  } else if (/captcha|human verification|turnstile|recaptcha|hcaptcha/i.test(message)) {
    code = 'CAPTCHA'
  } else if (/native dialog|javascript dialog|dialog (is|was) (open|blocking)|blocked by a dialog/i.test(message)) {
    code = 'DIALOG_BLOCKING'
  } else if (/timed? ?out|timeout|deadline exceeded/i.test(message)) {
    code = 'TIMEOUT'
  } else if (
    /not found|no element|unable to find|strict mode violation|selector|locator|element (is )?not|no node/i.test(
      message,
    )
  ) {
    code = 'LOCATOR_NOT_FOUND'
  } else if (/net::err|navigation|frame was detached|goto /i.test(message)) {
    code = 'NAVIGATION_FAILED'
  } else if (/no .*json payload|no @@ego|finished but no/i.test(message)) {
    code = 'NO_PAYLOAD'
  }
  const actionSent = ACTION_TOOLS.has(tool) && !PRE_ACTION_CODES.has(code)
  return { code, actionSent, retry: RETRY[code], hint: HINTS[code] }
}

/** The canonical failure value a tool returns (never thrown by design). */
export function failureValue(tool: string, error: string): EgoFailure & { ok: false; error: string } {
  return { ok: false, error, ...classifyEgoFailure(tool, error) }
}
