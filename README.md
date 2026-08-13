# ego-browser — 看得见的 Agent 浏览器

> **仓库**：`github.com/dsh-external/ego-browser`（私有 · 内测）

> ⚠️ **保密声明**：本项目属于 DeepSeek Harness **内测生态**的一部分，仅限
> dsh-external 组织内测成员使用。**严禁公开、外发、镜像或分发到任何非授权位置**。
> 仓库必须保持 PRIVATE；不发布到 npm / 公共 registry；不创建公开 fork 或镜像。

把 [CitroLabs/ego-lite](https://github.com/CitroLabs/ego-lite)（给 AI Agent 用的 Chromium 浏览器）接入
DeepSeek Harness：以 **13 个结构化 `ego_*` 工具**驱动浏览器，并配一套**实时观察前端口**——
agent 在后台操作网页时，你能像看直播一样看到它正在浏览的每一个页面。

**Linux + Chrome = 开箱即用。** 插件包**内置 ego 运行时**（`runtime/`，来自 MIT 许可的
ego-lite 项目，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）——无需克隆官方仓库、
无需手动构建，连 `--no-sandbox` wrapper 都随包自带，root/Docker/无显示器环境一键跑。

---

## 为什么需要 Agent 浏览器

AI Agent 想真正"在互联网上干活"——查资料、比价、填表、登录、抢票、刷题、处理需要真人会话的站点——
**浏览器是绕不开的入口**。但通用浏览器不是为 agent 设计的，于是诞生了一类**Agent 专用浏览器**
（本项目所基于的 [ego-lite](https://github.com/CitroLabs/ego-lite)、[Browser Use](https://techcrunch.com/2025/03/23/browser-use-the-tool-making-it-easier-for-ai-agents-to-navigate-websites-raises-17m/)、
Perplexity Composer、Manus 等）。它们的官方解释，共同指向几个铁的理由：

### 1. 浏览器是 Agent 唯一能"落地"的真实世界接口
人类绝大多数在线行为都发生在浏览器里。正如 [Perplexity CEO 的观点](https://www.digit.in/features/general/why-perplexity-ceo-aravind-srinivas-sees-ai-browsers-as-key-to-ai-agents.html/amp/)——
**浏览器是 AI 的 killer app，不是对话框也不是 App**：一个能真正操作浏览器的 agent，才等于能在真实互联网上替人办事，而非只停留在文本对话。

### 2. Web 上有纯 API / 纯文本无法绕过的真实交互
登录态、验证码（CAPTCHA）、动态渲染的页面、弹窗、表单、需要真实会话的站点——这些**只有真浏览器才能面对**。
Agent 要处理这些，就必须有一个真实的浏览器在背后渲染、执行、保状态。

### 3. LLM 是文本，但世界是"渲染、点击、状态"
模型本质处理文本，而网页是视觉 + 结构 + 交互状态。需要的正是把网页的**真实画面 / 语义树 / 状态**喂给模型，
再让模型把意图变成**真实的点击与输入**。Agent 浏览器就是这座桥。

### 4. 不打扰主人的登录态，才是能落地的前提
ego-lite 的 slogan 说得很直白：**“让 agent 用你已登录的浏览器，而不打扰你”**，
[官方将其定位为"零成本、零配置"](https://github.com/CitroLabs/ego-lite)、[终结"AI 抢你标签页"问题](https://cloud.tencent.cn/developer/article/2715450?from=15425&frompage=seopage)。
agent 应在**隔离的任务空间**里干活、复用你的登录态，而不是把你的标签页搅得天翻地覆——
这正是"Agent 专用"和"通用浏览器硬塞"的本质差别。

---

**这正是 `ego-browser` 立足的地方**：它把 ego-lite 的"Agent 专用浏览器"接进 DeepSeek Harness，
**并在此基础上解决了通用 Agent 浏览器方案最痛的一点——你看不见它在干什么**。于是有了下方"痛点 → 解法"。

## 为什么需要它（痛点 → 解法）

Agent 浏览器的本质是一个**后台黑盒**：agent 用 `ego_*` 工具在无界面的浏览器里搜索、点击、填表，
跑完了才告诉你结果。如果中途走岔、被验证码卡住、或者你想核对它看到了什么——你毫无办法。

`ego-browser v0.2.0` 的核心优越性，就是把黑盒**打开**：

| 痛点 | ego-browser 给到 |
|------|------------------|
| **看不见** agent 在哪、点了什么 | 🌐 **实时观察浮窗**：小球一点，agent 当前每个标签的实况画面实时播放 |
| 开了太多标签，找不清 | 🟦 **标签页条**：一眼顶上所有打开的标签，点选切换、`×` 一键关闭 |
| 想知道 agent 之前去过哪 | 🕘 **历史抽屉**：回看浏览轨迹，点某条即可查看那页 |
| 页面细节看不清 | 🔍 **缩放/拖拽/复位**：滚轮放大、拖动看细节，缩到底或双击即复位 |
| 画面跟不上操作 | ⚡ **动态刷新**：有操作 2s 快刷、静止 8s 省资源，不空转不卡顿 |
| 环境杂（root/无头/无 `--no-sandbox`） | 🛡️ **环境自适应**：自动探测并兜底，不要求宿主预置任何东西，也不破坏宿主 |
| restart 后什么都要重配 | 📦 **零配置**：插件自携带运行时 + wrapper，clone 即用 |

一句话：**别的方案让 agent 用浏览器，它能让你看见 agent 用浏览器。**

---

## ✨ v0.4.0 跨平台（Windows 适配落地）

- **Windows 原生支持**：`lib/index.js` 新增 `IS_WIN` + `windowsChromeCandidates()`，自动探测
  Chrome / Edge / Brave 的常见安装目录，并在 Windows `PATH` + `%PATHEXT%` 下查找浏览器；不再依赖
  POSIX 专用路径。
- **观察窗服务双兼容**：注入服务从固定的 `httpServer` 调整为 `webServer` / `httpServer` 二选一
  （Web 壳宿主是 `webServer`，其余 Web 宿主是 `httpServer`），`lib/cast-server.js` 内部自动取用
  实际存在的那一个，Windows 上也能挂载实时观察窗。
- **状态路径跨平台**：`cast-server.js` 与 `ego-cast-worker.mjs` 的关键状态目录（`ego-cast.json`、
  `browser.json`）在 Windows 用 `%LOCALAPPDATA%\ego-lite-linux`，POSIX 仍用
  `$XDG_STATE_HOME/ego-lite-linux`，与 ego-lite 运行时保持一致。
- 版本 `0.3.0 → 0.4.0`；对应 `webServer`/`httpServer` 宿主均验证。

---

## ✨ v0.3.0 修复与增强

- **冷启动自动重试**：本插件的每个 `ego_*` 动作都是新起一个 `ego-browser` 子进程去驱动同一个
  Chromium。会话第一次调用时浏览器仍在预热，偶发会报 `CDP channel is not open` / DevTools 超时等
  **瞬时**错误。现已内置最多 3 次、逐步退避的自动重试——仅对这类冷启动瞬时错误重试，真正的错误
  立即透传、绝不被掩盖（`defineEgoTool` 与 `ego_cli` 均已生效）。
- 其余核心能力继承 v0.2.0（实时观察窗 / 标签管理 / 环境自适应 / 登录态持久化）不变。

---

## ✨ v0.2.0 亮点

- **实时观察前端口** `lib/client.js`：深色 Apple 毛玻璃 UI，右下角🌐小球常驻可见，
  点开即见 agent 正在浏览的实时画面。
- **标签管理**：横排标签条 + 每标签 `×` 关闭（走 `/api/ego/close` 真实关掉浏览器标签），
  根治"标签越开越多"。
- **缩放/拖拽/复位**：主画面滚轮放大、按住拖动平移、缩到最小或双击复位；
  操作时网址行就地显示操作提示，2 秒后自动恢复。
- **动态轮询**：`活跃 2s / 静止 8s` 自适应，既不漏新操作也不浪费截图资源。
- **导航复用 tab**：`ego_navigate` 在同一任务内复用当前标签，不再每次新开。
- **worker 重构** `bin/ego-cast-worker.mjs`：attach 到 agent 正在用的浏览器（不另开独立实例），
  CDP 实时推帧；崩溃自动重启，无需 host 干预。
- **开箱即用**：`bin/ego-chrome-wrapper.sh` 随包自带，root/无头自动 `--no-sandbox`。

---

## 前置条件

| 要求 | 说明 |
|---|---|
| Node ≥ 22 | harness 环境自带 |
| **任意 Chrome / Chromium / Brave / Edge** | 自动在 `PATH` 上发现，或通过 `EGO_LINUX_CHROME` 指定；root 下自动用自带 wrapper |
| DSH + dshx | 插件装载机制 |
| 带图形界面的 DSH Web（观察窗） | 前端口需要浏览器页面显示；headless 会话仍可用 `ego_*` 工具 |

## 安装

```sh
# 1. 安装（tarball 或 git URL 均可）
dshx install ego-browser ego-browser-plugin-0.2.0.tgz

# 2. 验证
dshx list                    # 应显示：[on] ego-browser

# 3. 可选配置（~/.dsh/config.yaml，该插件条目下）：
#    egoBin: /path/to/ego-browser       # 默认：插件内置 vendored CLI
#    defaultSpace: dsh-agent            # 动作工具未传 space 时使用的任务空间名
#    maxOutputBytes: 4194304            # 快照/JS 结果的 stdout 收集上限
#    graceMs: 15000                     # 进程树终止宽限（ms）
```

说明：
- 无需宿主侧任何配置：`resolveEgoEnv` 自动探测 root（走自带 wrapper + `--no-sandbox`）、
  无显示器（自动 `headless`）、已设环境变量绝不被覆盖；可用 `EGO_BROWSER_AUTO_ADAPT=0` 关掉自动适配。
- 观察窗 host 路由自动注册（`/api/ego/spaces`、`/api/ego/close`…），仅在有 HTTP server 时启用，headless 是安全的 no-op。

## 工具清单（13 个，前缀 ego_）

| 工具 | 作用 |
|---|---|
| `ego_status` | 探测 ego-browser CLI 是否可用（实际运行 `--status`） |
| `ego_space_open` | 打开/复用任务空间（隔离浏览上下文，继承登录态），返回空间 id |
| `ego_space_close` | 完成/关闭任务空间（`keep: true` 保留页面给用户） |
| `ego_snapshot` | 当前页面语义树文本（带 `[ref=N, loc=...]` 选择器，供 click/fill 定位） |
| `ego_navigate` | 打开 URL 或切到已有 tab，等待加载，返回页面信息（**同任务复用当前 tab**） |
| `ego_click` | 点击：CSS/xpath/loc/ref 选择器或视口坐标 |
| `ego_fill` | 向输入框键入文本 |
| `ego_js` | 在页面内求值 JS 表达式，返回可 JSON 序列化的结果 |
| `ego_cdp` | 原始 CDP 命令（如 `Page.handleJavaScriptDialog`） |
| `ego_screenshot` | 截图，返回 PNG 文件路径（可交给 vision 工具看图） |
| `ego_page_info` | 当前页 url/title/视口/滚动位置，或原生对话框状态 |
| `ego_wait` | 固定毫秒等待 |
| `ego_cli` | 逃生舱：原样运行任意 `ego-browser nodejs` heredoc 脚本 |

## 观察窗（v0.2.0 前端口）怎么用

右下角 **🌐 常驻小球** → 点开：

- **主画面**（大图）：显示 agent 当前正在浏览的页面实况；滚轮缩放、按住拖动、缩到底或双击复位。
- **标签页条**（顶部横排）：列出 agent 所有打开的标签，点选切换查看，每标签 `×` 关闭。
- **历史抽屉**（🕘）：按时间回看浏览轨迹，点某条即在该位置查看。
- **刷新**（⟳）：手动刷新实时画面（图标转圈表示刷新中）。
- 操作时，主画面下方的网址行会**就地显示操作提示**，2 秒后恢复。

> 登录态说明：观察窗显示的是 agent 正在操作的浏览器实况；多任务空间之间 Cookie 相互隔离
> （ego 设计如此），登录请在对应任务空间内进行。重启 DSH 后运行期登录态会被清空
> （Chrome 运行期 Cookie 仅在优雅关闭时落盘），需重新登录——扫码即可，很快。

## 工作原理

- **工具层**：每个工具把参数拼成一段 JS 脚本，通过 `ctx.subprocess` 以 `ego-browser nodejs` 喂给
  stdin 运行；内置宿主用 CDP 驱动普通 Chrome。结果经 `console.log('@@DSH_RESULT@@' + JSON.stringify(payload))`
  哨兵行解析。所有 `ego_*` 经**进程内互斥锁串行化**（共享同一常驻浏览器），错误统一归一化为明确信息。
- **观察窗**（三层，各自职责）：
  - `client.js`（前端）：GitHub 浮球 + 标签条 + 历史抽屉，轮询 `/api/ego/spaces`。
  - `cast-server.js`（host）：把前端路由转发到本地 worker，懒启动、崩溃自动重启。
  - `ego-cast-worker.mjs`（worker）：attach 到 **agent 正在用**的浏览器（读其 CDP 端点），
    对每个页面推实时截图帧；提供关闭标签 `/api/close`。worker 只读/见控，绝不动宿主环境。

## 开发

```sh
# 构建（lib/）
<dsh-checkout>/node_modules/.bin/tsc -p tsconfig.json

# 核心测试：
#   smoke        — 插件注册 + 错误路径（假 CLI，必过）
#   real-test    — 真浏览器基础流（example.com）
#   verify-real  — 交互闭环 + arXiv 文献检索（宿主偶发不稳定，可重试）
```

`node_modules/` 只含指向 DSH checkout 的符号链接（编译期类型解析用）；
运行时由 harness 装载器解析 `@deepseek-ai/dsh-tools`。

## 已知限制（诚实说明）

- **Windows**：插件层面（Chrome 探测、状态路径、观察窗服务）已做 v0.4.0 跨平台适配。底层
  ego-lite 宿主仍是非 Windows 官方支持的社区移植，Windows 下复杂多步流程的宿主稳定性可能略
  弱于 macOS。

- **快照质量**：Linux 宿主用 CDP `DOMSnapshot.captureSnapshot` 重建语义树（refs 忠实、内容可读），
  但非 macOS 内核级快照，复杂 iframe/画布场景可能降级。
- **官方支持状态**：Linux 是未合并的社区 PR（#234）；macOS 仍是官方唯一支持平台。
- **宿主可靠性（Linux）**：未合并的宿主在跨 CLI 调用间可能丢失 tab/空间状态（空白 tab、偶发 EPIPE）。
  插件已内置防御（`ensureRealTab`、快照重试、EPIPE 容错）；简单流程稳定，复杂多步流程可能需要重试。
- **登录态持久化**：Chrome 运行期 Cookie 仅在优雅关闭时落盘，DSH 强杀重启会导致运行期登录丢失
  （需重登）。这是 Chrome 内核行为，插件无法在运行期强制落盘。
- **输出 schema** 为宽松的 `additionalProperties: true` 结构，客户端渲染以实际返回值为准。

## 许可与署名

插件本体为 MIT。内置运行时嵌入 [CitroLabs/ego-lite](https://github.com/CitroLabs/ego-lite)
的 MIT 代码（含 [PR #234](https://github.com/citrolabs/ego-lite/pull/234) 的 Linux 移植）以及
一处本地代理补丁——详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
