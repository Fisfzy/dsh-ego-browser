# ego-browser — DSH 插件（dshx external plugin）

把 [CitroLabs/ego-lite](https://github.com/CitroLabs/ego-lite)（给 AI Agent 用的 Chromium 浏览器）接入
DeepSeek Harness：以 **13 个结构化 `ego_*` 工具**驱动浏览器，与 `zotero-wave-rag`、`dsh-vision`
等插件同一机制（`~/.dsh/config.yaml` overlay + Cordis 插件入口）。

**Linux + Chrome = 开箱即用。** 插件包 **内置 ego 运行时**（`runtime/`，来自 MIT 许可的
ego-lite 项目，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）——无需克隆官方仓库、
无需手动构建。在 Chrome/Chromium 之上即可直接使用。

## 前置条件

| 要求 | 说明 |
|---|---|
| Node ≥ 22 | harness 环境自带 |
| **任意 Chrome / Chromium / Brave / Edge** | 自动在 `PATH` 上发现，或通过 `EGO_LINUX_CHROME` 指定。**root 用户需要 `--no-sandbox` 包装脚本**（见下） |
| DSH + dshx | 插件装载机制 |

## 安装

```sh
# 1. 安装（tarball 或 git URL 均可）
dshx install ego-browser ego-browser-plugin-0.1.0.tgz

# 2. 验证
dshx list                    # 应显示：[on] ego-browser

# 3. 可选配置（~/.dsh/config.yaml，该插件条目下）：
#    egoBin: /path/to/ego-browser       # 默认：插件内置 vendored CLI
#    defaultSpace: dsh-agent            # 动作工具未传 space 时使用的任务空间名
#    maxOutputBytes: 4194304            # 快照/JS 结果的 stdout 收集上限
#    graceMs: 15000                     # 进程树终止宽限（ms）
```

说明：
- `egoBin` 默认指向内置的 `runtime/ego-linux/bin/ego-browser.mjs`（已含代理补丁）。
  使用 **macOS 官方 App** 的用户配置 `egoBin: ego-browser` 即可切回官方宿主。
- **root / Docker / CI**：Chrome 以 root 运行必须 `--no-sandbox`。创建包装脚本并把
  `EGO_LINUX_CHROME` 指向它：
  ```sh
  #!/bin/sh
  exec /usr/bin/google-chrome-stable --no-sandbox "$@"
  ```
- **无显示服务器**：设置 `EGO_LINUX_HEADLESS=1` 以无头模式运行（不弹窗口）。

## 工具清单（13 个，前缀 ego_）

| 工具 | 作用 |
|---|---|
| `ego_status` | 探测 ego-browser CLI 是否可用（实际运行 `--status`） |
| `ego_space_open` | 打开/复用任务空间（隔离浏览上下文，继承登录态），返回空间 id |
| `ego_space_close` | 完成/关闭任务空间（`keep: true` 保留页面给用户） |
| `ego_snapshot` | 当前页面语义树文本（带 `[ref=N, loc=...]` 选择器，供 click/fill 定位） |
| `ego_navigate` | 打开 URL 或切到已有 tab，等待加载，返回页面信息 |
| `ego_click` | 点击：CSS/xpath/loc/ref 选择器或视口坐标 |
| `ego_fill` | 向输入框键入文本 |
| `ego_js` | 在页面内求值 JS 表达式，返回可 JSON 序列化的结果 |
| `ego_cdp` | 原始 CDP 命令（如 `Page.handleJavaScriptDialog`） |
| `ego_screenshot` | 截图，返回 PNG 文件路径（可交给 vision 工具看图） |
| `ego_page_info` | 当前页 url/title/视口/滚动位置，或原生对话框状态 |
| `ego_wait` | 固定毫秒等待 |
| `ego_cli` | 逃生舱：原样运行任意 `ego-browser nodejs` heredoc 脚本 |

## 工作原理

- 每个工具把参数拼成一段 JS 脚本，通过 `ctx.subprocess` 以 `ego-browser nodejs` 喂给 stdin 运行；
  内置宿主用 CDP 驱动普通 Chrome。
- 脚本使用共享 harness 的 facade 表面（`taskSpaces.useOrCreate/.complete`、
  `browser.openOrReuseTab`、`page.info()`、`page.snapshotRaw()`、`page.evaluate()`、
  `page.waitForTimeout()`、`page.screenshot()`、`page.locator(...).click()/.fill()`、
  `page.mouse.click(x, y)`、裸 `cdp()`）——macOS App 与 Linux 宿主完全一致。
- 结果通过 `console.log('@@DSH_RESULT@@' + JSON.stringify(payload))` 输出，插件解析哨兵行；
  `ego_snapshot` 的文本直接透出渲染。
- 所有 `ego_*` 执行经过**进程内互斥锁串行化**（每个调用共享同一个常驻浏览器）；
  插件卸载时 best-effort 停止浏览器（`ctx.effect`）。
- 非零退出、缺少 CLI、被中止都会转为明确错误信息。

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

## 已知限制

- **快照质量**：Linux 宿主用 CDP `DOMSnapshot.captureSnapshot` 重建语义树（refs 忠实、内容可读），
  但非 macOS 内核级快照，复杂 iframe/画布场景可能降级。
- **官方支持状态**：Linux 是未合并的社区 PR（#234）；macOS 仍是官方唯一支持平台。
- **宿主可靠性（Linux）**：未合并的宿主在跨 CLI 调用间可能丢失 tab/空间状态（空白 tab、偶发 EPIPE）。
  插件已内置防御（`ensureRealTab`、快照重试、EPIPE 容错）；简单流程稳定，复杂多步流程可能需要重试。
  建议等官方 Linux 支持合并后，或使用 macOS App 时用于生产。
- **输出 schema** 为宽松的 `additionalProperties: true` 结构，客户端渲染以实际返回值为准。

## 许可与署名

插件本体为 MIT。内置运行时嵌入 [CitroLabs/ego-lite](https://github.com/CitroLabs/ego-lite)
的 MIT 代码（含 [PR #234](https://github.com/citrolabs/ego-lite/pull/234) 的 Linux 移植）以及
一处本地代理补丁——详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
