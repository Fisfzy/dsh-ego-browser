# ego-browser 改进方案（借鉴 CUA / cua-driver）

- **状态**：提案，未实施
- **作者**：lead（本次会话，2026-11-15）
- **适用版本**：`dsh-ego-browser` 0.9.15（`C:\Users\Fisfzy\.dsh\.external-plugins\ego-browser`，git `9e61b7e`）
- **执行者**：另一个 SESSION（本文档即完整任务书，无需回看原对话）
- **参照物**：本机已装好的 CUA provider — `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native@0.2.2-rc.3`（内嵌 `@trycua/cua-driver@0.28.0`），工具前缀 `cua_driver_native__*`

---

## 0. 一句话

ego-browser 是**页面内**（CDP/DOM）的浏览器驱动，CUA 是**桌面级**（UIA + 位图 + CDP）的原生驱动。
两者能力互补，但有四样 CUA 做得好、ego 缺的东西值得抄：**动作后置断言、陈旧引用硬失败、观察成本分级、可回放证据**。

**非目标（明确不要做）**：不要把 ego 的感知层换成 UIA 树，不要把 ego 改成进程内 native，不要引入 CUA 的桌面会话/权限模型。理由见 §7。

---

## 1. 现状锚点（改之前先按这张表定位）

文件：`lib/index.js`（8011 行，**唯一权威源**；不要新建 `src/`、不要用 tsc 覆盖，见 `docs/ARCH.md` §6）

| 锚点 | 行号 | 说明 |
|---|---|---|
| `RETRY` 策略表 | 3159 | `code → 'retry' \| 'reobserve' \| 'never'` |
| `classifyEgoFailure(tool, error)` | 3177 | 正则分类 → `{code, actionSent, retry, hint}` |
| `failureValue(tool, error)` | 3201 | 统一失败返回（**永不 throw**） |
| `EGO_RULES_TEXT` | 3223 | 常驻 system prompt 的短规则 |
| `SnapshotCache` 类 | 3377 | `entries: Map<key, text>`，`get/set/clear/observe` |
| `SnapshotCache.observe` | 3404 | diff 逻辑 + baseline 语义 |
| `registerActionTools` | 5085 | 绝大多数 `ego_*` 在此注册 |
| `EGO_HELP_INDEX` | 5087 | `ego_help` 索引（rules/errors/tools/observe/input/…） |
| `const snapshotCache = new SnapshotCache(32)` | 5110 | 全局单例 |
| `defineEgoTool(ctx,cfg,opts)`（= `t()` 基座） | 6166 | 加锁 + 观测钩子 + stale-space 重试 + 输出 |
| `ego_snapshot` 注册 | 6863 | `page.snapshotRaw()` → 文本 → `snapshotCache.observe()` |
| `commonOutputSchema` | ~6100 | `{type:'object', additionalProperties:true, properties:{ok:{type:'boolean',required:true}}}` |

`t()` 支持的可选钩子：`buildScript / transformValue / successHint / afterExecute / deliverFiles / render`。
**这四个改进里有三个完全不需要动 runtime，只加钩子即可。**

---

## 2. 改动总览

| 编号 | 改进 | 优先级 | 价值 | 动 runtime? | 估算 | 风险 |
|---|---|---|---|---|---|---|
| **P0-1** | `ego_verify` 动作后置断言 | P0 | 消灭“点了就算成功”的幻觉 | 否 | 200~260 行 | 低 |
| **P0-2** | `snapshotId` + `STALE_REF` 硬失败 | P0 | 消灭“拿旧 ref 瞎点” | 否 | 90~130 行 | 低（默认参数，向后兼容） |
| **P1-3** | 快照作用域裁剪 + 截断续读 | P1 | 大页面 token 降一个量级 | 否（文本层裁剪） | 150 行 | 中（裁剪正确性） |
| **P1-4** | 轨迹记录 + 回放 | P1 | 可复现、可回归测试 | 否 | 220 行 | 低（默认关闭） |
| **P2-5** | 原生对话框兜底（与 CUA 互补） | P2 | 补齐 ego 的能力断点 | 否（只探测 + 文档） | 60 行 | 极低 |
| **P2-6** | 观察窗“幽灵光标” | P2 | 用户可见性 | 是（worker + 前端） | 300 行 | 高（单文件前端限制） |

**建议交付节奏**：P0-1 → P0-2 → （验收后）P1-3 → P1-4。P2 单独排期。

---

## 3. P0-1 `ego_verify`：动作后置条件断言

### 3.1 问题

