# ego-browser 架构与维护指南

> 本文档是**代码健康**的核心：让任何维护者（含未来的科研整合包）在改代码前先看懂结构，
> 知道"改哪里、怎么改、别踩什么坑"，从而避免深度冲突和"改不动"。

## 0. 一句话

这是一个 DSH 插件：**自带 ego-lite 运行时**，把浏览器自动化能力封装成 `ego_*` 结构化工具，
并提供**双后端实时观察窗 + 人机验证提醒 + 下载捕获**。

---

## 1. 顶层结构

```
ego-browser/
  package.json          # 版本号、build=语法校验、exports
  lib/index.js          # [后端] 插件入口 + 30+ ego_* 工具注册（权威）
  lib/cast-server.js    # [后端] host 路由：把前端 /api/ego/* 转发到观察窗 worker
  lib/client.js         # [前端] 右下角观察窗（通过 DSH 注入加载，单文件）
  bin/ego-cast-worker.mjs  # [后端] 观察窗 worker：attach 浏览器、SSE 实时画面、humanCheck
  bin/cdp-client.mjs       # CDP 请求/错误/事件封装
  bin/capture-manager.mjs  # watcher lease、单后端状态机、generation
  bin/capture-cdp.mjs      # control session + 单 target JPEG capture
  bin/capture-ffmpeg.mjs   # FFmpeg 进程与 fMP4 发布
  bin/capture-platform.mjs # 平台来源/crop/argv
  bin/mp4-fragments.mjs    # 有界 ISO BMFF box parser
  runtime/              # vendored ego-lite 运行时（只读参照，本地改动见 runtime/PATCHES.md）
  docs/ARCH.md          # 本文件
```

**关键约定**：`lib/` 是唯一权威源。**不要**再建 `src/`、不要用 tsc 编译覆盖 lib
（v0.6.0 已删除 src 和 tsconfig，`npm run build` 只做语法校验）。

---

## 2. lib/index.js — 工具层（最大、最重要）

它内部已按职责清晰分区（虽然在一个文件里）：

| 行号段 | 职责 | 说明 |
|---|---|---|
| 顶部常量 | SENTINEL、探针、默认值 | 运行时哨兵、配置默认 |
| `withEgoLock` | 全插件工具互斥锁 | 所有 ego_* 串行，防争用同一浏览器 |
| `findChromeBinary` / `resolveEgoEnv` | Chrome 探测 / 环境自适应 | 找 Chrome/Edge/Brave，headless 兜底 |
| `runEgoScript` / `parseSentinel` / `withWarmupRetry` | 脚本执行引擎 | 每个工具 spawn `ego-browser nodejs` 跑一段 JS |
| `defineEgoTool` / `t()` | 工具封装基座 | 统一加锁 + 冷启动重试 + 输出 |
| `registerActionTools` | **大部分 ego_* 工具** | 用 `t({ name, description, parameters, buildScript })` 逐个注册 |
| `registerHelpAndDoctor` | ego_help / ego_doctor / ego_script / ego_captcha | 辅助工具 |
| `EGO_HELP_INDEX` / `HUMAN_CHECK_PROBE` | 工具索引文案 / 人机验证探针 | 数据为主 |

### 怎么加一个工具（新功能入口）
1. 在 `registerActionTools` 里 `reg(t({ name:'ego_xxx', description, parameters:{...}, buildScript:(args)=>\`…\` }))`
2. `buildScript` 返回一段会在 `ego-browser nodejs` 里执行的 JS（可用 `page/browser/taskSpaces/site/fetch/cdp`）
3. 结束后用 `console.log('@@DSH_RESULT@@'+JSON.stringify(payload))` 回传结构化结果
4. 在 `EGO_HELP_INDEX` 补一条；改完跑 `npm run build` 校验

### 注意
- 所有操作浏览器的工具**必须**走 `withEgoLock`（`t()` 会自动包）——不要绕过它
- 对话框类工具**不要在对话框弹出时**执行 `page.evaluate`（会挂起），用 CDP `Page.handleJavaScriptDialog`
- `fetch.server`（Node 侧）在 Windows runtime 会触发 libuv 崩溃——`ego_http` 默认走 `fetch.browser`

---

