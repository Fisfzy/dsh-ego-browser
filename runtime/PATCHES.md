# runtime/ — vendored 运行时本地改动记录

本目录来自 [CitroLabs/ego-lite](https://github.com/CitroLabs/ego-lite)（MIT，含 Linux 移植 PR #234
与本地代理补丁），在首次 vendoring 提交 `a77dee4` 时整体引入。**只读参照**为主。

> 排查/跟进上游前先看这里：如果一项改动只在下面列出，说明它相对上游是我们或本仓库维护引入的；
> 没列出的文件 = 与 vendored 时一致（它们可能本就是这个 Linux 移植自带的本地化）。

## 明确的本地改动（相对 vendored 基线）

| 文件 | 改动 | 原因 / 提交 |
|---|---|---|
| `runtime/ego-linux/src/cursor.mjs` | 光标覆盖层默认名 `Claude` → `DeepSeek`（4 处：默认值 + 注释） | 品牌统一，`dacbd47` |
| `runtime/ego-linux/src/cursor.mjs` | `renderOverlay()` 开头加守卫：`document.contentType` 非 `text/html` / `application/xhtml+xml` 时**不注入覆盖层**，并清掉上一个文档可能残留的 host | 用户报告"页面全是乱码"：JSON / 纯文本 / XML / PDF 标签页是整片密集字形，磨砂徽标（`#badge` 带 `backdrop-filter: blur(14px)`）叠上去糊成一团，观感即乱码。`highlight()` 的阅读高亮最终同样经 `renderOverlay` 绘制，因此一处守卫即覆盖两条路径 |
| `runtime/ego-linux/src/cursor.mjs` | `#arrow` 规则去掉 `display:block`（几何/动效保留），可见性统一交给 `svg.shape{display:none}` / `svg.shape.on{display:block}` | 用户报告"虚拟鼠标箭头和小手叠在一起"：`#arrow` 是 ID 选择器，其 `display:block` 压过 `svg.shape` 的 `display:none`，于是 `showShape()` 切到 `hand`/`beam` 后箭头仍然绘制，箭头与手形同点重叠 |
| `runtime/ego-linux/src/chrome.mjs` | `resolveBinary()`: `candidate.includes("/")` → `isAbsolute(candidate)`；`which()`: Windows 用 `where` 替代 `which` | Windows 支持：POSIX `includes("/")` 不识别 `C:\\` 路径，`which` 在 Windows 不存在 |
| `runtime/ego-linux/src/chrome.mjs` | `stopBrowser()` 在浏览器确实已停止（或本来就没在跑）后调用新增的 `clearSessionRestore()`，删除 `<profile>/Default/Sessions/`；`clearSessionRestore` 导出以便测试 | issue #67：idle reaper 的 `--stop` 被 Chrome 记为 crash，`Sessions/` 残留，下次冷启动即使带 `--hide-crash-restore-bubble` 也会静默恢复上一轮全部标签；这些恢复页不在 `state.spaces` 里，`pruneIdle`/`pruneAbandoned`/`--prune-spaces` 三套清扫都扫不到 → reaper 回收内存、Chrome 又复活标签。登录态在 `Network/Cookies`，删除 `Default/Sessions` 只丢标签恢复数据 |
| `runtime/ego-linux/src/chrome.mjs` | `clearProfileLock()` 增加 win32 分支：新增 `killWindowsProfileOwners()`（PowerShell 枚举 chrome.exe 命令行含本 profile 的进程 → 先收集后终止 → 500ms 释放等待，10s 硬上限），并删除 `lockfile`；POSIX 路径不变。`clearProfileLock` 导出以便测试 | issue #70：Windows 上 Chrome 不写 `SingletonLock` 符号链接（只留空 `lockfile`），旧实现 `readlink()` 抛 ENOENT 直接 return false → 孤儿 Chrome 永久占住 `--user-data-dir`，此后每次启动都被转交给幸存进程、`waitForEndpoint()` 耗尽 20s 超时，只能重启机器恢复。按命令行过滤，绝不误杀用户自己的 Chrome |
| `runtime/ego-linux/src/chrome.mjs` | `LAUNCH_FLAGS` 加 `--no-startup-window`；`launch()` 删除 `"about:blank"` 位置参数 | 消除单次 `ego_space_open` 开两个窗口：原位置参数在默认 browser context 开残留 tab，space tab 走独立 context 又开一个窗口，Chrome 把不同 context 隔离到不同窗口 → 用户看到两窗。`useSpace+ensureRealTab` 路由下不再需要 launch 残留 tab |
| `runtime/ego-linux/src/chrome.mjs` | `launch()` 的 `args` 末尾 spread `filterChromeArgs(process.env.EGO_LINUX_EXTRA_ARGS ?? "")`；新增模块内 `CHROME_BLOCKED` 集合 + `tokenizeArgs`/`filterChromeArgs` 函数（与 `lib/config.js` 镜像，runtime 不 import lib/） | 用户自定义 Chrome 启动参数（设置字段 `chromeArgs`）：插件 `resolveEgoEnv` 把 `chromeArgs` 桥接到 `EGO_LINUX_EXTRA_ARGS`，runtime 切分 + 拉黑控制面标志（`--user-data-dir`/`--remote-debugging-port`/`--headless`/`--proxy-server` 等）后 spread 进 Chrome argv。仅浏览器下次冷启动生效 |
| `runtime/ego-linux/src/paths.mjs` | Windows 用 `%LOCALAPPDATA%\\ego-lite-linux` 作为 DATA_DIR / STATE_DIR；`CHROME_CONFIG_CANDIDATES` 加 Windows 路径 | Windows 支持：XDG 变量在 Windows 不存在；`ego_doctor` 已预期 `%LOCALAPPDATA%` |
| `runtime/ego-linux/bin/ego-browser.mjs` | headless 判定加 `hasDisplay`：有可用 X display（如 Xvfb）时忽略继承的 `EGO_LINUX_HEADLESS=1`，跑 headed | watch 面板全帧率 + ffmpeg x11grab 后端能抓到画面：headless 走 swiftshader ~1fps 且不渲染到 X display（x11grab 抓黑屏）。PR #10 曾回退此逻辑（只认 env），已重新移植（2026-08-18） |
| `runtime/ego-linux/bin/ego-browser.mjs` | 显式 `EGO_LINUX_HEADLESS=1/true/yes/on` 现在优先于 `hasDisplay` 推断（含 win32）；未设置时维持原 hasDisplay 逻辑 | issue #35：此前 win32 硬编码 `hasDisplay=true` 导致显式设置的环境变量被静默忽略，与 CLI help / README 文档矛盾 |
| `runtime/ego-linux/src/chrome.mjs` | win32 上首次显示尝试失败后**不再回退 Xvfb**，直接抛真实 launch 错误；POSIX 保留原回退逻辑 | issue #56 恢复路径：常驻进程在浏览器被停后尝试重建，Windows 没有 X server 也没有 Xvfb，原回退会先等 `spawnXvfb` 的 X socket（10s+）再失败，超过插件 15s grace → 请求超时且错误不可读。快速失败让插件立刻走一次性 spawn 的带重试恢复路径 |
| `runtime/ego-linux/src/chrome.mjs` | `ensureXDisplay()` 平台豁免 `win32` → `win32 \|\| darwin`，伪 display 名改为 `${process.platform}-desktop` | macOS 支持（#65）：macOS 的 GUI 是 Aqua/Quartz、永不导出 `$DISPLAY`，而 Xvfb 属 X11 生态、macOS 无对应物，headed 路径于是必然抛 `no X display (DISPLAY is not set) and no Xvfb binary on PATH`。Chrome 在 darwin 经 Cocoa/WindowServer 开窗、从不读 `DISPLAY`（它只在 `spawnAndAwait()` 被塞进子进程 env），给伪值无副作用——与既有 win32 分支同构。真机实测（macOS arm64 + Chrome 154，冷启动）：navigate / screenshot / doctor 全通 |
| `runtime/ego-linux/src/transport.mjs` | 返回对象新增 `isOpen()`（`!closed && socket.readyState === WebSocket.OPEN`） | issue #56：`--serve` 常驻进程需要在每个请求前判断 CDP socket 是否还活着（浏览器被 idle reaper/崩溃停掉后 socket 关闭），否则后续请求全部报 "CDP channel is not open" |
| `runtime/ego-linux/bin/ego-browser.mjs` | `--serve` 循环：请求前检查 `shim.cdp.isOpen()`；已关闭则立即回 `{"ok":false,"error":"browser is not reachable: CDP channel is closed (the browser stopped)"}`，不在长驻进程内重建 shim | issue #56：从长驻进程里重新 `ensureBrowser` 拉起 Chrome 不可靠（旧实例仍在退出、`waitForEndpoint` 20s 会超过调用方 grace），且错误无法被调用方识别为重试安全。立即返回 "browser is not reachable"（插件冷启动签名）→ 插件回收常驻进程并用一次性 spawn（自带 launch 重试）恢复，下一次调用再起新常驻进程 |
| `runtime/ego-linux/src/task-spaces.mjs` | `reconcile()` 增加孤儿 page target 清扫：新增导出 `selectOrphans()`（两阶段 + 120s 宽限；跳过 `about:blank`/`chrome://`，按 space 的 `targetIds` 认领），命中后 `Target.closeTarget` 并记入 `closedSpaces`（名 `(orphan tab)`）；状态文件新增 `orphans: { targetId: firstSeenMs }` | issue #67 的另一半：crash-restore 或手动打开的标签不属于任何 space，原有 `pruneIdle`/`pruneAbandoned`/`--prune-spaces` 都只遍历 `state.spaces`，扫不到这些孤儿 → 标签只增不减。两阶段设计让"刚创建/正在查看"的标签不会在第一次出现时被误关 |
| `runtime/ego-linux/src/task-spaces.mjs` | `createSeededContext()` 增加 `EGO_ISOLATE_SPACES` 环境变量开关支持；未开启（默认）时返回 `null` 复用磁盘 Profile，开启时保留原作者内存沙盒隔离 | 登录态持久化与沙盒隔离双模可配：用户在设置中选择是否开启空间隔离；默认关闭时所有登录态直接落盘，跨关机重启永久保留，开启时恢复独立内存沙盒 |
| `runtime/ego-browser/screenshot-clip.mjs` + `runtime/ego-browser/dist/out/index.js` `screenshot()` | viewport / locator 截图的 CDP clip 原点改为 `pageInfo().sx/sy`（`scrollX/scrollY`），不再固定 `{x:0,y:0}`；fullPage 仍从文档原点截整页 | CDP clip 是文档坐标且默认 `captureBeyondViewport:false`：滚动后 clip 落在未绘制区域会得到空白 PNG。与 `spaces-server.mjs` followClip 同一约定 |
| （其余 runtime 文件）| 与 vendoring 时一致 | 无后续本地改动 |

## 说明
- `chrome.mjs` 里的代理支持（`EGO_LINUX_PROXY`）在首次 vendoring 时已包含（本 Linux 移植特性），
  非后续本地改动；如需调整走它。
- **同步提醒**：`lib/index.js` 与 `bin/ego-cast-worker.mjs` 各有一份 humanCheck 探针（逻辑相似）——
  若改探针特征，两处都要同步。
- **同步提醒**：`lib/config.js` 的 `tokenizeArgs`/`filterArgs`/`CHROME_BLOCKED` 与 `runtime/ego-linux/src/chrome.mjs` 的 `tokenizeArgs`/`filterChromeArgs`/`CHROME_BLOCKED` 是镜像副本（runtime 不 import lib/）——改一处必须同步另一处。
- 若要跟进 ego-lite 上游，重点 diff 上表的 cursor.mjs；其余文件可直接与上游对齐。
