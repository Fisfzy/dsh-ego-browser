## 观察窗 worker 启动链修复 + 社区 PR 合并

### 修复

- **观察窗在 DSH ≥ 0.1.5 永不启动**（#34 / #38 / #43）：worker spawn 缺少 0.1.5 subprocess provider 必填的 `cwd`，异常被裸 `catch` 吞掉导致 `ensureWorker()` 永远返回 null。已补 `cwd`。
- **worker 启动即自杀**（#34 缺陷 2 / #40）：`stopSiblingWorkers()` 的松散子串匹配把 DSH subprocess runner 误判为同侪 worker，`taskkill /T` 连带杀掉自己的进程树。匹配收紧为「node 的直接脚本参数是 ego-cast-worker.mjs」并排除自身祖先进程链。
- **Electron 宿主（DSH Desktop）全部 `ego_*` 报 no `@@DSH_RESULT@@`**（#42）：spawn 传显式 env 时缺 `ELECTRON_RUN_AS_NODE`，子进程被当成第二个 Electron 应用启动。`resolveEgoEnv` 与 worker spawn 在 `process.versions.electron` 存在时自动补 `ELECTRON_RUN_AS_NODE=1`。
- **worker 宕机时 `/api/ego/stream` 空响应**（#39，PR #44）：`proxyWorkerStream(-1)` 短路为 quiet SSE（写 `text/event-stream` 头后保持安静长连接），不再触发 `ERR_SOCKET_BAD_PORT` 把连接撕掉；含 42 行新测试。
- **Windows 下 `EGO_LINUX_HEADLESS` 被静默忽略**（#35）：显式 `EGO_LINUX_HEADLESS=1` 现在优先于 win32 的 `hasDisplay=true` 默认推断，与 CLI help / README 文档一致。
- **无 dsh-better-sidebar 宿主 web boot 整体阻断**：client 静态 inject 列表移除 `betterSidebar`（loader 会永远等待缺失服务），改为 `ctx.get` 探测 + 浮动观察球立即挂载 + 服务后出现时经 `ctx.inject` 升级为侧边栏 Tab（致谢 PR #45 的方案）。
- **修复 manifest 版本不一致**：`dsh-plugin.json` 此前停留在 0.8.3，与 `package.json` 的 0.8.4 不符（正是 DSH STORE 审计会标记的元数据不符类）——已对齐。

### 新增

- **`isolateSpaces` 任务空间沙盒隔离开关**（PR #31）：默认关闭，任务空间复用磁盘持久化 Profile，登录态跨重启永久保留（覆盖 #1 诉求）；开启后恢复内存沙盒隔离。`ego_space_open` / `ego_space_close` 工具描述随模式动态注入；修复 gateway 布尔设置无法持久化的问题。

### 其他

- 修复 `pnpm-workspace.yaml` 未填的 `allowBuilds` 模板占位符导致 pnpm 11 无法 install；补 `isolateSpaces` 的 config 测试夹具。
- 合并 PR #36（README 版本兼容矩阵）、#31、#44；关闭被覆盖的 #45。
- 测试：**15 个文件、92 个测试全部通过**。

### 兼容

- `engines.dsh: >=0.1.2-rc.1`；peer 依赖全部声明 `>=0.1.2-rc.1`。
- 已在 **DSH 0.1.2-rc.1（Windows / web profile）** 完成安装、启动、`ego_navigate` 真实调用与实时观察面板验收。
- `0.1.2-alpha.x` 按声明可装但未实测；**`< 0.1.2-rc.1` 请使用 v0.8.0 及更早版本**。
- Windows / Linux / macOS 平台说明与 dsh-better-sidebar 版本兼容矩阵见 README。

---

**安装**：

```sh
dsh plugin --profile <name> add github:Fisfzy/dsh-ego-browser#v0.8.4
```
