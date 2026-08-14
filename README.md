# ego-browser — 看得见的 Agent 浏览器

> **仓库**：`github.com/dsh-external/ego-browser`（私有 · 内测）｜版本历史见 [CHANGELOG.md](CHANGELOG.md)

> ⚠️ **保密声明**：属于 DeepSeek Harness **内测生态**的一部分，仅限 dsh-external 内测成员使用。**严禁公开、外发、镜像或分发到任何非授权位置**；仓库必须保持 PRIVATE，不发布到 npm / 公共 registry，不创建公开 fork 或镜像。

把 [CitroLabs/ego-lite](https://github.com/CitroLabs/ego-lite)（给 AI Agent 用的 Chromium）接入 DeepSeek Harness：以 **30+ 个结构化 `ego_*` 工具**驱动浏览器，并配一套**实时观察前端口**——agent 后台操作网页时，你能像看直播一样看到它正在浏览的每个页面，还能直接操作它。

**开箱即用**：插件包内置 ego 运行时（`runtime/`，MIT，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）——无需克隆官方仓库、无需手动构建，`--no-sandbox` wrapper 随包自带，root / Docker / 无显示器一键跑。

---

## 为什么需要它

通用浏览器不是为 agent 设计的，而 Web 上大量交互（登录态、验证码、动态渲染、表单、需真人会话的站点）只有真浏览器能面对。ego 系的定位是 **“让 agent 用你已登录的浏览器，而不打扰你”**（[官网](https://github.com/CitroLabs/ego-lite)）。

`ego-browser` 在此基础上解决最痛的一点——**你看不见它在干什么**：

| 痛点 | ego-browser 给到 |
|------|------------------|
| 看不见 agent 在哪、点了什么 | 🌐 **实时观察浮窗**：小球一点，各标签实时画面直播 |
| 标签太多找不清 | 🟦 **标签页条**：点选切换、`×` 一键关闭 |
| 想知道 agent 去过哪 | 🕘 **历史抽屉**：回看浏览轨迹 |
| 页面细节看不清 | 🔍 **缩放/拖拽/复位** |
| 画面跟不上操作 | ⚡ 活跃 2s 快刷、静止 8s 省资源 |
| 想直接接管 | 🖱️ **监控窗直操浏览器**：点击/拖动/滚动真实页面（v0.5.0） |
| 环境杂（root/无头/无 sandbox） | 🛡️ 自动探测根目录、无显示器、自动兜底 |

**一句话：别的方案让 agent 用浏览器，它能让你看见并接管 agent 用的浏览器。**

---

## ✨ 近期亮点

- **v0.6.1**：卸载不再阻塞宿主退出（自愈链路稳定）；观察窗 worker **单实例守卫** + stale 状态清理；登录/人机验证引导条可关闭且互斥。
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

可选配置（`~/.dsh/config.yaml` 该插件条目下）：`egoBin`、`defaultSpace`、`maxOutputBytes`、`graceMs`。

无需宿主侧任何配置：`resolveEgoEnv` 自动探测 root / 无显示器并兜底。观察窗 host 路由（`/api/ego/spaces` 等）仅在有 HTTP server 时注册，headless 是安全 no-op。

## 工具清单（30+ 个，前缀 `ego_`，完整索引见 `ego_help`）

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

- **主画面**：agent 当前页面实况；滚轮缩放、按住拖动、双击复位；Ctrl+滚轮缩放视图、Ctrl+拖动平移（v0.5.0）。
- **标签页条**：顶部横排，点选切换，`×` 关闭。
- **历史抽屉**（🕘）：按时间回看访问轨迹。
- 操作时下方网址行就地显示提示，2 秒后恢复。

> 登录态说明：多任务空间 Cookie 相互隔离，请在对应空间内登录。重启 DSH 后运行期登录态被清空（Chrome 运行期 Cookie 仅优雅关闭时落盘），需重登——扫码很快。

## 工作原理

- **工具层**：每个工具把参数拼成 JS 脚本，经 `ctx.subprocess` 用 `ego-browser nodejs` 喂给 stdin 运行，宿主经 CDP 驱动共享 Chromium。结果以 `@@DSH_RESULT@@` 哨兵行解析。所有 `ego_*` 经进程内互斥锁串行化，错误统一归一。
- **观察窗**（三层）：`lib/client.js`（前端）+ `lib/cast-server.js`（host 路由转发，懒启动、崩溃自动重启）+ `bin/ego-cast-worker.mjs`（attach 到 agent 正在用的浏览器，推实时帧）。worker 只读/见控，绝不动宿主环境。

## 开发

```sh
npm run build   # node --check lib/*.js（lib/ 为唯一权威源，不复编译覆盖）
```

> 直接改 `lib/`（`lib/index.js` 工具层、`lib/client.js` 前端、`bin/ego-cast-worker.mjs` worker）。新工具在 `registerActionTools` 按 `t({...})` 加，并在 `ego_help` 索引补一条。

`node_modules/` 仅含指向 DSH checkout 的符号链接（编译期类型解析）；运行时由 harness 解析 `@deepseek-ai/dsh-tools`。

## 已知限制（诚实说明）

- **Windows**：插件层已做 v0.4.0 适配；底层 ego-lite 宿主仍是非 Windows 官方支持的社区移植，复杂多步流程稳定性可能弱于 macOS。
- **快照质量**：Linux 用 CDP `DOMSnapshot` 重建语义树，非 macOS 内核级，复杂 iframe/画布场景可能降级。
- **宿主可靠性（Linux）**：未合并的社区 PR，跨 CLI 调用间可能丢 tab/空间状态；插件已内置防御，简单流程稳定，复杂流程可能需重试。
- **登录态持久化**：Chrome 运行期 Cookie 仅优雅关闭时落盘，强杀重启需重登。
- 输出 schema 为宽松 `additionalProperties: true`，客户端以实际返回值为准。

## 许可与署名

插件本体 MIT。内置运行时嵌入 [CitroLabs/ego-lite](https://github.com/CitroLabs/ego-lite) 的 MIT 代码（含 [PR #234](https://github.com/citrolabs/ego-lite/pull/234) 的 Linux 移植）及一处本地代理补丁——详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