现在 ego 只有**等待原语**（`ego_wait_for_selector` / `ego_wait_for_url` / `ego_wait_for_response`），没有**断言原语**。
模型点完只能靠 `ego_page_info` 或下一轮快照“猜”，于是出现两种坏循环：重复点击、以及把 `actionSent:true` 当成成功。

CUA 对应物是 `verify_state`：1~8 个谓词 AND 组合，`stable_samples` 连续采样，返回
`satisfied / unsatisfied / unknown`，并且**明确写死 unknown 永不等于成功**。

### 3.2 接口

工具名：`ego_verify`，注册在 `registerActionTools` 内（与 `ego_snapshot` 相邻）。

```ts
parameters: {
  space?: string,
  predicates: Array<{
    kind: 'selector' | 'text' | 'value' | 'url' | 'count'
    selector?: string                 // selector/text/value/count 必填
    state?: 'attached'|'visible'|'hidden'|'detached'   // 默认 visible
    equals?: string                   // text/value 精确匹配
    contains?: string                 // 子串
    pattern?: string                  // 正则源串（new RegExp(pattern)）
    min?: number, max?: number        // kind=count
    url?: string                      // kind=url：子串或 ** glob
  }>,
  timeoutMs?: number,        // 默认 5000，上限 60000
  stableSamples?: number,    // 1~5，默认 2
  pollMs?: number            // 默认 200
}
```

返回（`ok:true` 只代表“校验执行了”，答案在 `verdict`）：

```ts
{
  ok: true,
  verdict: 'satisfied' | 'unsatisfied' | 'unknown',
  satisfied: boolean,          // verdict === 'satisfied'
  results: Array<{ index: number, ok: boolean, observed?: string, reason?: string }>,
  polls: number,
  elapsedMs: number,
  reason?: string              // verdict=unknown 时的原因，如 'DIALOG_BLOCKING'
}
```

### 3.3 语义（照抄 CUA 的严格性）

1. **全部谓词 AND**；任一 `unsatisfied` 且还有时间就继续轮询，直到 `timeoutMs`。
2. `stableSamples`：连续 N 次轮询都是 satisfied 才返回 satisfied（防过渡态）。
3. **unknown ≠ 成功**：
   - 页面 `evaluate` 抛错 / frame detach / `ego_page_info` 报告对话框打开 → `verdict:'unknown'`，`reason` 用现有错误码词表（`DIALOG_BLOCKING` 等）
   - 选择器语法非法 → 直接 `failureValue('ego_verify', ...)`，走 `INVALID_ARGS`（`never`）
4. 超时仍未满足 → `verdict:'unsatisfied'`（**不是错误**，`ok:true`），并在 `reason` 里给最后一次观测值。

### 3.4 实现要点

`buildScript` 里生成一段在 ego-lite 内执行的循环（**不要**在宿主侧轮询，那会反复 spawn）：

```js
// 伪代码，落在 buildScript 返回的字符串里
const deadline = Date.now() + timeoutMs
let streak = 0, polls = 0, last = null, error = null
for (;;) {
  polls++
  try {
    last = await page.evaluate(<内联函数，一次性评估所有谓词，返回 [{ok, observed}]>)
    // 网页内评估：selector → !!document.querySelector / 可见性用 getComputedStyle+getBoundingClientRect
    //               text → (el.innerText ?? el.textContent) 截断 200 字
    //               url   → location.href
    //               count → querySelectorAll(selector).length
    error = null
  } catch (e) { error = String(e); last = null }
  if (error) break
  const all = last.every(x => x.ok)
  streak = all ? streak + 1 : 0
  if (streak >= stableSamples) break
  if (Date.now() > deadline) break
  await page.waitForTimeout(pollMs)
}
console.log('@@DSH_RESULT@@' + JSON.stringify({ ok: true, verdict, results: last, polls, elapsedMs, reason }))
```

注意事项（踩过）：

- **对话框打开时不要 `page.evaluate`**（`docs/ARCH.md` §2 已警告会挂起）→ 先用现有 `HUMAN_CHECK_PROBE` 同款思路之外的便宜判断：捕获 evaluate 超时即返回 unknown + `DIALOG_BLOCKING`。
- 跨域 iframe 内元素：`querySelector` 打不到，`observed` 返回空但谓词为 `false`；在 `hint` 里提示改用 `ego_snapshot` 的 ref。
- `text` 谓词要取 `innerText` 而非 `textContent`（隐藏文本会造成假阳性）。
- 一次 `evaluate` 里评估全部谓词（避免 N 次往返）；单个谓词的异常不能让整体崩，用 try/catch 包成 `{ok:false, reason}`。

