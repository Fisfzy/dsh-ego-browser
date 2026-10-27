# Changelog

所有对用户可见的变更集中在各版本号下。格式遵循 [Keep a Changelog](https://keepachangelog.com/)，版本语义遵循 [SemVer](http://semver.org/)。

## [0.9.7] - 2026-10-27 — 会话级任务空间

### 新增
- **每个 DSH 会话一个独立任务空间（`sessionScopedSpaces`，默认开）**：此前所有会话共用一个 `dsh-agent` 空间——两个会话（或主代理 + 子代理）同时浏览时会互相抢标签，标签游标也会互相覆盖（即便修好标签定向，仍会跨会话漂移）。现在省略 `space` 时按会话派生空间名（`dsh-agent-<sid8>`），每个会话有自己的 browser context / 窗口 / 标签集与游标；显式传 `space` 仍可共用。设置关闭后回到单一共享空间。
- **标签游标按会话分键**（`scopedTargetKey`）：即使两个会话共用同一空间（作用域关闭），它们也各记各的当前标签，不会互相改道。
- **空间解析按会话惰性创建**：`createSessionScopedSpaceTracker` 为每个会话维护独立的 `ActiveSpaceTracker`，显式 `ego_space_open` / `ego_space_close` 只影响本会话；`sessionScopedSpaces` 是 live getter，改设置后新会话立即按新策略，已选空间的会话保持不变。

### 兼容性
- 升级后首次调用会打开一个新窗口（新空间），旧 `dsh-agent` 空间里的标签不会自动迁移；要继续用旧空间，显式传 `space: "dsh-agent"`，或把 `sessionScopedSpaces` 关掉。

### 测试
- 新增 `tests/session-scoped-spaces.test.ts`（13 项）：空间名派生与清洗、跨会话隔离、显式选择互不影响、关闭作用域后回退共享、游标键按会话区分、配置默认值与显式关闭。

## [0.9.7] - 2026-10-27 — 等待响应：回放已完成请求 / 缓存自解释
## [0.9.5] - 2026-10-27 — 滚轮修复 / 双缓冲硬化 / PR #83

### 修复
- **侧栏滚轮/触控板滚动失效（#81 回归）**：0.9.4 的 wheel 监听绑在条件渲染的语义 `<img>` 上，首帧到达前 `<img>` 不存在，one-shot effect 之后不再重绑。现在监听器挂在**始终存在的 `.dsh-ego-side-stage`** 上（`passive:false`），点击/双击/`Ctrl+滚轮` 行为不变。
- **双缓冲 review 硬化（#82）**：冷启动/切目标时用 `liveFrameUrl` / frameCache / 当前缩略图做种子，不再清空两层导致空白；`onerror` 不再交换失败层（保留上一帧）；目标切换清理 `liveBufferPending` 并加 generation guard，防止旧页面的帧落到新页面；黑色背景移到 `.dsh-ego-side-livebox`。`maxWidthHint` 变化后重启 watch 的逻辑已在 0.9.4 提供。

### 新增
- **PR #83（社区 @mecamangeg）**：修复多标签时结构化工具总是切到第一个 tab / `ego_script` 没有 tab 选择的问题——新增 per-space tab cursor + `@@EGO_TARGET@@` side channel；`ego_navigate`/`ego_script`/`ego_cli` 支持显式 `tab`；新增 `viewportWidth` / `viewportHeight` / `deviceScaleFactor`（HiDPI 下避免移动版布局）；`ego_select` 回退 value → label → index。源码已 rebase 到 0.9.4 并用当前工具链重建，新增 25 个测试。

## [0.9.4] - 2026-10-27 — Chrome 风格 UI / 一键登录态 / ego_tabs

### 新增
- **Agent 浏览器面板 UI 重做（Chrome 配色）**：移除「需要账号登录时…」引导条；改用 Chrome 调色板（`#f1f3f4` 工具栏、`#202124/#5f6368` 文字、`#1a73e8` 强调，深色模式跟随 `prefers-color-scheme`）；标题栏为浅灰工具区 + 蓝色实心「连接/复用 Chrome 登录态」主按钮；标签栏改为 Chrome 式活动白标签；页面标题/URL 放在标签栏下方；状态改为轻量 dot + 文本 + 执行器 chip；操作按钮改为扁平 ghost 样式（26px 高、4px 圆角、hover/focus 状态）；配对面板为 Chrome 风白色浮层（锚定在页面信息下方）。同时修掉整行 `opacity:.6` 导致按钮发灰的问题。
- **`ego_tabs` 工具（0.9.4）**：一个工具管理标签页——`list`（返回 targetId/title/url/active/index）、`switch`（按 targetId 切换）、`open`（按 url 新建，默认 about:blank）、`close`（按 targetId 关闭），每次操作后返回最新标签列表。底层复用 runtime 的 `browser.listTabs/switchTab/closeTab` 与 `ego.createTab`，targetId 与 `ego_space_open`/`ego_navigate` 返回一致。真机脚本已验证 list → open → switch → close 全链路。
- **`ego_login_import` 双安全路径（#69 E + A）**：
  - **E 安全复制**：删除 junction/symlink 启动真实 profile + 强杀的旧路径；现在只复制 `Local State` + Cookies 到临时 profile 读取，真实 profile **从不被浏览器打开/写入**。Chrome/Edge 127+ 因 ABE 复制读到 0 条 cookie，工具明确报错而不是回退到破坏性路径。真机验证：源 Cookies SHA-256 前后一致。
  - **A Chrome 扩展桥接**：新增 `extension/`（MV3，`cookies`/`alarms` 权限）与常驻回环桥接 `login-extension.ts`；Agent 浏览器面板右侧新增 **「连接 / 复用 Chrome 登录态」** 按钮：首次配对码（6 位）配对一次，之后每次点击即启动导入任务，扩展通过后台轮询（30s alarm，配对后立即触发）自动读取当前网站 cookie 并写入 ego 浏览器——不再需要每次打开 Chrome UI 或手动点 Export。`ego_login_import({source:"extension",domains:[...]})` 仍可用（等待扩展轮询）。用 Chrome for Testing 156 完成真实端到端验证（扩展读取测试 cookie → 回环 POST → ego 浏览器写入 1 条）。

## [0.9.3] - 2026-10-26 — 侧栏双缓冲 / TUI 纯文字 / 图标统一 / 移除悬浮球

### 新增
- **常驻执行器可视化与失败监督（#73 phase 2）**：新增 host 路由 `/api/ego/executor`，观察窗状态行显示当前执行模式（`常驻` + 运行时长 / `一次性` / `常驻已停用`），悬停可看到 pid、最后一次重建原因或停用原因。监督逻辑：连续 3 次冷启动失败后常驻进程保持停用（`parked`），一次性 spawn 继续工作，直到用户切换设置或插件重启，避免 park → one-shot → respawn 循环。默认保持 opt-in（`residentExecutor` 默认关）：尚无"一整天浸泡无回归"的数据，先不做默认开启决策。设置持久化（gateway 写入后重启回退）仍需真机复现，留待验证。

### 修复
- **统一 Agent 浏览器图标**：面板头部原先用 globe 图标，与侧边栏入口的「浏览器窗口 + 光标」不一致；现在两处都使用同一个 `ICON_AGENT_BROWSER` 几何（16×16 圆角窗口、标题栏双点、agent 光标），侧边栏 `EgoWatchIcon` 与字符串图标保持同步。
- **移除悬浮球回退**：DSH 官方右侧边栏已覆盖观察窗，删除浮动 FAB / 浮窗、拖拽吸附、其专用 CSS/图标/常量与键盘代理代码（client bundle 明显减小），只保留原生侧边栏 Tab + 可选 `dsh-better-sidebar` 回退；两者都不可用时不再显示侧栏面板。
- **侧栏实时画面黑闪（#81 / #82）**：`<img src>` 逐帧替换会在新 JPEG 解码完成前丢掉已绘制的位图，面板整块露出黑色背景（macOS 无头 CDP 链路尤其明显，Windows 也可复现）。原生侧栏改为**双缓冲**：语义 `<img>` 只负责布局与指针/缩放（`opacity:0`），上方两层层叠 `<img>` 承载可见像素，新帧在隐藏层 `load`/`decode` 完成后才交换可见层，旧帧始终保留；挂载/切标签时用缓存的上一帧做种子，避免首帧空窗。旧浮动面板同样改为**先预加载/解码、再换可见帧**。另修 `maxWidthHint`：在 `root.clientWidth` 为 0 时不再锁成 480；宽度测量提前到首次 watch 之前，`ResizeObserver` 更新后若与当前采集宽度差 >20% 则防抖重启一次 watch，避免 Retina 上一直用 800 采集导致发虚。验证：staging 中两层交替、可见层始终有帧、指针映射不受影响、采集宽度 653px。macOS 实机复测待 #81 报告者确认。
- **TUI 面板改为纯文字（无画面）**：TUI 没有浏览器视窗渲染能力，面板不再使用 `ui.Image`/`/api/snapshot`/SSE 帧，只显示标签、状态、人机验证、当前工具/错误、最近动作与快捷键；同时把标签元数据与 `disableFrameRelay` 解耦（禁用 Web 画面回传时 TUI 仍能看到标签列表）。选中项改为按 **`targetId`** 保持，标签增删/重排后 `x`/`o` 不会作用到错误的页面。
- **登录导入安全范围扩大（#69）**：Windows 上从仅拒绝 Chrome ≥155 扩展为拒绝 **Chrome/Edge ≥127**（App-Bound Encryption 范围）。127–154 同样存在"junction 启动真实 profile + 强杀"的破坏性路径，本次先 fail-closed；`EGO_LINUX_LOGIN_IMPORT_FORCE=1` 仍可覆盖。Linux/macOS 与 Windows 上 Chrome <127 不受影响。
- **headless UA 版本与实际 Chromium 不一致（#79）**：headless 启动时注入的 UA 一直是硬编码 `Chrome/152.0.0.0`，而 `navigator.userAgentData` 来自真实二进制（社区实测 Termux 上外部 Chromium 为 155）。这种自相矛盾的指纹会被风控标记。现在运行时首次 headless 启动会用 `<binary> --version` 探测真实主版本（缓存，2s 超时，失败才回落 152）；Windows 上为避免 `chrome.exe --version` 弹窗不做探测，继续使用兜底值。新增 `parseChromeVersionMajor()` 单测。

### 文档
- **macOS 27 / Chrome 156 复测通过（#68）**：社区在 0.9.2 上复测（macOS 27.0.1 arm64 + Chrome 156.0.8078.47，去掉 `chromePath`/`--headless` 两个旧 workaround）——`.app` 自动探测、headed 冷启动、navigate/截图/`ego_doctor` 全通；README 的 macOS 实测记录已补充该环境（此前为 macOS arm64 + Chrome 154）。
- **Termux / Android 开箱说明（#78）**：README 新增 Termux 小节——`pkg install chromium`（x11 repo）、`chromium-browser` 已在候选列表中、无 `$DISPLAY`/Xvfb 自动 headless、无需 `--no-sandbox`、DBus 报错无害、手机终端建议 `disableFrameRelay: true`；`ego_doctor` 的“未找到浏览器”提示补充 `pkg install chromium`。
- **`ego_script` 的 page 门面不是 Playwright API（#80）**：`ego_help script`、`ego_script` 工具描述与 README 都列出完整 page 方法清单，并明确没有 `fill/click/type/press`（用 `ego_fill`/`ego_click` 或 `page.locator(...)`），`page.goto()` 不返回 Playwright Response。

## [0.9.2] - 2026-10-23 — macOS 开箱支持（#65/#68，社区 PR #72 移植）

本版把 macOS 从"需手动填 chromePath、headed 路径找 Xvfb"变成**开箱即用**：自动探测 `.app` 内的 Chrome/Chromium/Edge/Brave 并注入运行时，headed 启动不再依赖 X11/Xvfb，同时保留 #16 要求的真实窗口能力。社区贡献者 @syjnzh918 提供实现与 macOS arm64 真机验证。

### 修复
- **macOS 开箱可用（#65、#68）**：两处平台缺口叠在一起，使 macOS 首装第一次调用任意 `ego_*` 工具必然失败。其一，`COMMON_CHROME_BINS` 只列 Linux 路径、`resolveEgoEnv()` 的注入条件也不含 darwin，而 macOS 上 Chrome 不在 `PATH` 里（只在 `.app` bundle 内），于是报 `no Chrome/Chromium binary found`；现在由 `darwinChromeCandidates()` 探测 Chrome / Chromium / Edge / Brave（含 `~/Applications`），并像 win32 一样把结果注入 `EGO_LINUX_CHROME`。其二，填好路径后仍会撞运行时 `ensureXDisplay()`：它只给 win32 留了"有桌面会话、无 X server"的豁免，而 macOS 在这一点上完全同形（GUI 是 Aqua/Quartz，永不导出 `$DISPLAY`，Xvfb 也不存在于该生态），现在同样豁免。`isHeadlessDetected` 保持排除 darwin——把缺 `$DISPLAY` 当成无头正是 #16 的回归。真机验证：macOS arm64 + Chrome 154，冷启动 → navigate → 截图 → `ego_doctor` 全通。

### 社区
- macOS 适配（#65/#68）来自社区 PR [#72](https://github.com/Fisfzy/dsh-ego-browser/pull/72)（@syjnzh918），由其基于当时主干提交并附 macOS arm64 真机冷启动验证；本次将其移植到 0.9.1 后的主线上（解冲突、保留后续 win32/no-Xvfb、常驻执行器与观察窗改动，并补回归测试）。

## [0.9.1] - 2026-10-23 — 观察窗尺寸同步 / 帧链路性能 / 输入映射修复

本版把观察窗从"只能看"扩展成"能直接改真实窗口大小"：尺寸同步开关 + 比例预设 + 边缘拖拽，同时把串流 CPU 砍到约一半，并修复窗口缩放后的点击偏移与拖动卡顿。

### 新增
- **观察窗尺寸同步（真实窗口）**：侧边栏观察窗的「打开真实页 / 弹出窗口」按钮行新增 **🔒/🔓 尺寸同步** 开关与 **尺寸预设** 菜单。
  - **解锁本身不改变窗口**；之后拖动右侧边栏宽度、或直接拖观察窗的**右侧 / 底部 / 右下角手柄**，窗口按拖动**增量** 1:1 缩放（`POST /api/ego/window-size` + CDP `Browser.setWindowBounds`），横向拖动保持页面比例，纵向拖动改变高度。
  - **尺寸预设** 提供 16:9 / 4:3 / 21:9 / 1:1 / 9:16：保持当前窗口宽度，把高度设成对应比例。
  - 页面标题与 URL 现在显示在实时状态栏那一行（画面下方不再占两行）。
  - 布局/窗口其它变化会被吸收为新的基准，不会形成"越缩越小"的反馈环；无头浏览器返回 `headless` 并提示先「弹出窗口」；本次只做 CDP 后端，FFmpeg 路径未改。

### 修复
- **重启后观察窗卡在「⚠ 未接管 / 暂无截图」**：如果面板在浏览器/worker 还没起来时打开，host 的 `/api/ego/stream` 当时只能建一条静默 SSE，并且之后永远不会再接上 worker——即使浏览器后来启动了、worker 也在推帧，面板也收不到任何 `frame` / `spaces` 事件。现在这条流会每 1.5 秒重试 `ensureWorker()`，worker 一出现就自动接上（新增单测覆盖"worker 晚于 SSE 出现"的情况）。
- **画面边缘的红/橙色条**：边缘拖拽热区原来常显高亮条，看起来像画面多了一圈红边。现在热区默认完全透明，只在鼠标悬停时低调显示；解锁尺寸同步时仅保留极淡的提示色。
- **调整窗口后点击位置偏移**：screencast 帧携带的 `vw/vh` 视口元数据不会在每次窗口变化后更新（实测窗口已缩到 900×573 时帧仍标注 1264×805），面板按旧视口换算点击坐标导致落点偏移。现在：capture 每秒用 `Page.getLayoutMetrics` 同步真实视口；`/api/ego/window-size` 应用新尺寸后 160ms 内刷新会话视口；客户端收到 resize 响应立即用返回的 `viewport` 更新坐标映射。验证：窗口缩放到 900×573 后点击面板 60%/40% 位置，页面收到的坐标与预期一致（540,229）。
- **拖动边缘缩放卡顿**：`/api/ego/window-size` 原来每一步都重新 getWindowForTarget + getWindowBounds + 测量 chrome 边框 + 测量视口 + setWindowBounds（约 5 次 CDP 往返）。现在缓存 windowId / chrome 边框 / 窗口位置与视口（10s / 2s 过期），每步只需 1 次 setWindowBounds；实测单步延迟 avg 22ms（10–47ms）。

### 性能
- **观察窗串流 CPU 大幅下降**：两处结构性优化，帧率与功能不变。
  - **按源取帧**：`Page.startScreencast` 的 `everyNthFrame` 现在按 `cdpFps` 计算（20fps → 每 3 帧取 1 帧），Chrome 不再编码 ~100 帧/秒再丢掉 80%；实测源帧 ~100/s → ~33/s。
  - **采集宽度跟随面板**：客户端把面板实际显示宽度（× devicePixelRatio，含余量）通过 `watch/start` 的 `maxWidth` 上报，worker 取配置上限与面板宽度的较小值。面板约 550px 时采集从 1280 宽降到 ~654 宽，编码/传输/解码像素约降 4 倍；全屏面板时仍会按需放大。
  - 实测（Windows，面板开启、视频页面）：总 CPU 约占 **196% 单核 → 72% 单核**（Chrome ~170% → ~63%，worker ~20% → ~4%）；实际下发帧率 ~19/s → ~17/s。
- **窗口隐藏/最小化时停止串流**：面板监听到 `visibilitychange` 后会停掉 watch、关闭 SSE 与画面（恢复窗口时自动重新 watch/串流）。实测：最小化后 watchers 2 → 1，采集侧 CPU 降到约 6%；恢复后自动回到 2 并继续出帧。纯静态页面本来就只在内容变化时出帧。
- **TUI/无头环境可不传画面**：TUI 设置新增「关闭实时画面传输」（`disableFrameRelay`）开关；开启后不启动 cast worker、不做 screencast、不发帧，TUI 面板仅保留文字状态，`ego_*` 工具不受影响。TUI 面板本身只是事件驱动地按需取一张快照（maxWidth 320），没有连续串流。
- 画面 `<img>` 使用 `decoding="async"`，减少主线程解码阻塞。

## [0.9.0] - 2026-10-22 — dsh-TUI 支持（设置页 / 状态栏 / 侧栏面板 / 页面缩略图）

TUI 集成全部通过**可选服务独立注入**：宿主没有对应服务时静默跳过，不新增文件读取、轮询或 worker 启动。合并社区 PR #74、#75、#76（ccch1mneyyy）。

### 新增
- TUI 通过独立可选注入注册真实的 Agent Browser 设置页、工具活动状态栏和有限通知；缺席服务时不新增 TUI I/O 或后台轮询。
- 不可变浏览器状态快照记录当前工具与最近十次完成结果，包含执行耗时和截短错误；锁内工具从实际取得锁后开始计时。
- Web/TUI 共用安全的工具卡标题：只显示允许的定位摘要，按终端单元截断，隐藏输入值、HTTP 头/正文以及可执行源码。
- 侧栏面板（PR #75）：可选 28 列 Agent Browser 面板，展示浏览器运行/无头状态、活动页标题与 URL、按任务空间分组的标签列表、人机验证提示、最近 3–5 次动作；面板聚焦时支持 `↑/↓` 选标签、`o` 弹出真实窗口、`x` 关闭标签（有对话框服务时确认，否则双按）、`f` 落盘登录态、`r` 刷新；可见时约 2 秒刷新、隐藏即停、并发合并。新增 `tuiAutoOpenPanel`（默认关）。
- 页面缩略图（PR #76）：worker 新增本机回环 `GET /api/snapshot?targetId=…&maxWidth=…`（不占插件全局锁、不启动直播订阅），终端用宿主 `ui.Image` 显示；选中标签/工具结束/`r` 时各截一帧，隐藏时不请求，无拖影；PNG 用 Node `zlib` 自解（含大小/尺寸/解压上限，无新依赖），终端不支持图形协议时回退为一行文字；`disableFrameRelay` 时不截图。另显示既有的捕获后端/状态行。

### 修复
- 删除未实现的 TUI Scene 清单声明，Notification fallback 改为无 toast 服务时省略通知、保留工具结果。
- TUI 设置直接读取清单字段作为单一来源，并将清单画质选项纠正为运行时实际接受的 `low / balanced / high`；不改现有 Web 设置实现。

### 验证范围
- 增加可选服务、真实注册、设置一致性、隐私、Unicode 宽度、不可变快照、锁内执行、重试通知、空闲回收成功与生命周期清理测试。
- 合并后在本地通过 `typecheck` / `vitest`（234 passed, 5 skipped）/ `build`；尚未在真实 DSH TUI 或 Chrome 环境验证视觉布局与人工接管。

## [0.8.8] - 2026-10-22 — 原生右侧边栏 + 常驻执行器 + 孤儿标签清扫 + 登录导入定向放行

### 新增
- **原生右侧边栏支持（#64）**：DSH ≥ 0.2.1 自带右侧边栏（`@deepseek-ai/dsh-client-ui-sidebar-right`）时，观察窗注册为原生 Tab——`dsh-ego-browser:watch` 类型 + `sidebar.right.pane.tab` 面板 + guide 入口（自绘「浏览器窗口 + agent 光标」图标）。检测用 `ctx.inject(['sidebarRight','sidebarRightTabs'])` 等待服务（服务晚于插件就绪时不再漏检），优先级 **原生 > dsh-better-sidebar > 浮动球**；升级挂载时会释放上一个宿主，不会出现两份面板。自动打开仍按调用会话作用域。
- **常驻执行器（#56 第一期，可选）**：新增 `residentExecutor`（默认关）与 `residentIdleMin`（默认 30 分钟，0 = 保留到卸载）。开启后 `ego_*` 调用复用同一个 `ego-browser --serve` 进程：首次调用支付启动开销，之后每次 **~1–2 ms**（一次性 spawn 基准 ~340 ms）。浏览器被空闲回收/崩溃后，下一次调用自动回退到一次性 spawn 并重新拉起浏览器（带启动重试），随后恢复常驻；**已经写出的请求不会重试**，避免重复点击/填表。设置卡片（插件 → dsh-ego-browser → 配置）与 TUI settings 字段均已接线。
- **TUI 设置字段**：`dsh-plugin.json` 的 SettingsSection 补充常驻两项。

### 修复
- **浏览器在常驻进程下被停/崩溃后请求永久失败（#56）**：`--serve` 的 CDP socket 在浏览器停止后不会恢复，旧实现之后每次请求都报 `CDP channel is not open`。现在 `--serve` 每请求检查 `cdp.isOpen()`，失效立即返回可重试的 `browser is not reachable`；插件把它归为冷启动错误，回收常驻进程并走一次性 spawn 恢复（10s cooldown 后才重新常驻）。Windows 上启动失败不再空等 Xvfb（本来不存在，只会多等 10s+）。
- **孤儿标签（#67）**：`reconcile()` 增加两阶段 + 120s 宽限的孤儿 page target 清扫——关闭不属于任何 space 的标签（崩溃恢复/手动打开），跳过 `about:blank`/`chrome://`，并在 `closedSpaces` 留下 `(orphan tab)` 轨迹。此前 `pruneIdle`/`pruneAbandoned`/`--prune-spaces` 只遍历 `state.spaces`，扫不到这些孤儿。
- **登录导入定向放行（#69）**：`ego_login_import` 从"全禁"改为仅 **Windows + Chrome ≥155** 拒绝（该组合的 junction 别名 + 无头启动 + 强杀路径会读到 0 条 cookie 并破坏源 profile）；Linux / macOS / 旧 Chrome 正常可用，`EGO_LINUX_LOGIN_IMPORT_FORCE=1` 可在任何环境强制放行。工具会在错误信息里带上检测到的版本。

### 变更
- README 同步 v0.8.8：版本号、DSH 兼容矩阵（0.2.1 原生侧边栏）、侧边栏三种形态、常驻执行器、登录导入定向放行、Windows 已知限制。
- `dsh-plugin.json` 版本 0.8.8。
- 测试：181 passed / 5 skipped（新增常驻传输、恢复契约、配置与孤儿选择器用例）。

### 验证
- 真实桌面端（DSH 0.2.1-rc.2）：常驻首调 1485ms（含浏览器冷启动）→ 之后 1ms；`--stop` 后下一次调用自动恢复并重新拉起浏览器；冷却期走一次性；冷却后回到新常驻；全程仅 1 个常驻进程、无残留。
- 原生侧边栏（临时 web profile）：guide 出现「Agent 浏览器」及图标，面板正常推流/输入。
- #69：Windows + Chrome 155 正确拒绝并给出原因。

## [0.8.7] - 2026-10-22 — 工具语义修复 + Windows 孤儿锁 + 登录导入止损 + 回收器会话清理

### 修复
- **虚拟光标箭头与小手重叠**：覆盖层 `#arrow` 的 ID 规则带 `display:block`，优先级压过 `svg.shape{display:none}`——`showShape()` 切到手形/文字光标后箭头仍在绘制，两者在同一点重叠。现在可见性统一由 `svg.shape` / `.on` 控制：悬停链接只显示手形，悬停文本显示输入光标。
- **`ego_wait_for_url` 在导航已完成后仍报 `reached:false`（#71）**：改为两段式——先比对当前 URL（对无 glob 的模式做保守子串匹配），再等待未来导航；失败 payload 带当前 URL 与 `matchedCurrent`，并提示等待只在同一次调用内有效、匹配语义是全 URL 或 `**` glob。
- **`ego_wait_for_response` 超时直接抛错（#71）**：现在捕获超时并返回结构化 `{ok:false, reached:false, url, error, hint}`，不再让整次调用以退出码 1 结束。
- **`ego_dialog` 的误导性 "No dialog is showing"（#71）**：描述明确"只对当前正阻塞的 dialog 有效，跨调用的 dialog 已被自动 dismiss"；失败时附当前 URL 与可执行建议（在同一次 `ego_script` 里 `page.once('dialog', d => d.accept())` 后再触发点击）。
- **`ego_script`/`ego_cli` 忘记哨兵即硬失败（#71）**：描述写出 `@@DSH_RESULT@@` 字面量；新增兜底解析——没有哨兵时取最后一行可解析 JSON，并标记 `result.fallback: true`。
- **Windows 上孤儿 Chrome 永久占住 agent profile（#70）**：Chrome 在 Windows 只留空 `lockfile`、没有 `SingletonLock` 符号链接，旧 `clearProfileLock()` 永远 no-op；浏览器一旦非优雅退出，之后每次启动都被转交给孤儿进程并耗尽 20s 超时。现在 win32 下按命令行枚举持有本 profile 的 `chrome.exe`，先收集后终止（500ms 释放等待、10s 硬上限），再清 `lockfile`；只按本 profile 路径匹配，不动用户自己的 Chrome。
- **`ego_login_import` 默认关闭（#69 止损）**：Chrome 155 上 junction 别名 + 无头启动 + 强杀路径读到 0 条 cookie，且被观测到会清空真实 profile 的扩展注册表、重置默认搜索引擎。现在默认 fail-closed，`EGO_LINUX_LOGIN_IMPORT_FORCE=1` 才放行；彻底修复待独立设计。
- **空闲回收后 Chrome 崩溃恢复复活全部旧标签（#67 止损）**：`--stop` 被 Chrome 记为 crash，`Default/Sessions/` 残留会让下次冷启动静默恢复上一轮标签，而这些页面不在 `state.spaces` 中、`pruneIdle`/`pruneAbandoned`/`--prune-spaces` 都扫不到。现在 `stopBrowser()` 在确认浏览器已停止（或本就没在跑）后清理 `Default/Sessions/`；登录态在 `Network/Cookies`，不受影响。
- **纯文本/JSON 标签页不再被光标覆盖层糊成"乱码"**：`renderOverlay()` 在 `document.contentType` 非 `text/html` / `application/xhtml+xml` 时不注入覆盖层，并清掉上一个文档残留的 host（本地 runtime 补丁，见 `runtime/PATCHES.md`）。

### 变更
- **CDP 预览帧默认宽度 960 → 1280**：960 会把 1264 宽的常见笔记本视口先缩小再由面板放大，是"面板里文字发虚/发糊"的直接来源；1280 让常见视口落在原生宽度，更大屏幕可在设置页调到 1600/1920。

### 新增
- **`--serve` 常驻传输层（PR #63，BeiWay1145，refs #56）**：CLI 新增 NDJSON 常驻模式，一次启动摊掉进程启动与 harness 加载开销（报告者实测 ~350ms → 后续请求 0–1ms 级）。本次只合并传输半边，默认仍走 spawn 路径；插件侧生命周期（spawn 策略/监督/设置开关/客户端重建）留待后续版本接线。

### 社区
- 合并 PR #63（`--serve` 常驻传输，BeiWay1145）。
- macOS 适配（#65/#68）暂缓：维护者暂无 Mac 设备验证。

## [0.8.6] - 2026-09-28 — 登录态导入安全加固 + DSH 0.1.7 设置适配 + 人机验证误报修复

### 安全
- **`ego_login_import` 不再可能损坏源浏览器 cookie 库（#61，数据丢失）**：旧流程用 `Browser.close` 优雅关闭无头源实例，其异步 flush（热 Profile 上 10s+）会**晚于**还原逻辑落盘——在 Edge 153 上把还原好的 cookie 库覆盖成空库，且第二次调用抓到的"备份"已是空库，兜底全部失效（报告者靠手工快照救回）。现在：① 拆除时丢弃 CDP 连接并**强杀**实例（被杀进程不会 flush，磁盘保持启动前状态）；② **无条件还原并校验**（重读加密标记计数，失败重试一次），备份文件保留供手工恢复；③ 若源浏览器期间重新出现（用户在用）则跳过还原，不与活写入者竞争。代价是用户下次真开浏览器会看到一次"未正确关闭"气泡——比静默丢数据划算。

### 修复
- **导入/落盘的返回值不再"假成功"（#60）**：`closedSource`/`restoredFromBackup` 补进输出 schema（严格宿主此前把每次成功导入判为 invalid output，而副作用其实已执行）；读 cookie 的循环改为**计数稳定后退出**（旧逻辑"首次非空即停"在冷启动渐进加载时只读到 0-1 条却报成功）；`ego_auth_flush` 无错误时不再返回 `error: undefined`（undefined 不是合法 JSON，整条结果被拒）。
- **写入落地改为服务端确认**：`written` 旧值只是批处理算术，`browser.json` 指向陈旧/被替换的实例时会"报成功但什么都没写"。现在每个 jar 写入后**读回逐条比对**；一条都没落地 = 硬失败并给出重启 agent 浏览器的指引。
- **隔离空间收不到导入的 cookie**：`EGO_ISOLATE_SPACES=1` 时空间上下文是**创建时**从默认 jar 播种的快照（点时间拷贝，非实时共享），导入后已打开的 space 页面仍显示未登录。导入现在写入默认 jar **加** `task-spaces.json` 中所有活跃 space 上下文；某个上下文已消失时降级为警告而非使整体失败。
- **人机验证误报（#62）**：文本兜底匹配裸 `captcha` 名词，任何**讨论**验证码的页面都会误报——包括渲染了本插件源码注释的本地 dashboard。现在：① **本机地址（loopback）不做文本探测**；② 改为匹配**挑战短语**而非裸名词。选择器命中逻辑不变（真实 reCAPTCHA/hCaptcha/Turnstile/Cloudflare 容器仍立即上报）。worker 内的并行探针同步修改。
- **DSH 0.1.7 设置保存后不再静默（0.1.7 forms 路径）**：适配后读路径切到了 loader 活配置，但**没有任何变更订阅**，`onChange()` 保存后零次触发——投屏 worker 的热推送只在下次 spawn 才看到新值（worker 常驻时永远看不到）。现订阅宿主 `settings/document-updated`（forms 服务 `describe()` 后发出），**一条订阅覆盖插件页表单与 `/ego/api/set` 网关两条写入路径**，随插件 fiber 卸载。
- **`--open` 在 Windows 上退出码为 1（#62）**：`process.exit(0)` 在 CDP socket 仍在关闭时执行，触发 libuv `!(handle->flags & UV_HANDLE_CLOSING)` 断言——窗口正常抬起但退出码非 0，按 `$LASTEXITCODE` 判断的调用方视为失败。现改为设置 `process.exitCode` 让事件循环自然退出，加 unref 的 3 秒兜底防句柄泄漏挂起。
- **登录/验证提示的窗口名对不上（#62）**：Chrome 显示的是网页标题，按「ego lite — agent」在任务栏/Alt+Tab 都找不到。文案改为指引面板里已有的**「弹出窗口」按钮**（会置前，无头实例替换为同 Profile 有头窗口）。

### 新增
- **DSH 0.1.7 设置页适配（插件页行配置）**：0.1.7 退役了可注册的 settings 命名空间与 `settings.plugin.item` 槽。现于 `plugins.row.config` 注册配置视图（同时按 `@dsh-external/ego-browser` 与包名 `dsh-ego-browser` 两个 bundle 名注册，键为 `<bundle>#<rowId>`），由宿主下发的 `ConfigPageForm` 渲染（保存走 `form.mutate(ops, revision)`），偏好字段标记 `.volatile()` 并用宿主自己的 schemastery fork 构建 schema；≤ 0.1.6 保留旧设置卡片。0.1.7 上实机验证：行页渲染全部 18 个字段，保存即时生效，重启后保留。
- **「禁用画面回传」开关 `disableFrameRelay`（PR #55，HuanLinOTO）**：可选关闭实时帧回传（含 `/api/ego/stream` 的相应行为）。

### 社区
- 合并 PR #55（disableFrameRelay 开关，HuanLinOTO）。
- 审查并关闭 PR #59（0.1.7 设置读写）：其诊断正确，但 master 上的端到端适配已覆盖同一问题且更完整（含插件页写入路径与上面的变更订阅），并在关闭说明中写明其方案未覆盖的两点。

## [0.8.5] - 2026-09-18 — 登录态导入 + 空闲回收 + 观察窗修复群

### 新增
- **从系统浏览器导入登录态（#46）**：新工具 `ego_login_import` + 设置卡「从系统浏览器导入登录态」区块 + `POST /api/ego/login-import` 路由。把日常 Chrome/Edge/Brave 的登录 cookie 按域名复制进 agent 浏览器：真实二进制无头启动真实 Profile（junction 别名绕过 Chromium ≥136 默认目录 CDP 限制，同时满足 App-Bound Encryption 的路径绑定），CDP `Storage.getCookies` 读取、过滤、`Storage.setCookies` 写入持久 Profile。支持 `source/domains/profile/closeSource/dryRun`；源浏览器运行中可优雅关闭后导入（窗口下次启动恢复）；**导入前自动备份源 cookie 库，检测到清空自动还原**；cookie 值不进日志与输出。
- **空闲自动回收（#47，opt-in）**：新设置 `idleTimeoutMin`（默认 0 关）。N 分钟无 ego_* 调用后优雅 `--stop` 后台浏览器（实测空闲 ~425MB），下次调用 2-4s 冷启动。观看观察窗不算活动（设置文案已注明）。
- **观察窗「弹出窗口」按钮（#51）**：浮动面板与侧边栏 Tab 新增按钮，调用运行时 `ego-browser --open`——无头实例原地替换为同 Profile 有头窗口（标签页保留），有头则置前。无头模式的 CDP 预览本就可用的结论也已实测确认。

### 修复
- **滚动后 viewport 截图全白**（PR #50）：`Page.captureScreenshot` 的 clip 原点是文档坐标，viewport 截图原先固定 `{x:0,y:0}`，滚动后 clip 落在未绘制区域（`captureBeyondViewport: false`）得到空白图。现用 `pageInfo().sx/sy`（`scrollX/scrollY`）作为 clip 原点；locator 的 viewport boundingBox 同样加上滚动偏移，与 `spaces-server` followClip 一致。
- **聊天外链被观察窗抢走且无法渲染（#48）**：侧边栏 Tab 的 `urlTarget` 声明过宽（认领所有 http(s)），但该 Tab 只是推流画面。已移除声明，外链回归内置 browser 标签。
- **浏览器重启后 ego_* 全部报 task space not found**：插件侧记住的数字空间 id 在重启后悬空。新增 `runWithStaleSpaceRetry`：识别该错误后自动用空间名重建并重试一次（动作工具 + ego_cli/ego_captcha/ego_script 全覆盖）。
- **多会话时观察窗弹到错误会话（#53，PR #54）**：`markEgoToolCall` 携带调用会话 id，自动打开按会话作用域定位侧边栏；一次性守卫改为按会话，探测流常驻。

### 社区
- 合并 PR #50（截图修复，hpqc032）、#52（观察窗英文 i18n，M4cd1r；我们补了 `wt()` 默认值修复恢复 typecheck）、#54（会话作用域，xiaochaZ）。

## [0.8.4] - 2026-09-15 — 观察窗 worker 启动链修复 + 社区 PR 合并

### 修复
- **观察窗在 DSH ≥ 0.1.5 永不启动（#34 / #38 / #43）**：worker spawn 缺少 0.1.5 subprocess provider 必填的 `cwd`，异常被裸 `catch` 吞掉导致 `ensureWorker()` 永远返回 null。已补 `cwd`。
- **worker 启动即自杀（#34 缺陷2 / #40）**：`stopSiblingWorkers()` 的松散子串匹配把 DSH subprocess runner 误判为同侪 worker，`taskkill /T` 连带杀掉自己的进程树，worker 在写 `ego-cast.json` 前死亡。匹配收紧为「node 的直接脚本参数是 ego-cast-worker.mjs」并排除自身祖先进程链。
- **Electron 宿主（DSH Desktop）全部 ego_* 报 no @@DSH_RESULT@@（#42）**：spawn 传显式 env 时缺 `ELECTRON_RUN_AS_NODE`，子进程被当成第二个 Electron 应用启动。`resolveEgoEnv` 与 worker spawn 在 `process.versions.electron` 存在时自动补 `ELECTRON_RUN_AS_NODE=1`。
- **worker 宕机时 /api/ego/stream 空响应（#39，PR #44）**：`proxyWorkerStream(-1)` 短路为 quiet SSE（写 `text/event-stream` 头后保持安静长连接），不再触发 `ERR_SOCKET_BAD_PORT` 把连接撕掉；含 42 行新测试。
- **Windows 下 EGO_LINUX_HEADLESS 被静默忽略（#35）**：显式 `EGO_LINUX_HEADLESS=1` 现在优先于 win32 的 `hasDisplay=true` 默认推断，与 CLI help / README 文档一致。
- **无 dsh-better-sidebar 宿主 web boot 整体阻断**：client 静态 inject 列表移除 `betterSidebar`（loader 会永远等待缺失服务），改为 `ctx.get` 探测 + 浮动观察球立即挂载 + 服务后出现时经 `ctx.inject` 升级为侧边栏 Tab（致谢 PR #45 的方案）。

### 新增
- **`isolateSpaces` 任务空间沙盒隔离开关（PR #31）**：默认关闭，任务空间复用磁盘持久化 Profile，登录态跨重启永久保留（覆盖 #1 诉求）；开启后恢复内存沙盒隔离。`ego_space_open`/`ego_space_close` 工具描述随模式动态注入；修复 gateway 布尔设置无法持久化的问题。

### 其他
- 修复 `pnpm-workspace.yaml` 未填的 `allowBuilds` 模板占位符导致 pnpm 11 无法 install；补 `isolateSpaces` 的 config 测试夹具。
- 合并 PR #36（README 版本兼容矩阵）、#31、#44；关闭被覆盖的 #45。

## [0.8.3] - 2026-09-07 — DSH 0.1.2-rc.1 兼容 + 安全/稳定性修复

### 安全
- **修复无认证 `/api/ego/*` 路由**：exact 路由先于宿主 `/api` prefix 信任栅栏命中，导致 `GET /api/ego/stream` 无凭据流出实时画面帧、`POST /api/ego/input` 无凭据即可提交输入（跨站驱动）。统一包装 webServer.register，所有 ego 路由要求 SameSite=Strict 的 `dsh-auth-*` cookie，恶意网页天然不携带；守卫仅作用于本插件自身路由，不污染宿主单例上其他插件的注册。

### 修复
- **无 dsh-better-sidebar 宿主 client 启动失败（#29）**：hard-declared `inject` 与裸 `ctx.betterSidebar` 属性访问在 strict resolver 下抛 "without inject"。保留声明（它是解析条件）+ 将访问包进 try/catch 并显式传参，无 sidebar 宿主落到浮动观察球而非整包挂死。
- **Windows 冷启动回归**：#22 的 Xvfb 支持将无 `DISPLAY` 时默认由 headless 改为起 Xvfb，而 Windows 有桌面会话、无 Xvfb → "no X display / no Xvfb binary" 冷启动失败。`ensureXDisplay` 与入口 `hasDisplay` 增加 win32 分支（桌面会话视为 display，headed 直开窗口，恢复 v0.4.0 适配行为）。
- **gateway 设置白名单缺 `egoCliArgs`/`chromeArgs`**：`/ego/api/set` 把这俩配置字段静默丢弃，设置无法持久化——已补入 `ALLOWED_KEYS`。

### 合并(社区 PR + 本地)
- 合并 6 个社区 PR：`#20` root 运行支持、`#22` xvfb、`#16` macOS headless 检测、`#24` schemastery `link:` 修复、`#28` DSH 0.1.2-rc.1/v0.1.3-alpha.1 兼容（peer/engines 收紧）、`#13` Windows 稳定性。
- 修复 dsh-plugin.json 缺逗号导致的 manifest JSON 语法错误（目录收录阻断源）。
- 新增 MIT LICENSE；补充供应链/权限说明；源码不追踪 `*.map`。
- 通过 build-dsh-plugin 官方审计：`status: READY_FOR_PINNED_SOURCE_VERIFICATION`，`route: direct`，`blockers: 0`。

### 兼容
- `engines.dsh: >=0.1.2-rc.1`；peer 依赖全部锁定 `>=0.1.2-rc.1`。
- 已在 DSH 0.1.2-rc.1(Windows/web profile) 完成安装、启动、`ego_navigate` 真实调用、实时观察面板验收；`0.1.2-alpha.x` 声明可装但未实测；`<0.1.2-rc.1` 请用 v0.8.0 及更早。

## [0.8.1] - 2026-08-28 — DSH 0.1.2-alpha.1 兼容

### 变更
- **client 半体迁移到 `@deepseek-ai/dsh-client-store`**：0.1.2-alpha.1 把 `@deepseek-ai/dsh-client-runtime`（含 `/client` 子路径）重命名为 `@deepseek-ai/dsh-client-store`（客户端模块图以裸包名作为静态模块 id）。`createSnapshotStore` 签名不变。
- **client 模块注册 id = 声明包名 `dsh-ego-browser`**：0.1.2 的 boot manifest 行 id 按 package.json `name` 生成、且要求 loader 行规格名与之一致（`nearestPackage` 名相等校验）；以别名（`@dsh-external/ego-browser` junction 装载键）挂载会被扫描器判为 "not a client row" → 观察面板静默消失。tsdown 的 banner ID 与 `cordis.patch.yml` 行名统一为声明包名；`dsh-plugin.json` 中的 `dsh-ego-browser` 保持不变。
- **`dsh.client.inject` 只声明真实图行包**：0.1.2 下 `@deepseek-ai/dsh-client-store` / `@deepseek-ai/dsh-client-ui-slots` 是静态模块（不在模块图），声明为注入边会导致条目组合静默 pending（模块不物化、面板不挂载、无任何报错）。仅保留 locale / ui-settings-plugins 两个真实图行。
- **webServer 可选服务改用嵌套注入交付**：0.1.2 严格服务解析器对未声明注入的 `ctx.get('webServer')` 返回 undefined → 宿主 `/api/ego/*` 观察路由静默未注册 → 面板数据层 401/空态。改为 `ctx.inject(['webServer'], cb)`（服务到位才注册路由；无 web 服务器的 TUI/headless 宿主保持 tools-only 不阻塞）。
- **peer 依赖对齐 0.1.x 家族**（client-locale / client-ui-slots / client-ui-settings-plugins / dsh-settings / dsh-tools 声明 `>=0.1.1-rc.2`），`engines.dsh: >=0.1.2-alpha.1`。
- 修复后实测：client 模块正常物化、侧边栏「Agent 浏览器」Tab 与接管观看流程可用、`/api/ego/*` 路由 200、实时推流 `streaming`、画面点击/输入链路可达（pointerdown → `/api/ego/input` → CDP 派发）。

## [v0.8.0] - 2026-08

sidebar Tab 集成：当 `dsh-better-sidebar` 可用时，实时查看窗注册为 sidebar 原生 Tab 而非浮动浮窗。

### 新增
- **dsh-better-sidebar Tab 集成**：`apply()` 用 `ctx.get('betterSidebar')` 机会性探测 sidebar 服务（不用 `ctx.betterSidebar`——那要求 `inject` 声明，会把 sidebar 变成硬依赖，没装时整个插件含设置卡都不加载），可用时通过 `registerTab()` 注册一个 `ego-browser:watch` Tab（`single: true`，常驻），不可用时退回原有浮动浮窗。这是 DSH 文档化的可选服务消费模式（见 approval-seam 笔记、postmortem 0001）。
- **首次 ego_* 工具调用自动打开 Tab**：`defineEgoTool` / `ego_cli` / `ego_captcha` / `ego_script` 的 execute 路径调 `markEgoToolCall()` 递增 host 端计数器，该计数器随 `/api/ego/spaces` 响应下发。`LivePreviewController` 检测计数器 0 → >0 跳变时调 `ctx.get('betterSidebar').openTab({ type: 'ego-browser:watch' })`，Tab 自动展开。`autoOpened` 标志保证每会话只开一次。
- **React Tab 组件 `EgoBrowserTab`**：用 `React.createElement` + `bindSnapshotSelector` 渲染 sidebar Tab 内容（头部 / 标签栏 / 实时主视图 / 历史覆盖层 / 登录与验证码提示条）。历史浏览轨迹从原侧抽改为覆盖式（点历史按钮接管整个 Tab 内容区，点条目进入预览或返回实时），适配 sidebar 窄宽度。
- **`LivePreviewController` vanilla 类**：从浮动浮窗的命令式 DOM 代码中提取出轮询 / SSE / 帧缓存 / 缩放 / 输入坐标逆映射 / 自动跟随逻辑，供 React 组件通过 `subscribe`+`getSnapshot` 订阅、通过方法调用转发 pointer/wheel 事件。控制器直接持有 `<img>` ref 以 rAF 合帧频率原地替换 `src`，不触发 React 逐帧重渲染。
- **`dsh-better-sidebar` 不列为 peer 依赖**：用 `ctx.get()` 机会性消费，不需要声明 `inject`，因此也不需要把它列为 peer。装了 sidebar 就用 Tab，没装就退回浮动浮窗，两种部署都干净。

### 设计取舍（诚实说明）
- **混合而非完全重写**：React 负责 UI 结构（头部 / 标签 / 提示条 / 历史覆盖层），vanilla 控制器负责实时帧管道（SSE / rAF 合帧 / 坐标逆映射 / 输入转发）。~1000 行脆弱的实时流逻辑未用 React hooks 重写，降低回归风险。
- **历史轨迹覆盖式**：原浮动浮窗的侧抽设计在 sidebar 窄宽度（~300-400px）下两列都很窄，改为覆盖式后空间利用最好。
- **竞态条件（已知，可接受）**：若 `dsh-better-sidebar` 在 ego-browser 之后加载，`apply()` 运行时 `ctx.betterSidebar` 可能仍为 `undefined`，此时退回浮动浮窗。DSH 模块加载器通常按依赖顺序加载，sidebar 作为基础 UI 插件一般先加载；若不然，刷新页面即可。
- **浮动浮窗代码原样保留**：`mountFloatingWatch()` 是原 effect body 的机械移动，未做逻辑改动，确保无 sidebar 时的体验与 0.7.x 完全一致。


观察窗落地双画面管线：修复 CDP 协议根因，并加入可选 FFmpeg H.264/fMP4 后端。

### 修复
- **`dsh-plugin.json` 的 `version` 与 `package.json` 重新对齐**：0.8.5→0.8.6 的发版只改了 `package.json`，已发布的 0.8.6 tarball 里这个字段仍是 `0.8.5`（0.8.4 时犯过同一个错并单独修过）。DSH 0.1.7 的插件管理器读 `package.json` 的 `dsh` 字段、从不读这个文件，所以对运行没有任何影响，纯清单卫生问题。已加 `tests/manifest-consistency.test.ts` 把两者钉死（连同「CHANGELOG 里必须有当前版本号」和「`id` 与包名一致」）。

### 新增 / 优化
- **用户自定义启动参数**：设置卡新增 `ego-browser CLI 附加参数` 与 `Chrome 启动附加参数` 两个字段。前者追加到 `ego-browser nodejs` argv，下一次 `ego_*` 工具调用即生效；后者经 `EGO_LINUX_EXTRA_ARGS` 桥接到 vendored runtime 的 `launch()`，仅浏览器下次冷启动生效（浏览器是单例常驻——需 `ego-browser --stop` 或重启 DSH 才会重新启动）。两边都拉黑会破坏插件自管控制面的标志（`--status`/`--stop`/`--help`/`--user-data-dir`/`--remote-debugging-port`/`--headless`/`--proxy-server` 等）；`--proxy-server` 请走 `EGO_LINUX_PROXY`。`ego_doctor` 报告当前生效参数。
- FFmpeg 改为显式按需安装：CDP 不再依赖或安装 `ffmpeg-static`。设置页优先检测自定义路径、系统 PATH 和托管缓存，兼容性检查完成前禁用 FFmpeg 选项，并提供固定版本、SHA-256 校验的一键下载。
- 新增 `githubMirror`，用用户填写的 HTTPS 基址替换 `https://github.com`；Windows/Linux 固定 BtbN release tag，macOS 固定平台资产。下载进入 `~/.dsh/cache/ego-browser/ffmpeg/` 临时目录，校验、解压和能力探测全部成功后才原子发布。
- 观察画面新增局部键盘输入代理：普通文本和粘贴走 `Input.insertText`，中文 IME 在 composition 完成后一次发送，控制键和快捷键走 `Input.dispatchKeyEvent`。只在点击观察画面后聚焦，不抢 DSH 自身输入。
- 新增 `ffmpegBitrateKbps` 设置（500-20000 kbps）；低/平衡/高档默认 2000/4000/8000 kbps。编码器使用目标码率、峰值码率与 VBV buffer，替代 `h264_mf` 的约 200 kbps 默认值和 `libx264 crf=28`。
- DSH 窗口进入后台时保持 watch/SSE/video 连续；lease TTL 提高到 120 秒，并对 start/switch/renew 请求做单飞去重，避免后台定时器节流造成 capture 过期和反复 `starting`。
- `CaptureManager` + watcher lease：同时只有一个活动后端和一个观看 target；面板隐藏后停止 capture。
- CDP 后端正确区分 frame ACK ID 与 flattened target session，协议错误可见；默认 20 FPS、latest-frame 限流、单 target backstop，删除透明动画强制重绘。
- FFmpeg 后端：Windows 使用 `gfxcapture(hwnd)` 直接采集 Chrome 的 D3D11 窗口 surface，其他平台保留显示来源 crop；编码为 H.264 fragmented MP4，经二进制 HTTP 与 MediaSource 播放，generation 隔离旧进程数据。
- 新设置：`captureBackend`、画质档位、CDP/FFmpeg FPS、最大宽度和编码器；旧字段集中迁移。
- 新增 MP4 parser、CDP ACK、CaptureManager、配置迁移和平台 argv 单元测试。

### 平台限制
- Windows 要求 FFmpeg 包含 `gfxcapture`；按 browser PID、target title 和 CDP window bounds 匹配 HWND，窗口被遮挡或移动时仍采集目标页面，且禁止回退到 `gdigrab desktop`。最小化行为仍由 Windows Graphics Capture 决定。
- Linux X11 使用 `x11grab`、macOS 使用 `avfoundation` display crop；遮挡和系统权限仍会影响这两个平台。
- Wayland 随包 FFmpeg 无可用 Portal/PipeWire 输入时明确报 `unsupported-ffmpeg-pipewire`，不使用 root `kmsgrab`，不静默切换整个桌面或伪装成功。

### 修复
- **偶发鼠标完全无请求 / 键盘始终不可用**：控制面不再依赖 `streamState` 或 spaces 同步，只按当前画面 target 发送；worker 继续做最终 stale-target 校验。此前前端没有任何键盘监听或协议支持，本次补齐 text/keyDown/keyUp 全链路。
- **FFmpeg 实际运行但 Tab 显示 CDP**：capture 状态统一从 SSE、watch 响应、spaces capture 和 watch/status 收敛；缺少 backend 时保留当前值，禁止默认覆盖为 CDP。
- **`space_open` 后遗留 about:blank 窗口**：成功打开的 task space 成为最近活动空间；后续省略 `space` 的 navigate/click/fill 等工具复用该空间，不再回退到固定 `dsh-agent` 创建第二个窗口。关闭活动空间后恢复配置默认值。
- **watch/start 502 与 input 500**：FFmpeg 二进制和 `gfxcapture` 能力探针改为异步子进程，启动期间 worker health 不再被阻塞；watch start/switch 的 worker 代理超时提高到 30 秒，覆盖窗口、编码器和 MP4 init 的完整上限。host 原样透传 worker HTTP 状态和 JSON 错误，仅在 worker 真不可达时返回 502。输入在客户端和 worker 双侧校验 target，失效 target 返回 409 `capture-target-stale`，不再包装成 500。
- **设置已选 FFmpeg 但 Tab 仍显示 CDP**：多 fiber 同时加载插件时，后注册的 settings bridge 遇到 namespace 重复后错误地退回空 composition config，cast worker 因而收到 `captureBackend:auto`。现在同一 settings 服务共享唯一 scope；设置卡、gateway 和 cast-server 始终读取同一持久化配置。空闲 worker 收到配置更新时也会立即发布新的 backend 状态，不再保留旧 CDP 标签。
- **Windows FFmpeg 不再录到用户前台窗口**：此前参数固定为 `gdigrab ... -i desktop`，只在启动时按页面坐标裁剪，Chrome 进入后台后会把覆盖区域中的 DSH 或其他应用串流出去。现在 target 先经 `Browser.getWindowForTarget` 和 Win32 顶层窗口枚举解析到 HWND，再用 `gfxcapture` 捕获独立窗口 surface；多任务空间的不同 Chrome 窗口分别绑定不同 HWND。同一窗口中的后台 tab 会报 `ffmpeg-target-not-visible`，不会展示错误 tab 或主动抢焦点。
- Windows 编码优先 `h264_mf` D3D11 硬件路径；编码器探针使用真实 HWND 管线，避免软件测试帧误判硬件编码不可用。显式 `fps/setpts` 固定 30 FPS，fMP4 分片降为 100ms，并用 `skip_trailer` 避免优雅停止时的 `mfra` parser 错误。
- **登录态跨 DSH 重启保持（复刻原版 ego-lite 哲学）**：此前手动重启 / 强杀 DSH 后需重新登录——worker 收到 SIGTERM/SIGINT 时只 detach 不落盘，且插件卸载的 `--stop` 宽限 4s 不够、常落到 SIGTERM crash 兜底。现在 worker 退场前先对浏览器发 CDP `Browser.close`（优雅关闭，Cookie journal 合并进磁盘 profile），插件 teardown 宽限提到 8s 足够优雅关完。**实测**：优雅重启登录完全保留；强杀（SIGKILL）长期登录态也已落盘、重启能读回。

### 工程重构
- **纯 JS → TypeScript 迁移**（PR #14）：源码从 `lib/` 移至 `src/`（`src/index.ts` 工具层、`src/client/index.ts` 前端、`src/worker/ego-cast-worker.ts` worker），`lib/` 与 `bin/ego-cast-worker.mjs` 改为构建产物（预构建入库）。构建链路改 `pnpm typecheck`（tsc 类型门禁，tsconfig.json + tsconfig.client.json）+ `pnpm test`（vitest）+ `pnpm run build`（tsdown 三 bundle）。测试同步迁移 `tests/*.test.mjs` → `.test.ts` 并补 `vitest.config.ts`。`lib/` 不再手改。

## [v0.7.1] - 2026-08

修复版本：单次 `ego_space_open` 不再开两个浏览器窗口。

### 修复
- **`ego_space_open` 不再开两个浏览器窗口**：此前 launch 时把 `"about:blank"` 作为位置参数传入，会在默认 browser context 开一个残留 tab；而 `ego_space_open` 走 `useSpace+ensureRealTab`，在自己的 browser context 里再开一个 tab——Chrome 把不同 context 隔离到独立窗口，用户就看到了两窗。现在 `LAUNCH_FLAGS` 加 `--no-startup-window`、`launch()` 不再传位置 URL，启动即零 tab；第一个 tab 由 `ego_space_open`（或任何走 `useSpace+ensureRealTab` 的结构化 `ego_*` 工具）在自己的 context 中创建，这是用户唯一看到的窗口。旧注释称 `--no-startup-window` 会破坏所有 `page.*` 操作——那是引入 `useSpace+ensureRealTab` 路由之前的结论，对结构化工具不再成立。**已知回归（可接受）**：`ego_cli` / `ego_script` 中如果 heredoc 直接调 `page.*` 而不先 `taskSpaces.useOrCreate`，现在会抛 `"no active tab to attach session"`，错误信息明确，且推荐用法不受影响。

## [v0.7.0] - 2026-08

小版本更新：观察窗状态灯呼吸效果 + 前端内存治理 + 工具超时/跨平台修正。

### 新增
- **观察窗状态灯呼吸效果**：FAB 角标绿点在 agent 实际驱动浏览器（`busy`）时常绿，空闲（浏览器开着、无操作）时呼吸（2.4s 周期性绿光晕）；面板「正在实时浏览」状态点同步 busy/呼吸逻辑。原「busy=黄、idle=绿」语义翻转为「干活常绿、不干活呼吸」。

### 修复
- **`ego_script` 的 `timeoutMs` 参数此前被忽略**：schema 声明的每次运行超时覆盖从未生效，所有运行一律采用插件默认 15s 宽限。现已贯穿 `runEgoScript`，传 `timeoutMs` 真正起作用，缺省/非法时回落默认。
- **前端内存治理**：观察窗 `frameCache`（各标签最新一帧 JPEG dataURL）与 `pageMeta` 按 `targetId` 无限累积，长会话/多标签会缓慢泄漏。现在按当前存活标签表剪除已关闭标签的缓存，并给 `frameCache` 加 `MAX_CACHED_FRAMES=12` 最旧优先上限兜底。
- **硬编码 `/root` 家目录回退改为 `os.homedir()`**：状态路径探测中 POSIX 默认家目录由环境相关的 `/root` 改为跨平台正确的 `os.homedir()`，消除非 root 用户/容器环境的隐患。

### 工程
- 新增 `.gitattributes`：统一 LF 换行（`* text=auto eol=lf`），消除 Windows 侧 `core.autocrlf` 造成的工作树 CRLF 抖动与 diff/cp 误判。

## [v0.6.1] - 2026-04

修复版本：自愈链路 + 观察窗 worker 稳定性、面板引导条可用性。

### 修复
- **插件卸载不再阻塞宿主退出 / 破坏自愈**：`ctx.effect` teardown 由 `await ego-browser --stop`（15s 宽限，拖住宿主退出）改为 fire-and-forget，宿主可被 `dsh-web-guard` 在 10s 内干净拉起、被中断 turn 自动续接。
- **观察窗 worker 单实例守卫 + stale 状态清理**：同一份 `ego-cast-worker.mjs` 可能同时从安装目录与 dev 克隆被拉起、且 `ensureWorker` 在已知 pid 失效时会再拉起一个，导致 `ego-cast.json` 恒指向已死/滞后的 worker、面板失去推流。现在 worker 启动即枚举并停止其他同名进程（Windows 经 `powershell -EncodedCommand`，POSIX 走 `ps`），并删除 stale 的 `ego-cast.json`，让本进程 `{port,pid}` 成为唯一权威。
- **登录 / 人机验证引导条支持手动关闭**：新增 × 按钮；两条引导条互斥显示（人机验证优先），不再"关不掉"或"双条叠加压缩画面"。
- **观察窗主动跟随 agent 正在操作的页面**：此前面板用"最后一次重绘"(lastActive) 当作当前页，后台动画/视频页重绘会抢占视图，agent 切页时主画面不跳转。现 worker 经 DevTools `/json/list` 取浏览器 MRU 激活 tab（与 ego runtime `tabs.mjs` 同源判定），在 `/api/spaces` 与 SSE 中都标记 `active: true` 并排第一；前端 auto-follow 仅跟随激活页、忽略后台重绘帧。

## [v0.6.0] - 2026-04

代码健康治理（工程收敛）。

- 消除构建覆盖炸弹：删除过时的 `src/`（561 行旧版）与 `tsconfig.json`，确立 **`lib/` 为唯一权威源**。`npm run build` 由「tsc 编译 src→lib（会导致旧版覆盖、工具全丢）」改为「对 `lib/` 做语法校验（`node --check`）」。
- 统一工具注册：`ego_captcha` / `ego_help` / `ego_doctor` / `ego_script` 改为与其他工具一致的 `withEgoLock` + 冷启动重试路径（并发安全）。
- 不再分叉：新增能力（下载捕获、人机验证检测、30+ 工具）以 `lib/` 为准。

## [v0.5.0] - 2026-04

实时推流 + 监控窗直接操作浏览器。

- 修复实时推流关键 bug：`screencastFrame` 匹配错误字段，实时帧从未真正经 SSE 推送。已修正，动态页面接近 10~30fps 推帧。
- cast-server 流式转发改用 `node:http`（fetch 对 chunked 响应缓冲导致首帧延迟）。
- 监控窗鼠标直接操作 agent 浏览器：滚轮滚动、点按/拖动点击真实浏览器（`/api/ego/input` → CDP `Input.dispatchMouseEvent`），Ctrl+滚轮缩放、Ctrl+拖动平移、双击复位，坐标按真实视口逆映射含 letterbox 校正。
- 新增 `/api/ego/stream`（SSE）实时帧 + 页面列表。
- 登录引导条 +「已登录，保存」（触发 `/api/ego/flush` 落盘）；修复 `ego_auth_flush` Windows 状态目录路径。

## [v0.4.0] - 2026-04

跨平台（Windows 适配落地）。

- Windows 原生支持：`IS_WIN` + `windowsChromeCandidates()` 自动探测 Chrome/Edge/Brave 安装目录与 `PATH`/`%PATHEXT%`。
- 注入服务改为 `webServer`/`httpServer` 二选一，Windows 也能挂载观察窗。
- 状态路径跨平台：Windows 用 `%LOCALAPPDATA%\ego-lite-linux`，POSIX 用 `$XDG_STATE_HOME/ego-lite-linux`。

## [v0.3.0] - 2026-04

修复与增强。

- 冷启动自动重试：每个 `ego_*` 动作新起 `ego-browser` 子进程，会话预热期偶发 `CDP channel is not open` / DevTools 超时。内置最多 3 次逐步退避重试，仅对瞬时冷启动错误重试，真错误立即透传。

## [v0.2.0] - 2026-04

亮点：实时观察前端口。

- `lib/client.js`：深色毛玻璃 UI，右下角 🌐 小球常驻，点开见 agent 实时画面。
- 标签管理：横排标签条 + 每标签 `×` 关闭（真正关浏览器标签）。
- 缩放/拖拽/复位、动态轮询（活跃 2s / 静止 8s）、导航复用 tab。
- `bin/ego-cast-worker.mjs`：attach 到 agent 正在用的浏览器，CDP 实时推帧，崩溃自动重启。
- 开箱即用：`bin/ego-chrome-wrapper.sh` 随包自带，root/无头自动 `--no-sandbox`。
