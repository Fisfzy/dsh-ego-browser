# ego-browser — 看得见的 Agent 浏览器

<p align="center">
  <a href="https://dshfind.com/zh/plugins/Fisfzy/ego-browser?ref=badge"><img src="https://dshfind.com/api/badge/Fisfzy/ego-browser?lang=zh" alt="dshfind - ego-browser"></a>
  <a href="https://dshfind.com/zh/plugins/Fisfzy/ego-browser"><img src="https://dshfind.com/api/card/Fisfzy/ego-browser?lang=zh" alt="ego-browser card"></a>
</p>

> **仓库**：`github.com/Fisfzy/ego-browser`（私有 · 内测）｜版本历史见 [CHANGELOG.md](CHANGELOG.md)｜详情页：[dshfind](https://dshfind.com/zh/plugins/Fisfzy/ego-browser)

> ⚠️ **发布说明**：本插件用于 DeepSeek Harness 生态，已在 [dshfind](https://dshfind.com/zh/plugins/Fisfzy/ego-browser) 公开展示。仓库保持维护状态，不发布到 npm / 公共 registry；如需转载本仓库内容请注明出处，不要创建用于分发的公开 fork / 镜像。

把 [CitroLabs/ego-lite](https://github.com/CitroLabs/ego-lite)（给 AI Agent 用的 Chromium）接入 DeepSeek Harness：以 **32 个结构化 `ego_*` 工具**驱动浏览器，并配一套**实时观察前端口**——agent 后台操作网页时，你能像看直播一样看到它正在浏览的每个页面，还能直接操作它。

**一点私藏的独特之处（self-observation）**：agent 用的就是这一个 Chromium——连它操作 **DSH 自身**（管理会话、任务看板、调设置）时，观察窗也实时显示、你能随时接手。不只是"看得见 agent 在网页上干活"，连 agent 操作 DSH 界面本身都是全程可见、可掌控的。

**开箱即用**：插件包内置 ego 运行时（`runtime/`，MIT，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）——无需克隆官方仓库、无需手动构建，`--no-sandbox` wrapper 随包自带，root / Docker / 无显示器一键跑。

---

## 我们的真正优势（不是口号，是能对照代码和竞品核实的能力）

同样把 ego-lite 接进 DSH，市面上已有同类插件用它**只做了 3 个工具**——一个 `run` 脚本、一个 `help` 指南、一个 `status` 体检，浏览器仍是**后台黑盒**。`ego-browser` 走的是另一条路：**把黑盒打开，并且一上来就把"看"和"控"的能力做到位**。

| 能力 | ego-browser（本仓库） | 同类插件（Da1dr1em/dsh-ego-browser） |
|---|---|---|
| 结构化工具数 | **32 个**，职责单一、可确定性调用 | **3 个**（`run`/`help`/`status`） |
| 实时观察窗（CDP JPEG / FFmpeg H.264 双后端 + 标签条 + 历史抽屉） | ✅ 有 | ❌ 无 |
| 监控窗鼠标**直接操作**真实浏览器（点击/拖拽/滚动回传 CDP） | ✅ 有 | ❌ 无 |
| worker 单实例守卫 + 崩溃/重复自愈 | ✅ 有 | ❌ 无 |
| 下载捕获 `ego_download` / 人机验证检测 `ego_captcha`/`ego_page_info` | ✅ 有 | ❌ 无 |
| 平台自适应（Linux/macOS/Windows 自动探测 + root/无头/`--no-sandbox` 兜底） | ✅ 全平台 | 仅 Windows 预览宿主，需手动配 |
| 登录态落盘持久化 `ego_auth_flush` | ✅ 有 | ⚠️ 仅文档级说明 |

**关键差异两条：**
- **看得到**：别家是"跑完告诉你结果"的黑盒；我们实时推流，你**看着 agent 操作**，卡在验证码/走岔立刻发现。
- **控得住**：别家只读；我们监控窗**直接驱动**同一个 agent 浏览器，需要时你亲手接管（缩放/拖拽/点击），不必打断 agent 重来。

> 以上对比基于公开可见的可核实事实：本仓库代码（`bin/ego-cast-worker.mjs` 实时推流 + CDP 输入回传、`lib/index.js` 32 个注册工具、`lib/cast-server.js` host 桥接）与同类插件的源码/README。此文档不含对任何他人的贬低——我们只陈述自己多实现并验证了哪些能力。

**相对 [ego-lite](https://github.com/CitroLabs/ego-lite) 本体，我们多做了这些（都可对照本仓库代码核实）：**

| 能力 | 说明（对应代码） |
|---|---|
| **观察窗前端口** | ego-lite 本体是无头 CLI（只有 heredoc 脚本 + 文本输出）；我们在其上加了 **SSE 实时推流 + 标签条 + 历史抽屉 + 监控窗鼠标直操**（`bin/ego-cast-worker.mjs`、`lib/cast-server.js`、`lib/client.js`），让"看"和"控"成为一等能力 |
| **开箱即用 + 跨平台自足** | `resolveEgoEnv` 自动探测 Chrome/Edge/Brave，内置 `--no-sandbox` wrapper，root / Docker / 无显示器免配置（`lib/index.js`）；不必像官方那样先装一个 GUI 宿主 |
| **健壮性层** | 冷启动自动重试（只重试 CDP 瞬态，不吞真错）、worker 单实例守卫 + 崩溃自动重启、插件卸载 fire-and-forget 不阻塞宿主退出、前端帧缓存上限（`withWarmupRetry` / `makeEnsureWorker` / `frameCache`） |
| **运维型工具** | `ego_doctor`（环境体检）、`ego_captcha`（人机验证探测）、`ego_auth_flush`（登录落盘）、`ego_http`（浏览器上下文请求）等，是原生 CLI helper 没有的一层 |
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

- **v0.7.0**：观察窗状态灯**干活常绿、空闲呼吸**；`ego_script` 每次运行超时 `timeoutMs` 真正生效；前端 `frameCache`/`pageMeta` 按标签清理 + 上限兜底，杜绝长会话内存增长；状态路径家目录回退改 `os.homedir()` 跨平台化；新增 `.gitattributes` 统一 LF 换行。
- **v0.6.1**：卸载不再阻塞宿主退出（自愈链路稳定）；观察窗 worker **单实例守卫** + stale 状态清理；登录/人机验证引导条可关闭且互斥；**观察窗主动跟随 agent 正在操作的页面**（不再被后台重绘页抢占视图）。
- **v0.6.0**：工程收敛——`lib/` 定为唯一源，`build` 改语法校验，杜绝"一构建全回归"。
- **v0.5.0**：实时 SSE 推流 + 监控窗直接操作 agent 浏览器。
- **v0.4.0**：Windows 适配。
- 完整历史见 [CHANGELOG.md](CHANGELOG.md)。

---

## 前置条件

| 要求 | 说明 |
|---|---|
| Node ≥ 22 | harness 环境自带 |
| **任意 Chrome / Chromium / Brave / Edge** | 自动发现，或 `EGO_LINUX_CHROME` 指定；root 下用自带 wrapper |
| DSH + dshx | 插件装载机制 |
| 带图形界面的 DSH Web（观察窗） | headless 会话仍可用 `ego_*` 工具，仅无观察窗 |

## 安装

```sh
dshx install ego-browser <ego-browser.tgz>                             # tarball 或 git URL 均可
dshx list                                                # 应显示：[on] ego-browser
```

观察窗设置中可选 `captureBackend=auto|cdp|ffmpeg`（默认 `auto`，当前解析为 CDP）、画质档位、CDP FPS/JPEG 质量/最大宽度，以及 FFmpeg FPS/最大宽度/码率/编码器/自定义路径。插件先检测自定义路径、系统 PATH 和托管缓存；检测到兼容 FFmpeg 前，设置页禁止选择 FFmpeg，并提供固定版本的一键下载。GitHub 下载可用 `githubMirror` 替换 `https://github.com`，例如 `https://gh-proxy.com/github.com`。FFmpeg 码率范围为 500-20000 kbps，低/平衡/高档默认 2000/4000/8000 kbps。

无需宿主侧任何配置：`resolveEgoEnv` 自动探测 root / 无显示器并兜底。观察窗 host 路由（`/api/ego/spaces` 等）仅在有 HTTP server 时注册，headless 是安全 no-op。

## 工具清单（32 个，前缀 `ego_`，完整索引见 `ego_help`）

| 类别 | 工具 |
|---|---|
| 任务空间 | `ego_space_open` `ego_space_close` `ego_status` |
| 页面读取 | `ego_snapshot`（语义树） `ego_page_info` `ego_read_element` |
| 导航/等待 | `ego_navigate`（复用 tab） `ego_wait` `ego_wait_for_selector` `ego_wait_for_url` `ego_wait_for_response` |
| 交互 | `ego_click` `ego_fill` `ego_hover` `ego_drag` `ego_select` `ego_check` `ego_key` `ego_scroll` |
| 执行/调试 | `ego_js`（页面求值） `ego_cdp`（原始 CDP） `ego_cli`（任意 heredoc） `ego_script`（多步脚本） |
| 输出 | `ego_screenshot` `ego_download` `ego_upload` |
| 会话/安全 | `ego_auth_flush`（登录落盘） `ego_captcha` `ego_dialog` |
| 元工具 | `ego_help` `ego_doctor` `ego_http` |

## 观察窗怎么用

右下角 **🌐 常驻小球** → 点开：

- **主画面**：agent 当前页面实况；点击/拖动/滚轮直接操作页面，Ctrl+滚轮缩放视图、Ctrl+拖动平移，双击复位。点击画面后可直接键盘输入，支持中文 IME、粘贴、Tab/Enter/方向键及 Ctrl/Cmd 快捷键。
- **标签页条**：顶部横排，点选切换，`×` 关闭。
- **历史抽屉**（🕘）：按时间回看访问轨迹。
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

- **工具层**：每个工具把参数拼成 JS 脚本，经 `ctx.subprocess` 用 `ego-browser nodejs` 喂给 stdin 运行，宿主经 CDP 驱动共享 Chromium。结果以 `@@DSH_RESULT@@` 哨兵行解析。所有 `ego_*` 经进程内互斥锁串行化，错误统一归一。
- **观察窗**：`lib/client.js` 管理 watcher lease、JPEG `<img>` 与 MSE `<video>`；`lib/cast-server.js` 代理元数据 SSE、watch API 和带背压的二进制视频；worker 中 `CaptureManager` 保证同时只有一个活动后端和一个当前 target。CDP 控制面（标签、viewport、输入、验证码）独立于画面后端。

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

- **Windows**：插件层已做 v0.4.0 适配；底层 ego-lite 宿主仍是非 Windows 官方支持的社区移植，复杂多步流程稳定性可能弱于 macOS。
- **FFmpeg 平台捕获**：Windows 已使用 `gfxcapture(HWND)`，需要包含该 filter 的新构建；PATH 中的旧 FFmpeg 会被跳过并提示下载兼容版本。Linux 使用 `x11grab`、macOS 使用 `avfoundation` display crop；macOS ScreenCaptureKit、Wayland Portal helper 属后续增强。
- **安装环境**：本仓库的 DSH peer 包不全在公共 npm registry。普通 `pnpm install` 可能在解析 `@deepseek-ai/*` peer 时失败；DSH profile 安装应提供这些 peer。CDP 不依赖 FFmpeg，也不会在插件安装阶段下载二进制。
- **快照质量**：Linux 用 CDP `DOMSnapshot` 重建语义树，非 macOS 内核级，复杂 iframe/画布场景可能降级。
- **宿主可靠性（Linux）**：未合并的社区 PR，跨 CLI 调用间可能丢 tab/空间状态；插件已内置防御，简单流程稳定，复杂流程可能需重试。
- **登录态持久化**：Chrome 运行期 Cookie 仅优雅关闭时落盘，强杀重启需重登。
- 输出 schema 为宽松 `additionalProperties: true`，客户端以实际返回值为准。

## 许可与署名

插件本体 MIT。内置运行时嵌入 ego-lite 的 MIT 代码；可选下载的 FFmpeg 构建涉及 GPL-3.0-or-later 义务。使用或再分发前请阅读构建来源的许可证与源码获取信息，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## 友链

同为 DeepSeek Harness 插件生态的作品，互相安利：

<p align="center">
  <a href="https://dshfind.com/zh/plugins/Nagi-ovo/dsh-ads?ref=badge"><img src="https://dshfind.com/api/badge/Nagi-ovo/dsh-ads?lang=zh" alt="dshfind - dsh-ads"></a>
  <a href="https://dshfind.com/zh/plugins/Nagi-ovo/dsh-ads"><img src="https://dshfind.com/api/card/Nagi-ovo/dsh-ads?lang=zh" alt="dsh-ads card"></a>
</p>