### 3.5 接线与文档

1. `RETRY` 表（3159）**不需要新增码**（verify 本身返回 `ok:true`）。
2. `EGO_HELP_INDEX.tools`（5087 起）追加 `ego_verify`；`observe` 段落补一句：
   `ego_verify: 动作后断言预期（选择器/文本/值/URL/数量），返回 satisfied/unsatisfied/unknown；unknown 不等于成功。`
3. `EGO_RULES_TEXT`（3223）第 2 条改成：
   `…动作后用最便宜的方式确认：能写成断言就用 ego_verify，否则 ego_page_info / ego_read_element；不要默认全量快照+截图。`
4. `ACTION_SUCCESS_HINT`（~5120）追加导出提示：`预期变化可用 ego_verify 断言。`
5. 版本号 0.9.15 → 0.10.0（新增工具，minor）。

### 3.6 验收用例（必须写进 `tests/verify.test.ts`）

- 单个 selector 可见 → satisfied
- selector 不存在且超时 → unsatisfied（`ok:true`）
- `text contains` 命中 / 未命中
- 3 个谓词 AND，其中 2 真 1 假 → unsatisfied，`results` 长度 3
- `stableSamples:2`：第 1 次为真、第 2 次为假 → 不得返回 satisfied
- evaluate 抛错 → verdict unknown 且 `satisfied:false`
- 非法谓词（`kind:'count'` 缺 selector）→ `code:'INVALID_ARGS'`

测试写法参照 `tests/snapshot-diff.test.ts`（同样的 buildScript 断言 + mock runtime 模式）。

---

## 4. P0-2 `snapshotId` + `STALE_REF`

### 4.1 问题

`ego_snapshot` 每次重建 ref，但**插件不校验旧 ref**；只有“找不到元素”时才报 `LOCATOR_NOT_FOUND`。
模型拿着上一页的 `ref=12` 去点，很可能点到同编号的另一个元素 —— 静默错误，比报错危险得多。

CUA 的做法是 fail-closed：`element_token` 带快照代次，旧代次一律拒绝。
ego 现有 `SPACE_STALE` 处理的是“浏览器重启后空间指针失效”，**不是元素 ref**，别混淆。

### 4.2 设计（全部在插件侧，向后兼容）

1. `SnapshotCache`（3377）：`entries` 的值由 `string` 改为 `{ text, id, seq }`。
   - `id` 形如 `s` + 8 位小写十六进制（沿用 CUA 的 `^s[0-9a-f]{8}$` 形态，便于模型识别）
   - `observe()` 在 `diff:false` 时生成新 `id`；`diff:true` 返回**基线 id**（不推进代次）
   - 新增 `currentId(key)`；`get(key)` 返回值保形兼容（内部取 `.text`）
2. `ego_snapshot` 的 `transformValue`（6863 附近）在返回值里加 `snapshotId`（diff 模式也带，值为基线 id）。
3. 动作类工具新增**可选** `snapshotId` 参数：`ego_click`、`ego_fill`、`ego_check`、`ego_select`、`ego_hover`、`ego_drag`（ref 目标那几个）。
4. **校验点放在 `execute` 里、`runWithStaleSpaceRetry` 之前**（`defineEgoTool`，6166）：解析出当前 key（`sessionId:space:full_page`），若传了 `snapshotId` 且不等于 `currentId(key)`：
   ```
   failureValue('ego_click', 'stale snapshot: expected s1a2b3c4, current s9f8e7d6 — call ego_snapshot again')
   ```
5. 新错误码 `STALE_REF`：
   - `RETRY.STALE_REF = 'reobserve'`
   - `HINTS.STALE_REF = '快照代次已过期：先 ego_snapshot 取新快照，再用新的 ref/loc 操作；不要复用旧 ref。'`
   - 加入 `PRE_ACTION_CODES`（**动作未发送**，`actionSent:false`）
6. `EGO_HELP_INDEX.errors`（5087 起）补 `STALE_REF` 一行；`observe` 段说明“ref 只在同一 snapshotId 下有效”。

### 4.3 兼容性硬要求

- **不传 `snapshotId` 时行为完全不变**（不能让第三方脚本/老调用断掉）
- diff 快照的 `snapshotId` 只用于“说明基线”，不可作为动作依据（文案里写清楚）
- 快照 key 必须与 `snapshotCache` 现有 key 完全一致：`${sessionId ?? '-'}:${space}:${scope}`

### 4.4 验收用例（`tests/snapshot-generation.test.ts`）

