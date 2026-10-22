# ego-browser — 看得见的 Agent 浏览器

<p align="center">
  <a href="https://dshfind.com/zh/plugins/Fisfzy/ego-browser?ref=badge"><img src="https://dshfind.com/api/badge/Fisfzy/ego-browser?lang=zh" alt="dshfind - ego-browser"></a>
  <a href="https://dshfind.com/zh/plugins/Fisfzy/ego-browser"><img src="https://dshfind.com/api/card/Fisfzy/ego-browser?lang=zh" alt="ego-browser card"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/DSH-%3E%3D0.1.2--rc.1-blue" alt="DSH >= 0.1.2-rc.1">
  <img src="https://img.shields.io/badge/DSH--better--sidebar-%3E%3D0.12.2(optional)-red" alt="dsh-better-sidebar >= 0.12.2 (optional)">
  <img src="https://img.shields.io/badge/Node-%3E%3D22-brightgreen?logo=node.js&logoColor=white" alt="Node >= 22">
  <a href="https://www.npmjs.com/package/dsh-ego-browser"><img src="https://img.shields.io/npm/v/dsh-ego-browser?logo=npm" alt="npm version"></a>
  <a href="https://github.com/Fisfzy/dsh-ego-browser/releases"><img src="https://img.shields.io/github/v/release/Fisfzy/dsh-ego-browser" alt="GitHub release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="license MIT"></a>
</p>

