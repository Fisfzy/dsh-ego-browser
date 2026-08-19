# runtime/ — vendored 运行时本地改动记录

本目录来自 [CitroLabs/ego-lite](https://github.com/CitroLabs/ego-lite)（MIT，含 Linux 移植 PR #234
与本地代理补丁），在首次 vendoring 提交 `a77dee4` 时整体引入。**只读参照**为主。

> 排查/跟进上游前先看这里：如果一项改动只在下面列出，说明它相对上游是我们或本仓库维护引入的；
> 没列出的文件 = 与 vendored 时一致（它们可能本就是这个 Linux 移植自带的本地化）。

## 明确的本地改动（相对 vendored 基线）

| 文件 | 改动 | 原因 / 提交 |
|---|---|---|
| `runtime/ego-linux/src/cursor.mjs` | 光标覆盖层默认名 `Claude` → `DeepSeek`（4 处：默认值 + 注释） | 品牌统一，`dacbd47` |
| `runtime/ego-linux/src/chrome.mjs` | `resolveBinary()`: `candidate.includes("/")` → `isAbsolute(candidate)`；`which()`: Windows 用 `where` 替代 `which` | Windows 支持：POSIX `includes("/")` 不识别 `C:\\` 路径，`which` 在 Windows 不存在 |
| `runtime/ego-linux/src/chrome.mjs` | `LAUNCH_FLAGS` 加 `--no-startup-window`；`launch()` 删除 `"about:blank"` 位置参数 | 消除单次 `ego_space_open` 开两个窗口：原位置参数在默认 browser context 开残留 tab，space tab 走独立 context 又开一个窗口，Chrome 把不同 context 隔离到不同窗口 → 用户看到两窗。`useSpace+ensureRealTab` 路由下不再需要 launch 残留 tab |
| `runtime/ego-linux/src/paths.mjs` | Windows 用 `%LOCALAPPDATA%\\ego-lite-linux` 作为 DATA_DIR / STATE_DIR；`CHROME_CONFIG_CANDIDATES` 加 Windows 路径 | Windows 支持：XDG 变量在 Windows 不存在；`ego_doctor` 已预期 `%LOCALAPPDATA%` |
| `runtime/ego-linux/bin/ego-browser.mjs` | headless 判定加 `hasDisplay`：有可用 X display（如 Xvfb）时忽略继承的 `EGO_LINUX_HEADLESS=1`，跑 headed | watch 面板全帧率 + ffmpeg x11grab 后端能抓到画面：headless 走 swiftshader ~1fps 且不渲染到 X display（x11grab 抓黑屏）。PR #10 曾回退此逻辑（只认 env），已重新移植（2026-08-18） |
| （其余 runtime 文件）| 与 vendoring 时一致 | 无后续本地改动 |

## 说明
- `chrome.mjs` 里的代理支持（`EGO_LINUX_PROXY`）在首次 vendoring 时已包含（本 Linux 移植特性），
  非后续本地改动；如需调整走它。
- **同步提醒**：`lib/index.js` 与 `bin/ego-cast-worker.mjs` 各有一份 humanCheck 探针（逻辑相似）——
  若改探针特征，两处都要同步。
- 若要跟进 ego-lite 上游，重点 diff 上表的 cursor.mjs；其余文件可直接与上游对齐。