## 3. lib/client.js — 观察窗前端（单文件，受 DSH 注入机制限制）

受 `window.__ModuleLoader__.load({...})` 打包机制限制，**前端只能单文件**，不要拆物理文件。
内部按 section 组织：CSS → icons → apply() → 各交互/渲染函数。

维护时要同步注意：
- 数据源：`/api/ego/stream` 提供元数据、CDP JPEG 与 capture status；`/api/ego/video` 提供 FFmpeg 二进制 fMP4
- 生命周期：浮窗/side Tab 通过 `/api/ego/watch/*` 获取租约；组件逻辑隐藏或 dispose 时释放，`document.hidden` 不释放，以避免后台切换重建 WGC/FFmpeg
- renderer：CDP 用 `<img>` + rAF 最新帧；FFmpeg 用 generation-aware `MediaSource` + `<video>`
- 坐标交互：`makeDraggable`（球/窗口各自拖动）、`browserXY`（坐标逆映射）
- 键盘交互：画面点击聚焦透明 textarea；beforeinput/composition 发送 `Input.insertText`，控制键/快捷键发送 keyDown/keyUp。禁止 document 全局键盘监听
- 状态：`pageMeta`（vw/vh）、`frameCache`、`lastList`
- 提醒条：`maybeShowLoginGuide` / `maybeShowCaptchaGuide`（读 `space.humanCheck`）

---

## 4. bin/ego-cast-worker.mjs — 观察窗 worker

独立 Node 进程，attach 到 agent 浏览器。控制面由 `TargetSessions` 持有，捕获停止时输入、viewport 与 humanCheck 不依赖 screencast session。`CaptureManager` 维护 lease、backend、target 与 generation；CDP/FFmpeg 后端只负责画面生产。JPEG 留在 SSE，fMP4 走独立二进制响应并处理背压。

watch lease TTL 为 120 秒，抵抗浏览器后台定时器节流。host 对 start/switch 使用 30 秒 POST 超时并透传 worker 状态；其他控制请求保持短超时。FFmpeg 能力探针不得使用 `spawnSync`，否则会阻塞 health 并触发 sibling worker 误替换。

CDP 帧必须使用 `params.sessionId` 作为 `Page.screencastFrameAck` 参数，同时使用事件外层 session 作为命令路由 session。不要再次把二者合并。

Windows FFmpeg 后端必须走 `Browser.getWindowForTarget` + Win32 顶层窗口枚举匹配 HWND，再使用 `gfxcapture`。禁止恢复 `gdigrab desktop` fallback：它会在 Chrome 被遮挡时串流用户前台应用。`h264_mf` 的能力探针必须使用真实 D3D11 窗口输入，不能用 `lavfi` 软件帧代替。

**改动需重启 worker**（DSH 的 cast-server 检测到 worker 死后会重启，或手动重启）。
worker 与 lib/index.js 的探针逻辑（humanCheck）是两份相似实现——改动一处要同步另一处，
或后续抽公共文件（当前为规避跨运行时 import 风险保持两份）。

---

## 5. runtime/ — vendored 运行时（只读参照）

`runtime/` 来自 ego-lite（MIT），我们只做了少量本地改动：
- `cursor.mjs`：默认水印 Claude → DeepSeek（品牌）
- `task-spaces.mjs` / `transport.mjs` 等：针对性 bug 修复
- `chrome.mjs`：代理支持

**跟进上游 / 排查时**：每次改 runtime 请在 `runtime/PATCHES.md` 记录「改了什么 + 为什么」，
避免与上游合并时冲突到无从回溯。

---

## 6. 防冲突规范（最重要）
1. **lib/ 是唯一权威**：别建 src/，别 tsc 覆盖。
2. **改 lib/index.js 后记得同步已安装副本**（`~/.dsh/.external-plugins/ego-browser/lib/`）并
   `node --check`。前端/worker 改动需重启 DSH。
3. **加工具走 t() + withEgoLock**，补 help 索引。
4. **跨运行时（前端/worker/工具）的重复逻辑**改动时要同步两份，并标注「改动时同步」。
5. **发版本**：改 `package.json` 版本 → 更新 README 章节 → `git tag vX.Y.Z` branch 打 tag → push。
6. `npm run build` 只做语法校验，不生成/覆盖任何东西。
