# Changelog

所有对用户可见的变更集中在各版本号下。格式遵循 [Keep a Changelog](https://keepachangelog.com/)，版本语义遵循 [SemVer](http://semver.org/)。

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

## [Unreleased]

观察窗落地双画面管线：修复 CDP 协议根因，并加入可选 FFmpeg H.264/fMP4 后端。

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
