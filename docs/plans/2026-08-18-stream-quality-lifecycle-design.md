# FFmpeg 画质与后台生命周期设计

日期：2026-08-18

## 目标

- 平衡档在约 1280x805、30 FPS 下默认使用 4 Mbps。
- DSH 窗口进入后台时保持观察流连续，不反复销毁和重建 WGC/FFmpeg。
- `watch/start` 不因 host 的短超时错误返回 502。
- 输入请求不再把 worker 的目标失效错误统一包装成 500。
- FFmpeg 启动失败必须在有限时间内从 `starting` 转为 `failed`。

## 配置

新增 `ffmpegBitrateKbps`：

```text
range: 500-20000
step: 250
low: 2000
balanced: 4000
high: 8000
```

Windows Media Foundation 和其他码率编码器使用：

```text
-b:v <bitrate>k
-maxrate <bitrate * 1.25>k
-bufsize <bitrate * 2>k
```

`libx264` 改为相同的目标码率模式，不再固定使用 `crf=28`。

## 后台生命周期

`document.visibilityState` 不再决定 watcher 生命周期。只要 sidebar Tab 或浮窗仍处于逻辑可见状态，SSE、video 和 watch lease 就保持连接。真正隐藏组件、卸载组件或关闭面板时才停止。

浏览器后台会节流 JavaScript 定时器，因此 worker lease TTL 从 15 秒提高到 120 秒。客户端仍每 5 秒续租；即使续租被节流到约一分钟，也不会误停 capture。

客户端为 `watch/start` 和 `watch/switch` 增加单一 in-flight 请求。启动请求未结束时，续租定时器不能再发送并发 start。

## 代理与错误

host 的 worker POST 代理返回 `{ status, body }`，不再把所有非 2xx 或网络错误折叠成 `null`。

- `watch/start`、`watch/switch`：12 秒超时，覆盖 worker 的 8 秒 MP4 init 超时。
- input、stop、close、flush、config：保持短超时。
- worker 返回 4xx/5xx 时，host 原样转发状态与 JSON 错误。
- worker 不可达时才返回 502。

## 输入

客户端仅在以下条件同时成立时发送输入：

- 当前组件仍可见且未 dispose。
- `streamState === "streaming"`。
- target 仍存在于最新 spaces 列表。
- target 与当前视频 target 一致。

worker 在 target 已关闭或无法 attach 时返回 409 `capture-target-stale`。客户端收到 409 后刷新 spaces、清除当前 pointer 状态，不继续向旧 target 发送 move/release。

## 状态机

FFmpeg 启动阶段继续发布具体阶段：解析二进制、解析窗口、探测编码器、启动 capture。8 秒内未收到 MP4 init segment 时停止子进程并进入 `failed`。

配置更新、目标切换和 watcher 恢复均通过 CaptureManager 的串行 transition 执行。重复 start 只续租，不创建第二个 FFmpeg 进程。

## 测试

- 配置默认值、profile 码率和显式覆盖。
- FFmpeg argv 的 `b:v/maxrate/bufsize`。
- `document.hidden` 不停止 watch，逻辑隐藏仍停止。
- start in-flight 去重。
- 12 秒 watch 代理和上游状态透传。
- stale target 输入返回 409。
- CaptureManager lease 在后台节流窗口内不超时。
- 完整单元测试、语法构建和真实 worker FFmpeg 状态验证。
