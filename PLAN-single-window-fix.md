# Plan: 修复 `ego_space_open` 打开两个窗口

> 起因：一次 `ego_space_open` 在全新状态下产生了两个浏览器窗口。本文件记录根因、修复方案与执行步骤。

## 1. 根因

两条独立的"创建 tab"路径，运行在不同的 browser context 中，Chrome 把不同的 context 隔离到不同的窗口：

1. **窗口 1（launch 残留 tab）** —— `runtime/ego-linux/src/chrome.mjs:395` 在启动 Chrome 时把 `"about:blank"` 作为位置参数传入。这会在 **默认** browser context 中开一个 tab。注释（`chrome.mjs:391-395`）说这是必须的：没有任何 tab 时，harness 的 `ensureSession`（`runtime/ego-browser/dist/out/index.js:431`）会抛 `"no active tab to attach session"`。

2. **窗口 2（task space tab）** —— `runtime/ego-linux/src/task-spaces.mjs:414,460` 的 `taskSpaces.createTaskSpace()` 先 `Target.createBrowserContext`（新 context），再 `Target.createTarget({ url: "about:blank", browserContextId })`。Chrome 把不同 browser context 隔离到独立窗口 —— `task-spaces.mjs:145-147` 明确写了 *"A context-backed space cannot share a window with the default context, so every space is its own window"*。

**净结果**：launch 残留 tab 在窗口 1，space tab 在窗口 2，用户看到两个窗口。

`task-spaces.mjs:22-29` 的注释（*"Spaces deliberately do NOT get their own browser window... One window, tracked tab sets."*）是 **设计意图**，在引入 browser context 之前写的；`task-spaces.mjs:145-147` 的注释才是 **当前现实**（每个 context-backed space = 一个窗口）。两者矛盾。

## 2. 修复方案

**去掉 launch 残留 tab**：在 `runtime/ego-linux/src/chrome.mjs` 的 `launch()` 中，把位置参数 `"about:blank"` 换成 `--no-startup-window` 旗标。

为什么现在可以这么做：`lib/index.js` 中所有 `ego_*` 页面操作工具都通过 `useSpace(...)+ensureRealTab()` 路由，会先 `taskSpaces.useOrCreate`（browser-level CDP，不需要 attached session）再在任何 `page.*` 调用前创建 tab。注释（`chrome.mjs:391-395`）里说"`--no-startup-window` was tried here and breaks every page operation"—— 那是在引入 `useSpace+ensureRealTab` 模式之前的旧结论，现在不再成立。

**取舍**（诚实说明）：
- `ego_cli` / `ego_script` 中如果用户写的 heredoc 直接调 `page.*` 而不先 `taskSpaces.useOrCreate`，现在会抛 `"no active tab to attach session"`，而不是悄悄复用 launch 残留 tab。这是可接受的回归 —— 错误信息明确，且推荐用法（所有结构化 `ego_*` 工具）都走 `useSpace+ensureRealTab`，不受影响。

**不在本次范围**：更深层的 "N 个 space = N 个窗口" 架构问题（每个 context-backed space 各开一个窗口，见 `task-spaces.mjs:145-147`）。这是独立的设计问题，用户只报告了单次调用开两个窗口的现象。

## 3. 执行步骤

1. **拉取 `origin/master`**（当前 `a759af2`，已合并 Windows Chrome env 修复）。
2. **新建分支** `fix/single-window-on-space-open`，基于更新后的 master。
3. **编辑 `runtime/ego-linux/src/chrome.mjs`**（`launch()` 函数，约 375-396 行）：
   - 删除位置参数 `"about:blank"`。
   - 在 `LAUNCH_FLAGS` 加 `"--no-startup-window"`，或直接在 `launch()` 内联。
   - 重写 391-395 行注释：launch 不再创建残留 tab；第一次 `ego_space_open`（或任何走 `useSpace+ensureRealTab` 的工具）在自己的 browser context 中创建第一个 tab，这是用户唯一看到的窗口。
4. **加回归测试** 到 `tests/env.test.mjs`（沿用 306-338 行的源码文本检查风格）：
   - 断言 `chrome.mjs` 源码含 `--no-startup-window`。
   - 断言 `launch()` 不再传裸 `"about:blank"` 位置参数。
5. **更新 `runtime/PATCHES.md`** —— 加一行 `chrome.mjs` 记录 `--no-startup-window` 改动及原因（消除单次 `ego_space_open` 的重复窗口）。
6. **更新 `CHANGELOG.md`** —— 加 `## [0.7.1]` 段落，中文描述修复（沿用现有风格）。
7. **bump `package.json`** 版本 `0.7.0` → `0.7.1`。
8. **验证**：
   - `pnpm test`（18 个已有 + 1 个新测试，全过）
   - `pnpm run build`（`node --check` 语法校验）
9. **手动验证**（由人类执行，AGENTS.md 禁止 agent 启 `dsh web`）：全新状态、无运行中的 Chrome，调一次 `ego_space_open` → 只出现 1 个窗口。
10. **提交 + push** 到 `fork` remote，然后 `gh pr create` 对 `Fisfzy/ego-browser:master`。

## 4. 涉及文件

| 文件 | 改动类型 |
|---|---|
| `runtime/ego-linux/src/chrome.mjs` | 核心修复：去 `about:blank` 位置参数，加 `--no-startup-window`，更新注释 |
| `tests/env.test.mjs` | 新增源码文本断言测试 |
| `runtime/PATCHES.md` | 记录本地 runtime 改动 |
| `CHANGELOG.md` | 新增 `0.7.1` 版本条目 |
| `package.json` | 版本号 bump |

## 5. 验收标准

- [ ] `pnpm test` 全过（含新增回归测试）
- [ ] `pnpm run build` 通过
- [ ] 手动：单次 `ego_space_open` 只开 1 个窗口
- [ ] PR 已创建，targeting `Fisfzy/ego-browser:master`
