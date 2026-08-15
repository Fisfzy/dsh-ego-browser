# Changelog

所有对用户可见的变更集中在各版本号下。格式遵循 [Keep a Changelog](https://keepachangelog.com/)，版本语义遵循 [SemVer](http://semver.org/)。

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