- snapshot 两次 → `snapshotId` 不同
- 用第一次的 id 调 `ego_click` → `code:'STALE_REF'`、`actionSent:false`、`retry:'reobserve'`
- 用最新 id → 正常执行
- 不传 id → 正常执行（回归）
- diff 快照 → 不推进代次，且返回基线 id

---

## 5. P1-3 观察成本分级（scope 裁剪 + 截断续读）

### 5.1 问题

大页面全量语义树动辄上万 token。CUA 的 `query` 投影 / `max_dimension` / `zoom` / `continuation` 是“按需付费”的完整方案；ego 只有 `diff` 和 `only_within_viewport`。

### 5.2 设计

`ego_snapshot` 增参：

```ts
{
  scope?: 'full_page' | 'only_within_viewport',   // 现有
  subtreeRef?: number,        // 新增：只看某个 ref 的子树
  maxChars?: number,          // 新增：默认 24000，超限截断
  continuation?: string       // 新增：上一次返回的续读游标
}
```

- `subtreeRef`：优先探测 runtime 的 `page.snapshotRaw({ scope: 'ref:12' })` 是否支持；
  **不支持就在插件侧对文本裁剪**——快照是缩进树，按 `[ref=12]` 行的缩进深度切出子树即可（保留表头/URL 行）。
- `maxChars` 截断时返回 `truncated:true` + `continuation`（插件侧按快照文本行号偏移生成，如 `s1a2b3c4:1200`）。
- `continuation` 必须绑定 `snapshotId`：代次不匹配就返回 `STALE_REF`，避免拿到两份不同的树。

### 5.3 验收

- 大页面 `maxChars:4000` → 输出 ≤ 4000 字 + `truncated:true`
- 拿 `continuation` 续读 → 不重复、不跳行
- `subtreeRef` 指向不存在的 ref → `LOCATOR_NOT_FOUND` + hint 指向重新快照

---

## 6. P1-4 轨迹记录 + 回放

### 6.1 问题

CUA 每一步落 `before.png / after.png / action.json`，可 `replay_trajectory` 做回归。
ego 有 60 个测试文件，但**真实会话不可复现**：出问题只能靠对话记录复盘。

### 6.2 设计

1. 钩子位置：`defineEgoTool`（6166）里已有 `afterExecute`，不变更结构，只在外层包一个 `recordTrajectory()`。
2. 记录一条 JSONL：

```json
{"ts":"2026-11-15T07:12:33.120Z","tool":"ego_click","args":{"selector":"#submit"},"ok":true,"code":null,"actionSent":true,"durationMs":812,"url":"https://...","space":"dsh-agent","snapshotId":"s1a2b3c4"}
```

3. 落盘：`~/.dsh/plugin-data/ego-browser/trajectories/<sessionId>.jsonl`
   （走 DSH 的 plugin-data 目录，**不要**写进插件包或仓库）
4. 默认**关闭**，配置项 `trajectory: boolean`（默认 false）；开启时按会话滚动，单文件上限 2MB。
5. **脱敏**：`ego_fill` / `ego_key(text)` 的入参默认记录为 `"<redacted>"`；仅当配置 `recordText:true` 时才记原文。
6. 回放：`scripts/replay.mjs`（Node，不进 lib）读 JSONL，按序重发工具调用，逐条断言 `ok` 与 `actionSent`。
   失败即停并打印差异；**不自动截图**（避免隐私）。

### 6.3 验收

- 开启后跑 5 个动作 → JSONL 有 5 行，字段齐全
- `ego_fill` 的 `args.text` 默认是 `"<redacted>"`
- 回放同一会话 → 全部 `ok:true`
- 关闭配置 → 不产生任何文件（回归）

---

## 7. P2-5 原生对话框兜底（和 CUA 互补，不是合并）

### 7.1 事实

ego 的能力**止步于页面**。文件选择框（`ego_upload` 用 `setInputFiles` 绕过）、另存为、打印、证书警告、下载栏、系统权限弹窗都在 DOM 之外。
本机 CUA 实测可覆盖这些（`cua_driver_native__list_windows` 能看到 22 个窗口 / 14 个应用）。

### 7.2 设计（只做探测 + 文档，不做耦合）

1. `apply()` 里探测：`ctx.tools.definitions()` 中是否存在 `cua_driver_native__list_windows`。
2. 探测到时，`ego_help` 增加 topic `native`：
   ```
   原生对话框（文件选择/另存为/打印/证书/权限弹窗）不在页面里，ego_* 无法处理。
   本机可用 cua_driver_native__list_windows → get_window_state → click/set_value 操作。
   ```
