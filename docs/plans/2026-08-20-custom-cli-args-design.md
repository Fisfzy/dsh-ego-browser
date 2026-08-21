# 自定义 CLI 启动参数 — 设计文档

> 日期：2026-08-20｜分支：`feat/custom-cli-args`（基于 `origin/master` @ `f83f08d`）

## 目标

允许用户在 ego-browser 设置面板中追加两类启动参数：

1. **ego-browser CLI 参数**（如 `--sdk-path <file>`）——拼到 `runEgoScript` 的 `argv` 末尾，每次 `ego_*` 工具调用即生效。
2. **Chrome 浏览器启动参数**（如 `--proxy-server=...`、`--disable-features=...`）——经 env 桥接到 vendored runtime 的 `chrome.mjs::launch()`，拼到 Chrome `args` 末尾，仅在浏览器下次冷启动时生效（浏览器是单例常驻进程）。

## 背景

- `runEgoScript`（`lib/index.js:386`）当前固定 argv = `[node, egoBin, "nodejs"]`，无扩展点。
- `chrome.mjs::launch()`（`runtime/ego-linux/src/chrome.mjs:375`）的 `args` 数组由 `LAUNCH_FLAGS` + profile/port/headless/proxy 组成，无用户扩展点；`EGO_LINUX_PROXY` 是已有的 env 桥接先例。
- vendored runtime 已经被本地补丁（见 `runtime/PATCHES.md`），新增一处补丁符合既有做法。

## 方案

### 字段（`lib/config.js`）

新增两个 `z.string()` 字段，默认 `""`：

| 字段 | 作用 | 生效时机 |
|---|---|---|
| `egoCliArgs` | 追加到 `ego-browser nodejs` argv 末尾 | 下次 `ego_*` 工具调用 |
| `chromeArgs` | 经 `EGO_LINUX_EXTRA_ARGS` 桥接到 Chrome 启动 args | 浏览器下次冷启动 |

### 安全护栏

**ego-CLI 侧拉黑**：会抢在 heredoc 前退出的子命令/帮助开关——
`--status`、`--stop`、`--open`、`--spaces`、`--spaces-daemon`、`--prune-spaces`、`--import-chrome-profile`、`--install-desktop-entry`、`--help`、`-h`。
（`--headless` 与 `--sdk-path` 允许，但 `--headless` 已由 `EGO_LINUX_HEADLESS` 管理，hint 提示用户优先走 env。）

**Chrome 侧拉黑**：插件自管的控制面标志——
`--user-data-dir`、`--remote-debugging-port`、`--remote-allow-origins`、`--headless`、`--no-startup-window`、`--proxy-server`、`--proxy-bypass-list`。
（这些已由 `LAUNCH_FLAGS`/`EGO_LINUX_PROXY` 接管，用户重写会破坏 CDP 控制与 profile 隔离。`--proxy-server` 走 `EGO_LINUX_PROXY`。）

切分采用 shell-like tokenize（单/双引号、反斜杠转义），与 `EGO_LINUX_PROXY` 等 env 值不切分的语义不同（那是一整个值，这里是一串参数）。

### 改动清单

| 文件 | 改动 |
|---|---|
| `lib/config.js` | `Config` 加 `egoCliArgs`/`chromeArgs` 字段；`resolveConfig` 带默认 `""`；新增导出 `tokenizeArgs`/`EGO_CLI_BLOCKED`/`CHROME_BLOCKED` 供测试 |
| `lib/index.js` | `settingKeys` 加两项；`cfg` 加两个 live getter；`runEgoScript` argv 追加切分后的 `egoCliArgs`；`resolveEgoEnv` 设 `EGO_LINUX_EXTRA_ARGS`（仅当非空） |
| `runtime/ego-linux/src/chrome.mjs` | `launch()` 的 `args` 末尾 spread `EGO_LINUX_EXTRA_ARGS` 切分结果（复用与 lib 侧一致的 tokenize；为避免在 runtime 里再引一份实现，把 tokenize 放在 runtime 内的小函数） |
| `lib/client.js` | 设置表单加两个 `SettingsField` + i18n key + hint（Chrome 字段注明"下次启动浏览器生效"） |
| `lib/index.js` `ego_doctor` | 报告当前生效的 `egoCliArgs`/`chromeArgs`（脱敏打印） |
| `tests/config.test.mjs` | 加 tokenize / 拉黑用例 |
| `tests/env.test.mjs` | 加 `EGO_LINUX_EXTRA_ARGS` 注入用例（覆盖默认值、空值、用户已设的尊重） |
| `runtime/PATCHES.md` | 登记 chrome.mjs 新补丁 |
| `CHANGELOG.md` | 加版本条目 |

### UX 不对称（必须提示）

- ego-CLI 参数：保存后下一次 `ego_*` 工具调用立即生效。
- Chrome 参数：浏览器是单例常驻；需 `ego_doctor` 里给出 `ego-browser --stop` 指令或重启 DSH 后下次冷启动才生效。设置卡 hint 与 doctor 报告都说明这一点。

### 数据流

```
设置卡 → bridge.source() → resolveConfig() → cfg.egoCliArgs / cfg.chromeArgs
                                                      │
              ┌───────────────────────────────────────┴────────────────────────────┐
              ▼                                                                       ▼
      runEgoScript argv 追加 egoCliArgs 切分                  resolveEgoEnv 设 EGO_LINUX_EXTRA_ARGS=chromeArgs
              │                                                                       │
              ▼                                                                       ▼
      ego-browser nodejs <...egoCliArgs> heredoc              chrome.mjs launch() args 末尾 spread extra
```

### 不做（YAGNI）

- 不做 per-call 参数（用户级配置，非 agent 级）。
- 不做参数合法性深度校验（只拉黑互斥项；其余照原样透传，用户自负）。
- 不动 `EGO_LINUX_PROXY`（已有专门通道）。
- 不为 macOS app 版 ego-browser 适配（本插件 runtime 是 ego-linux；macOS app 走原生 CLI，其 argv 由 app 自管，与本字段无关）。

## 验证

- `pnpm test`：config/env 测试全绿（含新增用例）。
- `pnpm run build`：node --check 全过。
- 手动：设置卡填 `--disable-features=Translate` → 重启浏览器 → `ego_doctor` 报告 Chrome args 含该项。