> **仓库**：`github.com/Fisfzy/dsh-ego-browser`｜当前版本 **v0.9.0**｜版本历史见 [CHANGELOG.md](CHANGELOG.md)｜详情页：[dshfind](https://dshfind.com/zh/plugins/Fisfzy/ego-browser)

### 版本兼容矩阵

| 依赖 | 最低版本 | 推荐版本 | 说明 |
|---|---|---|---|
| **DSH** (DeepSeek Harness) | `0.1.2-rc.1` | `≥ 0.1.2-rc.1`（v0.8.6 起适配 0.1.7 settings；v0.8.8 起支持 0.2.1 原生右侧边栏，截至 0.2.1 验证通过） | `engines.dsh` 声明地板；peer 依赖同步锁定 `>=0.1.2-rc.1`。0.1.0-rc.x / 0.1.1-rc.x 请使用 v0.8.0 及更早版本 |
| **dsh-better-sidebar** | `0.12.2`（可选） | `≥ 0.17.1` | 未安装时自动回退浮动观察球；`< 0.12.2` 可运行但外部链接拦截（`urlTarget`）静默降级 |
| **dsh-TUI**（可选） | — | 提供 `tuiSettingsSections` / `tuiStatus` / `tuiToast` / `tuiPanels` 的版本 | 按服务能力启用设置页、底栏状态、通知、侧栏面板与缩略图；缺席时静默跳过，无额外 I/O |
| **Node.js** | `22` | — | harness 环境自带 |

**DSH 全版本适配说明**：v0.9.0 已在 DSH `0.1.2-rc.1` 至 `0.1.7`（含 0.2.0-rc.x / 0.2.1-rc.2 桌面端的 0.1.7 settings 路径 + 原生右侧边栏）上验证；核心 API（`defineTool`、`ctx.tools.register`、`ctx.subprocess.spawn`、`ctx.webServer.register`、`ctx.inject`、`ModuleLoader` CJS factory、`cordis.patch.yml`）在 v0.1.0-rc.7 → v0.2.1 无破坏性变更。0.1.2-alpha.x 系列按声明可装但未实测。

**dsh-better-sidebar 适配说明**：ego-browser 通过 `ctx.betterSidebar` 服务（try-catch 防御性获取）注册侧边栏 Tab 并监听外部链接。关键 API 引入版本：

| API | ego-browser 用法 | better-sidebar 引入版本 |
|---|---|---|
| `registerTab()` / `openTab()` / `ctx.betterSidebar` | Tab 注册 + 打开 | v0.9.0+ |
| `TabDescriptor.single` | 单实例 Tab | v0.9.0+ |
| `TabDescriptor.urlTarget` | 外部链接拦截 | **v0.12.2+**（低于此版本链接拦截静默失效） |

---

**DSH 版本支持详情**：v0.8.2 → v0.8.3 主要变更：合并 6 个社区 PR（root/xvfb/macOS headless 适配、rc.1 兼容、Windows 稳定性），修复无认证 `/api/ego/*` 路由安全漏洞、无 dsh-better-sidebar 宿主 client 启动失败（#29）、Windows 冷启动回归（#22 引入的 Xvfb 误判），并修复 gateway 设置白名单缺 `egoCliArgs`/`chromeArgs`。适配点：client 运行时改名（`@deepseek-ai/dsh-client-store`）、client 模块注册 id 与装载行名按声明包名、`dsh.client.inject` 仅声明真实模块图行、`webServer` 以嵌套注入交付（可选服务），并同步侧边栏 Tab（dsh-better-sidebar）模式。

**侧边栏支持**：v0.8.8 起优先注册进 **DSH 原生右侧边栏**（`@deepseek-ai/dsh-client-ui-sidebar-right`，DSH ≥ 0.2.1 桌面端自带）——「Agent 浏览器」出现在侧边栏「+」的新标签页列表里（带自绘图标），点击打开并随侧边栏抽屉固定展示；agent 首次调用 `ego_*` 工具时自动打开该 Tab（按调用会话作用域，多会话不会弹错位置）。宿主没有原生右侧边栏时，回退到 [dsh-better-sidebar](https://www.npmjs.com/package/dsh-better-sidebar)（推荐 ≥ v0.12.2）的原生 Tab；两者都没有时回退为右下角**浮动观察球**（`#dsh-ego-fab`）。三种形态共用同一套 SSE 实时推流 / 点击 / 输入 / 下载捕获能力。观察窗还提供一个「弹出窗口」按钮：无头（headless）运行的 agent 浏览器可一键替换为同 Profile 的有头窗口（标签页保留），方便手动接管。

**登录态导入（v0.8.5 新增；v0.8.7 起定向禁用；v0.8.8 起仅危险环境拒绝）**：设置页「从系统浏览器导入登录态」或工具 `ego_login_import`，把你日常 Chrome/Edge/Brave 里的登录 cookie **按域名**复制进 agent 浏览器（真实二进制无头启动 + CDP 透传读取，兼容 Chrome 127+ 的 App-Bound Encryption，不做离线解密；源浏览器运行中可选择优雅关闭后导入，窗口下次启动自动恢复）。cookie 值不出现在任何日志与输出中；导入前自动备份源 cookie 库，异常清空自动还原。配合默认的磁盘持久化 Profile，导入的登录态跨重启永久保留。

> ⚠️ **仅 Windows + Chrome ≥ 155 会被拒绝**：该组合上 junction 别名 + 无头启动 + 强杀路径读到 0 条 cookie，且被观测到会清空源 profile 的扩展注册表并重置默认搜索引擎（详见 [#69](https://github.com/Fisfzy/dsh-ego-browser/issues/69)）。Linux / macOS / 旧版 Chrome 正常可用；确认环境不受影响后，可设 `EGO_LINUX_LOGIN_IMPORT_FORCE=1` 在任何环境放行。彻底修复仍在跟踪中。

**常驻执行器（v0.8.8，可选，默认关闭）**：设置页「常驻执行进程」开启后，`ego_*` 调用复用同一个 `ego-browser --serve` 进程——首次调用支付启动开销，之后每次 **~1–2 ms**（一次性 spawn 基准 ~340 ms）。浏览器被空闲回收或崩溃后，下一次调用自动回退到一次性 spawn 并重新拉起浏览器（带启动重试），随后恢复常驻；**已经写出的请求不会重试**，避免重复点击/填表。空闲停止时间可配（默认 30 分钟）。

把 [CitroLabs/ego-lite](https://github.com/CitroLabs/ego-lite)（给 AI Agent 用的 Chromium）接入 DeepSeek Harness：以 **33 个结构化 `ego_*` 工具**驱动浏览器，并配一套**实时观察前端口**——agent 后台操作网页时，你能像看直播一样看到它正在浏览的每个页面，还能直接操作它。

**一点私藏的独特之处（self-observation）**：agent 用的就是这一个 Chromium——连它操作 **DSH 自身**（管理会话、任务看板、调设置）时，观察窗也实时显示、你能随时接手。不只是"看得见 agent 在网页上干活"，连 agent 操作 DSH 界面本身都是全程可见、可掌控的。

**开箱即用**：插件包内置 ego 运行时（`runtime/`，MIT，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）——无需克隆官方仓库、无需手动构建，`--no-sandbox` wrapper 随包自带，root / Docker / 无显示器一键跑。

---

## 🚀 快速启动

```sh
# 安装（任选一种；桌面端也可以走 插件 → 添加插件）
dsh plugin --profile desktop add dsh-ego-browser@0.9.0
```

1. 在 DSH 会话里说一句让 agent 用浏览器的话，例如：
   > 打开 https://example.com ，截图并告诉我页面标题
2. agent 第一次调用 `ego_*` 时，右侧边栏的「Agent 浏览器」标签会自动出现（没有原生侧边栏时回退到 `dsh-better-sidebar`，再没有就是右下角浮动球），实时显示它正在操作的页面。
3. 想接手时，直接在观察窗里点击 / 输入 / 滚动；需要完整浏览器窗口就点面板上的「弹出窗口」。

> 宿主侧无需配置：Chrome/Edge/Brave 自动探测，root / 无头自动兜底。第一次启动约 2–4 秒。如果观察窗没出现，先跑一次 `ego_doctor` 看环境；更换浏览器路径后需要让 agent 浏览器冷启动才生效（见「已知限制」）。

---

## 我们的真正优势（不是口号，是能对照代码和竞品核实的能力）

同样把 ego-lite 接进 DSH，市面上已有同类插件用它**只做了 3 个工具**——一个 `run` 脚本、一个 `help` 指南、一个 `status` 体检，浏览器仍是**后台黑盒**。`ego-browser` 走的是另一条路：**把黑盒打开，并且一上来就把"看"和"控"的能力做到位**。

| 能力 | ego-browser（本仓库） | 同类插件（Da1dr1em/dsh-ego-browser） |
|---|---|---|
| 结构化工具数 | **33 个**，职责单一、可确定性调用 | **3 个**（`run`/`help`/`status`） |
| 实时观察窗（CDP JPEG / FFmpeg H.264 双后端 + 标签条 + 历史抽屉） | ✅ 有 | ❌ 无 |
| 监控窗鼠标**直接操作**真实浏览器（点击/拖拽/滚动回传 CDP） | ✅ 有 | ❌ 无 |
| worker 单实例守卫 + 崩溃/重复自愈 | ✅ 有 | ❌ 无 |
| 下载捕获 `ego_download` / 人机验证检测 `ego_captcha`/`ego_page_info` | ✅ 有 | ❌ 无 |
| 平台自适应（Linux/Windows 自动探测 + root/无头/`--no-sandbox` 兜底；macOS 需手动配置，见「已知限制」） | ✅ Linux/Windows 开箱用；macOS 部分支持 | 仅 Windows 预览宿主，需手动配 |
| 登录态落盘持久化 `ego_auth_flush` | ✅ 有 | ⚠️ 仅文档级说明 |

**关键差异两条：**
- **看得到**：别家是"跑完告诉你结果"的黑盒；我们实时推流，你**看着 agent 操作**，卡在验证码/走岔立刻发现。
- **控得住**：别家只读；我们监控窗**直接驱动**同一个 agent 浏览器，需要时你亲手接管（缩放/拖拽/点击），不必打断 agent 重来。

> 以上对比基于公开可见的可核实事实：本仓库代码（`bin/ego-cast-worker.mjs` 实时推流 + CDP 输入回传、`lib/index.js` 33 个注册工具、`src/cast-server.ts`（构建进 `lib/index.js`）host 桥接）与同类插件的源码/README。此文档不含对任何他人的贬低——我们只陈述自己多实现并验证了哪些能力。

**相对 [ego-lite](https://github.com/CitroLabs/ego-lite) 本体，我们多做了这些（都可对照本仓库代码核实）：**

| 能力 | 说明（对应代码） |
|---|---|
| **观察窗前端口** | ego-lite 本体是无头 CLI（只有 heredoc 脚本 + 文本输出）；我们在其上加了 **SSE 实时推流 + 标签条 + 历史抽屉 + 监控窗鼠标直操**（`bin/ego-cast-worker.mjs`、`src/cast-server.ts`（构建进 `lib/index.js`）、`lib/client.js`），让"看"和"控"成为一等能力 |
| **开箱即用 + 跨平台自足** | `resolveEgoEnv` 自动探测 Chrome/Edge/Brave，内置 `--no-sandbox` wrapper，root / Docker / 无显示器免配置（`lib/index.js`）；不必像官方那样先装一个 GUI 宿主 |
| **健壮性层** | 冷启动自动重试（只重试 CDP 瞬态，不吞真错）、worker 单实例守卫 + 崩溃自动重启、插件卸载 fire-and-forget 不阻塞宿主退出、前端帧缓存上限（`withWarmupRetry` / `makeEnsureWorker` / `frameCache`） |
| **运维型工具** | `ego_doctor`（环境体检）、`ego_captcha`（人机验证探测）、`ego_auth_flush`（登录落盘）、`ego_login_import`（系统浏览器登录态导入）、`ego_http`（浏览器上下文请求）等，是原生 CLI helper 没有的一层 |
| **self-observation** | agent 操作 DSH 自身界面时同样实时可见、可接手 |

> 我们不声称媲美官方 macOS App 的内核级快照或原生多窗口体验；本仓库解决的是"把同一套浏览器能力带进 DSH + Linux/WSL + 看得见"这件事。

---

## 它解决什么问题

通用浏览器不是为 agent 设计的，而 Web 上大量交互（登录态、验证码、动态渲染、表单、需真人会话的站点）只有真浏览器能面对——这正是 ego 系 **"让 agent 用你已登录的浏览器，而不打扰你"**（[官网](https://github.com/CitroLabs/ego-lite)）的由来。

`ego-browser` 把它接进 DSH，并把最痛的一点——**你看不见 agent 在干什么、也插不上手**——用一套观察窗解决：

> 🌐 小球一点看直播；🟦 标签条切换/关闭；🕘 历史抽屉回看；🔍 缩放拖拽；🖱️ 监控窗直接接管真实浏览器。**一句话：让 agent 在浏览器里干活，你在旁边既看得见、又随时能接手。**

### 几个常见的上手场景

- **文献 / 数据抓取**：让 agent 登录知网 / 谷歌学术翻页收集，你在观察窗看着它滚动、点下一页、下载 PDF，中途卡住立刻能发现。
- **表单与登录**：agent 填表到一半，观察窗弹出验证码——你直接接管把验证码点了，再交还给 agent 继续。
- **QA / 冒烟测试**：让 agent 在自己产品上点一圈，观察窗等于一台"会说话的录屏"，顺手还能回看历史轨迹。
- **看 agent 操作 DSH 自身**（self-observation）：agent 在管理会话 / 调设置时，观察窗同样全程可见、可接手。

---

## ✨ 近期亮点

- **v0.9.0**：**dsh-TUI 支持**——在 dsh-TUI 宿主中可选注册 Agent Browser 设置页、工具活动状态栏与有限通知；右侧栏面板展示浏览器状态、按任务空间分组的标签、人机验证提示与最近动作，并支持键盘操作（选标签、弹出真实窗口、关标签、落盘登录态、刷新）；选中标签时通过 worker 的独立截图端点显示页面缩略图与捕获状态（不占用工具锁、不启动直播订阅，终端无图形协议时回退文字）。所有 TUI 服务缺席时静默降级，Web/桌面端行为不变。合并社区 PR #74/#75/#76（ccch1mneyyy）。
- **v0.8.8**：**原生右侧边栏**——观察窗优先注册进 DSH 自带的右侧边栏（`sidebar.right.pane.tab` + guide 入口 + 自绘图标），`dsh-better-sidebar` 与浮动球依次回退；服务晚于插件就绪时用 `ctx.inject` 等待。**常驻执行器（可选）**——`ego_*` 调用复用同一个 `ego-browser --serve` 进程，首次启动后每次 ~1–2 ms（一次性 spawn 约 340 ms）；浏览器被停/崩溃后自动回退一次性 spawn 恢复，再回到常驻；已写出的请求不重试。**稳定性**——`reconcile()` 清扫不属于任何 space 的孤儿标签（#67），冷启动不再堆积标签；Windows 上浏览器启动失败不再空等 Xvfb。**登录导入**——`ego_login_import` 从"全禁"改为仅 Windows + Chrome ≥155 拒绝（#69）。
- **v0.8.7**：**工具语义修复**——`ego_wait_for_url` 先比对当前 URL 再等未来导航（带 `matchedCurrent`）、`ego_wait_for_response` 超时不再抛错、`ego_dialog` 失败时给出可执行提示、`ego_script`/`ego_cli` 文档写明 `@@DSH_RESULT@@` 哨兵并支持最后一行 JSON 兜底。**Windows 稳定性**——`clearProfileLock()` 在 win32 上真正清理孤儿 Chrome（此前是永久 no-op，一次非优雅退出会让 agent 浏览器再也打不开）。**安全**——`ego_login_import` 默认禁用（fail-closed，`EGO_LINUX_LOGIN_IMPORT_FORCE=1` 才放行）。**回收器**——`--stop` 后清理 `Default/Sessions/`，冷启动不再静默复活旧标签。**观感**——光标箭头与手形不再重叠；CDP 预览默认宽度 960 → 1280。合并 PR #63（`--serve` 常驻传输，默认仍走 spawn 路径）。
- **v0.8.6**：登录态导入安全加固（#61 不再可能损坏源 cookie 库）、人机验证误报修复（#62，loopback 不探测、要求挑战短语）、DSH 0.1.7 设置页适配（插件页行配置 + `settings/document-updated` 订阅）。
- **v0.8.0**：**侧边栏 Tab 集成**——当 `dsh-better-sidebar` 可用时，实时查看窗注册为侧边栏原生 Tab（而非浮动浮窗），`ego_browser` 工具首次调用自动展开；内置 `EgoBrowserTab` React 组件 + `LivePreviewController` 实时帧管道。`dsh-better-sidebar` **不是 peer 依赖**（`ctx.get()` 机会性消费），没装就退回浮动浮窗，两种部署都干净。
- **v0.7.0**：观察窗状态灯**干活常绿、空闲呼吸**；`ego_script` 每次运行超时 `timeoutMs` 真正生效；前端 `frameCache`/`pageMeta` 按标签清理 + 上限兜底，杜绝长会话内存增长；状态路径家目录回退改 `os.homedir()` 跨平台化；新增 `.gitattributes` 统一 LF 换行。
- **v0.6.1**：卸载不再阻塞宿主退出（自愈链路稳定）；观察窗 worker **单实例守卫** + stale 状态清理；登录/人机验证引导条可关闭且互斥；**观察窗主动跟随 agent 正在操作的页面**（不再被后台重绘页抢占视图）。
- **v0.6.0**：工程收敛——`lib/` 定为唯一源，`build` 改语法校验，杜绝"一构建全回归"。（TS 重构后源码移至 `src/`，`lib/` 为构建产物，见「开发」一节。）
- **v0.5.0**：实时 SSE 推流 + 监控窗直接操作 agent 浏览器。
- **v0.4.0**：Windows 适配。
- 完整历史见 [CHANGELOG.md](CHANGELOG.md)。

---

## 前置条件

| 要求 | 说明 |
|---|---|
| Node ≥ 22 | harness 环境自带 |
| **任意 Chrome / Chromium / Brave / Edge** | 自动发现，或 `EGO_LINUX_CHROME` 指定；root 下用自带 wrapper |
| DSH（插件装载） | 插件页添加，或 `dsh plugin --profile <profile> add dsh-ego-browser`；npm 包名 `dsh-ego-browser` |
| 带图形界面的 DSH Web（观察窗） | headless 会话仍可用 `ego_*` 工具，仅无观察窗 |

## 安装

**方式 A：桌面端插件页**：插件 → 添加插件 → 搜索 `dsh-ego-browser`。

**方式 B：命令行（npm，推荐）**：

```sh
dsh plugin --profile <profile> add dsh-ego-browser@0.9.0
dsh plugin --profile <profile> list                 # 应看到 dsh-ego-browser
# 升级
dsh plugin --profile <profile> add dsh-ego-browser@latest
```

**方式 C：git / tarball**（离线或固定提交）：

```sh
dsh plugin --profile <profile> add https://github.com/Fisfzy/dsh-ego-browser.git
dsh plugin --profile <profile> add ./dsh-ego-browser-0.9.0.tgz
```

> **从旧版本升级（DSH Desktop 2.0.5+）**：本插件包名是 **`dsh-ego-browser`**（非 `@dsh-external/ego-browser`）。DSH Desktop 2.0.5 起增加了「profile 依赖名 == 包实际 name」的一致性校验，若 profile 仍用旧名 `@dsh-external/ego-browser` 引用，启动会挂进恢复模式（`profile package identity is invalid for @dsh-external/ego-browser`）。升级到 2.0.5 后请把 profile 的 `package.json` 依赖键 **和** `dsh.profile.bundles` 条目**两处**都改为 `dsh-ego-browser`：

   ```diff
   - "@dsh-external/ego-browser": "git+https://github.com/Fisfzy/ego-browser.git",
   + "dsh-ego-browser": "git+https://github.com/Fisfzy/dsh-ego-browser.git",
   ```

   ```diff
   - "@dsh-external/ego-browser",
   + "dsh-ego-browser",
   ```

观察窗设置中可选 `captureBackend=auto|cdp|ffmpeg`（默认 `auto`，当前解析为 CDP）、画质档位、CDP FPS/JPEG 质量/最大宽度，以及 FFmpeg FPS/最大宽度/码率/编码器/自定义路径。插件先检测自定义路径、系统 PATH 和托管缓存；检测到兼容 FFmpeg 前，设置页禁止选择 FFmpeg，并提供固定版本的一键下载。GitHub 下载可用 `githubMirror` 替换 `https://github.com`，例如 `https://gh-proxy.com/github.com`。FFmpeg 码率范围为 500-20000 kbps，低/平衡/高档默认 2000/4000/8000 kbps。

其他开关：`isolateSpaces`（任务空间沙盒隔离，默认关）、`idleTimeoutMin`（空闲 N 分钟后自动回收后台浏览器，默认 0=关）、`disableFrameRelay`（**禁用画面回传**，默认关）。

**禁用画面回传（`disableFrameRelay`）**：开启后插件不再回传任何画面——不启动 ego-cast worker（因此不会做 CDP/WGC 屏幕采集、不会 ffmpeg 拉流与 fMP4 封装），`/api/ego/stream`、`/api/ego/video` 及 worker 相关路由改为返回 `{"ok":false,"reason":"frame relay disabled"}`，观察窗不再建立任何拉流连接并显示禁用态提示。`ego_*` 工具本身完全不受影响（浏览器照常开，快照/点击/输入/截图照常工作）。开关是配置项，保存后立即生效：正在跑的 worker 会被停掉，重新开启后自动恢复。

无需宿主侧任何配置：`resolveEgoEnv` 自动探测 root / 无显示器并兜底。观察窗 host 路由（`/api/ego/spaces` 等）仅在有 HTTP server 时注册，headless 是安全 no-op。

## 在 dsh-TUI 中

提供可选 `tuiSettingsSections`、`tuiStatus`、`tuiToast` 服务的 DSH TUI 宿主会按能力启用以下功能：

- **设置页**：`Agent Browser / Agent 浏览器` 页面实际注册九项设置：空间隔离、空闲回收分钟数、常驻执行器、常驻空闲分钟数、浏览器路径、采集后端、画质预设、FFmpeg 路径和默认关闭的面板自动打开开关。字段标签与说明提供中英文；画质值为 `low / balanced / high`，与运行时配置一致。配置保存与校验仍由宿主设置服务负责。
- **状态栏**：在 `right-head` 显示 `◎ ego_click` 等当前工具，空闲时显示 `◎ idle`，最多占 24 个终端单元。详情包含当前动作和最近错误；动作定位摘要按终端显示宽度截断。执行计时从取得已有浏览器锁后开始；独立工具也记录开始与完成。
- **精简通知**：在确认空闲回收实际停止了浏览器、浏览器冷启动重试最终失败，或侧栏首次检测到人机验证时显示 toast。每次插件激活最多每分钟 20 条；普通工具成功、普通页面错误不会弹通知。

工具卡标题在 Web 与 TUI 共用：例如 `ego_navigate · github.com/foo`、`ego_fill · #email`。摘要只读取允许的定位字段，不显示填入文本、键盘输入、HTTP 请求头或请求体、JS/script/CLI 源码；URL 去掉用户名、密码、查询串及 fragment，终端控制序列被清理。动作历史在内存中保留最近十项，不写入文件。

这些服务各自可选并独立注入。缺席服务的对应功能静默跳过；所有 TUI 服务都缺席时不会因 TUI 集成新增文件读取、轮询或 worker 启动。卸载时清理状态订阅与注册项；不声明未实现的 Scene，也不自动打开浏览器窗口。已有 Web 观察窗、侧边栏及其启动逻辑保持原样。

离线验证覆盖类型、行为测试与构建；真实 DSH TUI 视觉效果及 Chrome 人工接管仍需在安装环境验证。

### 浏览器侧栏面板

提供 `tuiPanels` 的宿主会注册 **◎ Agent Browser** 面板（最窄 28 列）。它展示浏览器运行/无头状态、活动页标题与 URL、标签列表、人机验证提示，以及最近最多 5 次工具调用的结果与耗时。浏览器状态是**所有会话共享的全局状态**；现有 worker 提供平铺标签；面板只读同目录的 `task-spaces.json`，按持久化 `targetIds` 与实时标签精确匹配到真实空间名称。未归属标签列在 `Unassigned / global`；元数据缺失、损坏或没有匹配时使用 `Global/default group`，不按 URL 猜测、不调用有清理副作用的空间协调方法。长 URL、中文标题、组合字符按终端显示宽度截断。

面板有焦点时：`↑/↓` 选择标签，`o` 通过现有入口打开浏览器窗口接管，`x` 关闭所选标签，`f` 刷新落盘 cookies，`r` 立即刷新状态。关闭标签优先使用宿主确认对话框；宿主未提供对话框时，需要连续按两次 `x`，选择变化或其他按键会取消待确认状态。分屏操作不依赖鼠标事件。

默认首次 `ego_*` 调用只增加提示角标，**不会自动打开面板**。设置 `tuiAutoOpenPanel=true` 可选择自动打开；面板打开请求至少间隔 5 秒。人机验证首次出现时增加 warning 角标并显示按 `o` 接管的通知，底栏状态变为 warning，点击可打开面板；持续验证不会重复通知。下载完成通知暂未实现，因为当前 worker 没有下载事件数据。

面板可见时约每 2 秒读取状态，隐藏或卸载立即停止定时轮询；工具完成可触发一次刷新。`disableFrameRelay=true` 时不读取浏览器进程状态、不启动 worker，也不请求标签；面板仍显示工具活动及禁用原因。无 `tuiPanels` 服务时不创建面板控制器或新增轮询。宿主 React 通过面板 props 提供，插件宿主包不引入 React 运行时。真实 DSH TUI 和 Chrome 的显示、窗口接管仍需在目标环境验证。

### 页面缩略图

worker 的状态响应包含 `capture` 时，面板另显示一行捕获后端、状态和可选状态码；它来自已有状态刷新，不额外轮询或启动直播，禁用回传或浏览器停止后清除。

有足够面板高度时，顶部通过宿主 `ui.Image` 展示所选标签的单帧预览。选择标签、可见面板内工具执行结束以及按 `r` 会刷新一次；没有持续截图计时器，不实现可选的 `l` 实时模式，面板隐藏时不会发起截图。正在进行的请求在面板隐藏、选择变化或卸载后不会更新旧预览。`disableFrameRelay=true` 时不启动截图工作。

截图由 worker 的 `/api/snapshot?targetId=…&maxWidth=…` 通过既有 CDP 控制会话产生 PNG，不调用 `ego_screenshot`、不进入工具互斥锁、不启动直播订阅。缩略图按面板列数乘以常规 8 像素的单元宽度请求，并由宿主按终端列/行渲染；PNG 解码得到的 `source.width/height` 保留真实像素维度，`Image.width/height` 是终端单元数。每帧独立分配 RGBA 字节缓冲区，不原地改写已经交给宿主的图像。

图像使用 `presentation: 'preview'`，可由宿主选择 Kitty 或 Sixel；不支持图形的终端、截图不可用或 PNG 解码失败时显示 `alt` 和子文本后备内容，标签列表与快捷键仍可使用。这里只验证了像素解码、刷新生命周期和宿主组件参数；尚未在真实终端图形协议或真实 DSH/Chrome 环境验证观感。

### In dsh-TUI (English)

Each integration is enabled only when its optional host service is available. `tuiSettingsSections` registers the bilingual Agent Browser page with the eight existing browser/capture settings and the default-off `tuiAutoOpenPanel` setting. `tuiStatus` shows the current tool or idle state in a 24-cell footer field, with action/error detail. `tuiToast` reports confirmed idle shutdown, final cold-start failure and newly detected human verification, with a shared limit of twenty notices per minute. Tool-card titles expose only short, sanitized locator summaries; input values, request headers/bodies and executable source are excluded.

`tuiPanels` adds the **◎ Agent Browser** panel, using the host's React and UI components. The browser is global across sessions. The panel shows running/headless state, the active page, real task-space groups joined by persisted target ids, verification warnings and recent action results. Missing membership metadata falls back to an explicitly labeled global group; unassigned tabs remain visible. With focus, use `↑/↓` to select a tab, `o` to open the existing browser takeover window, `x` to close the selected tab, `f` to flush cookies, and `r` to refresh. `tuiDialogs` provides close confirmation when present; otherwise press `x` twice consecutively. The first browser-tool call adds a badge without opening the panel unless auto-open is explicitly enabled.

Metadata polling runs about every two seconds only while the panel is visible; tool completion may request one refresh while hidden. When there is enough vertical space, a selected-page thumbnail refreshes on visible selection changes, tool completion and `r`. It uses a one-shot worker PNG capture through the existing CDP session, independent of the tool execution lock. Fresh RGBA pixels are passed to `ui.Image` with terminal-cell dimensions, `presentation: 'preview'`, alt text and a text fallback. No continuous screenshot mode is enabled. Pixel width is estimated from columns using an eight-pixel cell; the host handles terminal graphics rendering.

`disableFrameRelay` suppresses TUI browser/membership reads, worker startup and screenshot requests while retaining tool activity and an explanation. Missing services silently omit their contributions; if all TUI services are absent, this integration adds no I/O or polling. Hide/unmount and plugin teardown release the relevant timers and subscriptions. The existing web/desktop watch routes and worker policy are unchanged; shared safe tool-card titles apply to both surfaces. Real DSH/dsh-TUI, Chrome takeover and Kitty/Sixel rendering still require verification on the target installation.

When the existing metadata response includes `capture`, the panel displays its backend, state and optional code in one line. This uses the same metadata refresh and starts no additional request or live stream; disabled relay or a stopped browser clears the row.

## 工具清单（33 个，前缀 `ego_`，完整索引见 `ego_help`）

| 类别 | 工具 |
|---|---|
| 任务空间 | `ego_space_open` `ego_space_close` `ego_status` |
| 页面读取 | `ego_snapshot`（语义树） `ego_page_info` `ego_read_element` |
| 导航/等待 | `ego_navigate`（复用 tab） `ego_wait` `ego_wait_for_selector` `ego_wait_for_url` `ego_wait_for_response` |
| 交互 | `ego_click` `ego_fill` `ego_hover` `ego_drag` `ego_select` `ego_check` `ego_key` `ego_scroll` |
| 执行/调试 | `ego_js`（页面求值） `ego_cdp`（原始 CDP） `ego_cli`（任意 heredoc） `ego_script`（多步脚本） |
| 输出 | `ego_screenshot` `ego_download` `ego_upload` |
| 会话/安全 | `ego_auth_flush`（登录落盘） `ego_login_import`（系统浏览器登录态导入，v0.8.7 起定向禁用：仅 Windows+Chrome≥155） `ego_captcha` `ego_dialog` |
| 元工具 | `ego_help` `ego_doctor` `ego_http` |

> 导航/等待语义（v0.8.7）：`ego_wait_for_url` 先比对当前 URL 再等未来导航，结果带 `matchedCurrent`；`ego_wait_for_response` 超时返回结构化 `reached:false`，不再抛错；两个等待都只观察**本次调用期间**的事件——触发动作与等待要放在同一个 `ego_script` 里。`ego_script`/`ego_cli` 的脚本需以 `console.log('@@DSH_RESULT@@' + JSON.stringify({...}))` 结尾（忘记哨兵时会兜底解析最后一行 JSON，并标记 `fallback: true`）。

## 观察窗怎么用

右下角 **🌐 常驻小球** → 点开：

- **主画面**：agent 当前页面实况；点击/拖动/滚轮直接操作页面，Ctrl+滚轮缩放视图、Ctrl+拖动平移，双击复位。点击画面后可直接键盘输入，支持中文 IME、粘贴、Tab/Enter/方向键及 Ctrl/Cmd 快捷键。
- **标签页条**：顶部横排，点选切换，`×` 关闭。
- **历史抽屉**（🕘）：按时间回看访问轨迹。
- **尺寸同步（🔒/🔓）**：在「打开真实页 / 弹出窗口」按钮行。解锁**本身不改窗口**；之后拖动右侧边栏边缘时，窗口按拖动**增量** 1:1 缩放（CDP 窗口 bounds，页面按新尺寸重排），高度跟随页面比例。锁定则恢复"只缩放画面"。无头浏览器没有窗口可调，需先点「弹出窗口」。
- 操作时下方网址行就地显示提示，2 秒后恢复。
- 面板关闭、sidebar Tab 隐藏或组件卸载后，1.5 秒宽限结束即停止画面生产。仅把 DSH 窗口切到后台不会停止串流，避免回前台时反复重建 WGC/FFmpeg；异常关闭由 120 秒 worker lease 超时兜底。

### 画面后端

- `cdp`：`Page.startScreencast` JPEG，默认 20 FPS。每个源帧立即按 Chrome 提供的帧 ID ACK，只保留最新待发帧；仅捕获当前观看标签，静态页恢复截图默认 3 秒一次。
- `ffmpeg`：Windows 以 `gfxcapture(hwnd)` 直接采集目标 Chrome 窗口的 D3D11 surface；其他平台使用显示来源 crop。随后编码 H.264 fragmented MP4 → HTTP 二进制 chunk → MediaSource `<video>`，不经过 Base64/SSE。
- `auto`：默认选择 CDP，不检测成功也不会自动下载 FFmpeg。FFmpeg 安装并通过能力检查后才可选择；已保存的 FFmpeg 后端若后来失效，本次观察会回退 CDP 并展示原因。
- Windows FFmpeg 必须包含 `gfxcapture`。插件按 browser PID、target title 和 CDP window bounds 匹配 HWND；窗口移动或被遮挡时仍捕获目标页面，并且不允许回退到桌面录制。若 target 是同一 Chrome 窗口里的后台 tab，会明确报错而不是展示当前可见 tab 或抢用户焦点。macOS 首次使用需要“屏幕录制”权限；X11 需要 Chromium 与 FFmpeg 共享 `DISPLAY`；Wayland 缺少 Portal/PipeWire 输入时会提示切回 CDP。

托管 FFmpeg 安装到 `~/.dsh/cache/ego-browser/ffmpeg/`，不会写入插件目录。Windows/Linux 使用固定 BtbN release tag；macOS 使用固定的 `ffmpeg-static` GitHub release 资产（其 Intel/Apple Silicon 二进制分别来源于 Evermeet/OSXExperts）。所有下载均固定资源 SHA-256，只提取 FFmpeg 主程序，不安装 `ffprobe` 或 `ffplay`。Windows/Linux 解包使用系统 `tar`；缺少时会在下载前明确报错。

> 登录态说明：多任务空间 Cookie 相互隔离，请在对应空间内登录。重启 DSH 后运行期登录态被清空（Chrome 运行期 Cookie 仅优雅关闭时落盘），需重登——扫码很快。

## 工作原理

- **工具层**：每个工具把参数拼成 JS 脚本，经 `ctx.subprocess` 用 `ego-browser nodejs` 喂给 stdin 运行，宿主经 CDP 驱动共享 Chromium。结果以 `@@DSH_RESULT@@` 哨兵行解析（v0.8.7 起无哨兵时兜底解析最后一行 JSON 并标记 `fallback: true`）。所有 `ego_*` 经进程内互斥锁串行化，错误统一归一。
- **观察窗**：`lib/client.js` 管理 watcher lease、JPEG `<img>` 与 MSE `<video>`；`src/cast-server.ts`（构建进 `lib/index.js`）代理元数据 SSE、watch API 和带背压的二进制视频；worker 中 `CaptureManager` 保证同时只有一个活动后端和一个当前 target。CDP 控制面（标签、viewport、输入、验证码）独立于画面后端。

## 开发

源码在 `src/`（TypeScript），构建产物在 `lib/`（host + client bundle）与 `bin/ego-cast-worker.mjs`（worker bundle）。

```sh
pnpm typecheck   # tsc 类型门禁（tsconfig.json 主 + tsconfig.client.json 客户端）
pnpm test        # vitest 单元测试
pnpm run build   # tsdown 三 bundle：lib/index.js + lib/client.js + bin/ego-cast-worker.mjs
```

> 直接改 `src/`（`src/index.ts` 工具层、`src/client/index.ts` 前端、`src/worker/ego-cast-worker.ts` worker）。新工具在 `registerActionTools` 里按 `t({...})` 加，并在 `ego_help` 索引（`src/help.ts`）补一条，跑 `pnpm typecheck && pnpm test && pnpm run build`。`lib/` 与 `bin/ego-cast-worker.mjs` 是构建产物（预构建入库），不要手改。

`node_modules/` 仅含指向 DSH checkout 的符号链接（编译期类型解析）；运行时由 harness 解析 `@deepseek-ai/dsh-tools`。

## 已知限制（诚实说明）

- **Windows**：插件层已做 v0.4.0 适配；底层 ego-lite 宿主仍是非 Windows 官方支持的社区移植，复杂多步流程稳定性可能弱于 macOS。v0.8.7 修复了孤儿 Chrome 占锁（#70），v0.8.8 起崩溃/回收后遗留的孤儿标签会被自动清扫（#67），但强杀/崩溃后的 profile 恢复仍建议非必要不中断浏览器进程。
- **macOS**：需要**手动**在设置里填 `chromePath`（`.app` 路径），`COMMON_CHROME_BINS` 不含 macOS 路径；且无 `$DISPLAY` 时 headed 路径会去找 Xvfb（macOS 上不存在）。这两点（#65/#68）待社区 PR [#72](https://github.com/Fisfzy/dsh-ego-browser/pull/72)（`.app` 探测 + headed 免 Xvfb，作者称已在 macOS arm64 + Chrome 154 真机验证）rebase 合并后即可开箱使用；合并前可手动填 `chromePath` 临时可用。
- **登录态导入**：v0.8.7 起 `ego_login_import` 定向禁用——仅 **Windows + Chrome ≥155** 拒绝（原因见 #69），Linux / macOS / 旧版 Chrome 正常可用；确认环境无风险后用 `EGO_LINUX_LOGIN_IMPORT_FORCE=1` 可在任何环境放行。
- **FFmpeg 平台捕获**：Windows 已使用 `gfxcapture(HWND)`，需要包含该 filter 的新构建；PATH 中的旧 FFmpeg 会被跳过并提示下载兼容版本。Linux 使用 `x11grab`、macOS 使用 `avfoundation` display crop；macOS ScreenCaptureKit、Wayland Portal helper 属后续增强。
- **安装环境**：本仓库的 DSH peer 包不全在公共 npm registry。普通 `pnpm install` 可能在解析 `@deepseek-ai/*` peer 时失败；DSH profile 安装应提供这些 peer。CDP 不依赖 FFmpeg，也不会在插件安装阶段下载二进制。
- **快照质量**：Linux 用 CDP `DOMSnapshot` 重建语义树，非 macOS 内核级，复杂 iframe/画布场景可能降级。
- **宿主可靠性（Linux）**：未合并的社区 PR，跨 CLI 调用间可能丢 tab/空间状态；插件已内置防御，简单流程稳定，复杂流程可能需重试。
- **登录态持久化**：Chrome 运行期 Cookie 仅优雅关闭时落盘，强杀重启需重登。
- 输出 schema 为宽松 `additionalProperties: true`，客户端以实际返回值为准。

## 许可与署名

插件本体 MIT。内置运行时嵌入 ego-lite 的 MIT 代码；可选下载的 FFmpeg 构建涉及 GPL-3.0-or-later 义务。使用或再分发前请阅读构建来源的许可证与源码获取信息，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 供应链与权限说明

为目录收录与审查提供的确定性事实：

- **运行文件**：`lib/`（构建产物，由 `npm run build` 从 `src/` TypeScript 以 tsdown 确定性生成）、`bin/`（worker 与 ffmpeg-probe 的可执行入口脚本）、`cordis.patch.yml`（装配层）、`dsh-plugin.json`（manifest）。`*.map` 仅为调试用 sourcemap，不参与运行，已声明排除。
- **原生/可执行工件**：`runtime/` 内置 ego-lite 运行时（MIT，来源与逐文件清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）——它是本插件的核心功能（自带受管 Chrome/CDP 宿主），属有意携带的可执行工件，非构建副产物。`runtime/PATCHES.md` 记录对上游的全部本地补丁。
- **依赖**：运行时依赖仅 `@deepseek-ai/schemastery`（由 DSH 宿主提供对等实现）；peer 依赖全部为 `@deepseek-ai/dsh-*` 宿主服务。客户端 bundle 的外部模块由宿主模块表解析，不携带 npm 运行时依赖。
- **外部服务**：无遥测、无外部 API 调用。唯一的网络行为是**可选的** FFmpeg 安装器按用户指令从 GitHub（或用户配置的镜像）下载构建件，来源校验与许可义务见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- **失败边界**：宿主无 webServer（TUI/headless）时 watch 路由安全跳过；worker 启动失败时 watch 路由返回 `ok:false` 的 JSON 而非挂起；浏览器进程随宿主 teardown 一并终止（`--stop` fire-and-forget，不阻塞宿主退出）。
- **权限**：manifest `permissions` 为空——工具集的文件读写被限定在 ego 自管的空间目录与用户工作区，网络访问经由受管的 agent 浏览器而非宿主进程。

---

## 友链

同为 DeepSeek Harness 插件生态的作品，互相安利：

<p align="center">
  <a href="https://dshfind.com/zh/plugins/Nagi-ovo/dsh-ads?ref=badge"><img src="https://dshfind.com/api/badge/Nagi-ovo/dsh-ads?lang=zh" alt="dshfind - dsh-ads"></a>
  <a href="https://dshfind.com/zh/plugins/Nagi-ovo/dsh-ads"><img src="https://dshfind.com/api/card/Nagi-ovo/dsh-ads?lang=zh" alt="dsh-ads card"></a>
</p>