3. `EGO_RULES_TEXT` 加一条：`页面之外的系统弹窗改用 cua_driver_native__* 工具，不要用 ego_key 盲敲。`
4. **不要**在 ego 里封装 CUA 工具（两套工具并存更清晰，模型自己选）。

---

## 8. P2-6 观察窗“幽灵光标”（可选）

CUA 有 agent 光标 overlay，用户能看见 agent 正点哪儿。ego 已经有实时画面（`/api/ego/stream`），叠加一层很自然：

- worker（`bin/ego-cast-worker.mjs` / `src/worker/`）在每次 `ego_click`/`ego_hover` 后往 SSE metadata 里塞一个 `{x, y, kind, ttlMs}`
- `lib/client.js`（单文件，受注入机制限制）用绝对定位 div + 渐隐渲染

**风险**：前端单文件 + 需要重启 worker/DSH；先把 P0/P1 做完再评估。

---

## 9. 明确不建议做

| 提议 | 为什么不 |
|---|---|
| 把 ego 的感知换成 UIA 无障碍树 | 实测 CUA 在 Chromium 窗口的 UIA 树几乎是空的（查「发送」只匹配 3 个节点）。CDP 语义树对网页质量高一个数量级 |
| 把 ego 改成进程内 native 模块 | ego-lite 是 JS；`residentExecutor` 开关已解决冷启动。重写只换崩溃域，不换能力 |
| 引入 CUA 的桌面会话/权限模型 | 对纯浏览器场景是过度设计（CUA 的 session/escalate/persist 是为跨应用设计的） |
| 弃用 ego 的实时观察窗、验证码识别、登录态导入 | 这三样是 CUA **没有**的，是 ego 的护城河 |

---

## 10. 交付规范（照 `docs/ARCH.md` §6）

1. **只改 `lib/`**（唯一权威）。不建 `src/`，不跑 tsc 覆盖。
2. 改完必须：
   ```powershell
   cd C:\Users\Fisfzy\.dsh\.external-plugins\ego-browser
   node --check lib/index.js
   npm run build      # 只做语法/打包校验，不生成覆盖
   npm test           # vitest，60 个测试文件，不许有红
   ```
3. 新增工具必须同步：`EGO_HELP_INDEX.tools`、`EGO_HELP_INDEX.errors`（新错误码）、`EGO_RULES_TEXT`、`STATUS_RULES_SUMMARY`（如需）。
4. 版本号：P0-1/P0-2 合并发 0.10.0；P1-3 0.11.0；P1-4 0.12.0。
5. 前端/worker 改动需**重启 DSH**；纯 host 工具改动同样要重启才能重新注册工具（`apply()` 只在启动时跑）。
6. 每项改完在 `docs/plans/` 留一份简短变更记录；`runtime/` 若被碰过，必须写 `runtime/PATCHES.md`。

---

## 11. 验收清单

- [ ] `ego_verify` 注册成功，`ego_help` 能看到它
- [ ] 7 条 verify 用例全绿（§3.6）
- [ ] `ego_snapshot` 返回 `snapshotId`
- [ ] 旧 `snapshotId` 触发 `STALE_REF` + `actionSent:false` + `retry:'reobserve'`
- [ ] 不传 `snapshotId` 的调用行为零变化
- [ ] 5 条代次用例全绿（§4.4）
- [ ] `npm test` 全绿，`node --check` 通过
- [ ] 真实浏览器手工验证：打开一个页面 → 快照 → 点击 → `ego_verify` 断言跳转成功
- [ ] 重启 DSH 后，新工具出现在模型工具列表里（名字搜索 `ego_verify`）
- [ ] `docs/ARCH.md` 的行号表更新（`lib/index.js` 行号会漂移）

---

## 12. 附：CUA 侧参照实现（读源码时对照）

- provider 源码：`~/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-experimental-computer-use-cua-driver-native/src/index.ts`
  —— 看它如何把 native 工具目录（`listToolsJson`）经 `createMcpToolDefinition` 映射成 DSH 工具，
  以及 `structuredContent` / `isError` / `degraded` 如何原样透传给模型（这是“结果结构化”的参考）
- 验证工具语义：工具名 `cua_driver_native__verify_state`，参数 `expect[]` + `stable_samples` + `timeout_ms`，返回 `satisfied/unsatisfied/unknown`
- 快照语义：`cua_driver_native__get_window_state` 返回 `elements[]`（带 `element_token`）、`query` 投影、`max_dimension`
- 本机实测记录：`~/.dsh/HANDOFF-cua-windows-20261115.md`
