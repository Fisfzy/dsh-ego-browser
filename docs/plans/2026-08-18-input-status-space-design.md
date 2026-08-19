# 输入、状态与活动空间设计

日期：2026-08-18

## 目标

- 鼠标控制不受画面后端状态短暂滞后影响。
- 支持英文、中文 IME、粘贴、控制键和快捷键。
- FFmpeg/CDP 标签反映 worker 真实状态，不因 SSE 丢失回退 CDP。
- `ego_space_open` 后省略 `space` 的工具继续使用同一空间，不留下 about:blank 窗口。

## 鼠标控制

控制面与画面后端解耦。发送鼠标事件只要求组件逻辑可见、存在当前画面 target，且事件 target 与当前画面 target 一致。不依赖 `streamState`，也不等待 spaces 列表包含 target。

worker 负责最终 target 校验。target 已关闭时返回 409 `capture-target-stale`；其他 CDP dispatch 错误返回 503 `input-dispatch-failed`。

## 键盘输入

视频区域点击后聚焦一个透明 textarea 输入代理。焦点只存在于观察窗内部，不监听 document 全局键盘事件，避免抢占 DSH 输入框和快捷键。

- 普通文字和粘贴：`Input.insertText`。
- 中文 IME：忽略 composition 中间值，仅在 `compositionend` 发送最终文本。
- Enter、Tab、Escape、方向键、退格、Delete、Home/End/Page、F 键：`Input.dispatchKeyEvent` keyDown/keyUp。
- Ctrl/Cmd/Alt/Shift 快捷键：转发 key、code、repeat 和 modifier bitmask。
- printable key 不通过 keyDown 重复插入，文字统一由 beforeinput/insertText 路径发送。

worker 输入协议新增 `insertText`、`keyDown`、`keyUp`，并限制文本长度及允许字段。

## Capture 状态收敛

前端通过一个统一函数应用 capture 状态，来源包括：

- SSE `capture-status`。
- `watch/start`、`watch/switch` 和续租响应。
- `/api/ego/spaces` 响应中的 `capture`。
- 面板启动和重连时的 `/api/ego/watch/status`。

状态没有 `backend` 时保留当前值，禁止缺省覆盖为 CDP。watch 响应为 failed 时不标记 started，下一次同步可以重试。

FFmpeg 配置且无 watcher 时显示 `FFmpeg · idle`；只有 worker 明确报告 CDP 时才显示 CDP。

## 活动空间

插件进程维护 `activeSpace`，初始值为配置的 `defaultSpace`。

- `ego_space_open(name)` 成功后将 `activeSpace` 更新为返回的 space id，缺少 id 时使用 name。
- 所有带可选 `space` 的结构化工具：显式参数优先，否则使用 `activeSpace`。
- 显式操作某个 space 成功后，将它设为 active，保持后续调用一致。
- 关闭当前 active space 后回退到 `defaultSpace`。

该状态由现有 ego tool 全局互斥锁保护。插件已明确不支持多个独立 Harness 会话同时共享同一浏览器，因此不新增跨会话空间路由层。

## 测试

- 鼠标发送不依赖 streamState/spaces 同步。
- composition 中间值不发送，最终中文只发送一次。
- printable、控制键、快捷键 modifier 映射。
- worker 文本和键盘 CDP 参数。
- watch/status、watch 响应和 spaces capture 都能更新 backend。
- 缺少 backend 的状态不覆盖当前 FFmpeg。
- `ego_space_open("task")` 后省略 space 的 navigate/click 使用同一个空间。
- 关闭 active space 后恢复默认空间。
