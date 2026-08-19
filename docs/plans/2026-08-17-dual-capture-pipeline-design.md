# ego-browser 双画面管线设计与实施计划

日期：2026-08-17

状态：设计已确认，待实施

## 1. 目标

为观察窗提供两套可由用户选择的画面后端：

1. `cdp`：修复并优化现有 `Page.startScreencast` JPEG 管线。
2. `ffmpeg`：捕获真实浏览器窗口或显示输出，编码为低延迟 H.264 视频流。

两套后端共用现有 CDP 控制面，包括标签发现、当前页面识别、viewport、鼠标输入、标签关闭、登录落盘和验证码检测。后端切换只替换画面生产和前端播放方式，不重写浏览器控制逻辑。

主要验收目标：

- 滚动时画面连续，不再依赖 5 秒 `captureScreenshot` 兜底刷新。
- 默认配置下观察窗达到稳定 15-20 FPS。
- CDP 后端修复后不通过高频强制截图换取流畅度。
- FFmpeg 后端在支持的平台使用视频编码降低传输和前端解码压力。
- 面板关闭或不可见时停止昂贵的画面生产。
- 任一后端失败时给出可诊断状态，不静默伪装成功。
- 不启动或修改 `dsh web`；实际 UI 验收由人类完成。

## 2. 已确认决策

### 2.1 后端选择

新增配置：

```text
captureBackend: auto | cdp | ffmpeg
```

- `auto` 默认选择 `cdp`。CDP 无系统屏幕权限、支持后台窗口和 headless，仍是最稳妥的默认值。
- `cdp` 强制使用 CDP JPEG 管线。
- `ffmpeg` 强制使用 FFmpeg 视频管线。启动失败时前端展示失败原因和“切回 CDP”操作，不静默降级。

### 2.2 FFmpeg 分发

- 通过 npm 包提供 FFmpeg，不要求用户手工安装。
- 首选依赖 `ffmpeg-static`，覆盖 Windows、Linux、macOS 及常见 x64/ARM 架构。
- 必须在 `THIRD_PARTY_NOTICES.md` 和 README 中记录 npm 包及其实际分发二进制的许可证。`ffmpeg-static` 包当前为 GPL-3.0-or-later，不能按纯 MIT 依赖处理。
- 安装阶段下载失败、平台无对应二进制或二进制不可执行时，FFmpeg 后端应明确标记为 unavailable，CDP 后端仍可工作。

### 2.3 FFmpeg 播放协议

首版采用：

```text
FFmpeg H.264 -> fragmented MP4 -> HTTP chunked binary stream -> MediaSource -> <video>
```

不在首版引入 WebRTC，原因如下：

- 当前主要是本机 worker 到本机 DSH Web，不需要 NAT 穿透。
- WebRTC 需要额外的原生 WebRTC 栈、RTP 打包和信令。
- HTTP chunked + MSE 可以复用现有 host 代理模式，复杂度显著更低。
- MSE 不依赖 WebCodecs 的 secure-context 条件，兼容性更稳。

若后续需要跨公网观看、拥塞控制或音视频同步，再将 WebRTC 作为第三后端评估，不污染本次双后端设计。

### 2.4 Wayland

Wayland 首次启用允许弹出 XDG Desktop Portal 选择窗口并由用户授权。

必须明确：标准 `ffmpeg-static` 当前提供的 FFmpeg 6.1.1 不能保证包含尚未稳定进入主线的 PipeWire portal 抓屏输入。因此实施分两级：

1. 优先探测 FFmpeg 是否具备可用的 `pipewiregrab` 或等价输入；具备则走 Portal/PipeWire。
2. 不具备时，FFmpeg 后端在 Wayland 显示“当前随包 FFmpeg 不支持 Portal 捕获”，允许切回 CDP。

不使用需要 root 或 `CAP_SYS_ADMIN` 的 `kmsgrab` 作为默认方案。若项目要求 Wayland FFmpeg 后端必须无条件可用，则需要另行维护一个启用 PipeWire portal 的自定义 FFmpeg npm 二进制包；该工作作为独立发布项，不在普通 `ffmpeg-static` 接入中假装已经解决。

## 3. 当前根因

现有 worker 的帧 ACK 使用了错误的 session ID：

```js
cdp.call("Page.screencastFrameAck", { sessionId }, sessionId)
```

这里两个值含义不同：

- 第三个参数应是 flattened CDP target session ID，用于把命令发给正确页面。
- ACK 参数中的 `sessionId` 必须是 `Page.screencastFrame` 事件 `params.sessionId` 提供的帧会话编号。

正确形式：

```js
cdp.call(
  "Page.screencastFrameAck",
  { sessionId: params.sessionId },
  targetSessionId,
)
```

错误 ACK 会导致 Chrome 认为帧未被消费并停止持续发送，现象与“滚动后预览停住，直到截图兜底触发”一致。

当前还有以下资源放大因素：

- 为所有页面注入无限透明动画，持续强制 compositor 重绘。
- 最多为 30 个页面保持 screencast，而不是只为实际观看页面工作。
- 活动标签默认不限帧。
- JPEG Base64 经 worker SSE、host SSE 和 EventSource/JSON 多次复制。
- rAF 只减少 `<img>` 解码次数，不能阻止上游编码、Base64 解析和字符串分配。
- 浮动观察窗即使收起，也可能继续保持画面订阅。

因此 CDP 后端必须先修复协议和生命周期，不能继续依赖把 backstop 调到 200ms。

## 4. 总体架构

```text
                         CDP browser connection
                                  |
                 +----------------+----------------+
                 |                                 |
           control plane                      capture manager
    targets / active / viewport / input       backend lifecycle
                 |                                 |
                 |                  +--------------+--------------+
                 |                  |                             |
                 |             CDP backend                  FFmpeg backend
                 |        JPEG screencast frames      OS capture -> H.264/fMP4
                 |                  |                             |
                 +------------------+--------------+--------------+
                                                    |
                                              worker HTTP API
                                      metadata SSE + selected media stream
                                                    |
                                               host proxy
                                                    |
                                    +---------------+---------------+
                                    |                               |
                              <img> renderer                  <video> renderer
                                  CDP                              FFmpeg
```

核心原则：

- 一个 worker 中同时只能有一个活动画面后端。
- 一个 FFmpeg worker 同时只编码一个当前观看 target。
- CDP 后端也只实时推送当前观看 target；其他标签只保留元数据和可选低频缩略图。
- 标签切换不改变输入 API，前端始终用目标页面 CSS viewport 坐标发送 CDP 输入。
- 视频流和元数据流分离。JPEG 可继续走 SSE；H.264/fMP4 必须走二进制 HTTP。

## 5. 统一后端契约

在 worker 内建立 `CaptureManager`，避免 HTTP 路由直接操作具体后端。

建议契约：

```js
backend.start({ targetId, sessionId, viewport, clientId })
backend.switchTarget({ targetId, sessionId, viewport })
backend.updateConfig(config)
backend.stop(reason)
backend.status()
```

后端事件：

```js
onStatus({ backend, state, targetId, message, metrics })
onJpegFrame({ targetId, data, vw, vh, ts })
onVideoInit({ targetId, mime, width, height, generation })
onVideoChunk(buffer)
```

状态机：

```text
idle
  -> starting
  -> streaming
  -> switching
  -> streaming
  -> stopping
  -> idle

starting/switching/streaming
  -> failed
  -> idle after explicit retry or backend change
```

每次启动或切换视频流生成递增 `generation`。前端只接受当前 generation，防止旧 FFmpeg 进程退出时残留 chunk 污染新流。

## 6. 订阅与生命周期

### 6.1 客户端订阅

画面后端不应由“浏览器进程存在”触发，而应由“至少一个可见观察窗正在观看”触发。

新增 worker API：

```text
POST /api/watch/start
  { clientId, backend, targetId }

POST /api/watch/switch
  { clientId, targetId }

POST /api/watch/stop
  { clientId }

GET /api/watch/status
```

规则：

- sidebar Tab 可见或浮动面板展开时 `start`。
- Tab 隐藏、浮动面板收起、页面进入 `visibilitychange=hidden` 一段时间后 `stop`。
- 使用 1-2 秒 idle grace，避免快速开关导致进程抖动。
- worker 维护 client lease；客户端异常断开后租约超时自动释放。
- 多个前端客户端同时观看时，首版采用单节目源：最后一次明确选择的 target 成为当前流，所有客户端观看同一 target。
- 若未来需要每客户端独立 target，再扩展多路编码；首版避免多 FFmpeg 进程。

### 6.2 worker 生命周期

- 没有观看者时停止 `Page.startScreencast` 或 FFmpeg 子进程。
- 元数据 SSE 可以保留低频 keepalive，但不携带画面。
- 浏览器 CDP 断线时停止后端，状态变为 `failed/browser-disconnected`。
- 浏览器恢复连接后不自动开始昂贵捕获，只有仍存在有效 lease 才恢复。
- 配置切换后端时，严格执行 stop old -> drain -> start new。

## 7. CDP 后端详细设计

### 7.1 ACK 修复

事件处理器必须同时保留：

- `params.sessionId`：帧 ACK ID。
- 外层 `targetSessionId`：flattened CDP session。

ACK 应尽快发出，不等待前端消费。CDP screencast 自身不适合作为跨层背压机制；应用层通过丢中间帧控制资源。

`Cdp.call()` 还应识别 CDP 返回中的 `error` 并 reject。当前只按 `id` resolve，会吞掉错误 ACK、错误 start/stop 等协议问题，导致故障不可见。

### 7.2 移除强制重绘

删除或默认禁用 `FORCE_REPAINT_SCRIPT`：

- 不再给每个页面注入无限 CSS 动画。
- 不再依赖 compositor 空转制造帧。
- 静态页没有新帧是正常状态。
- 视频或 canvas 若 Chromium screencast 本身仍无法产生帧，交由 FFmpeg 后端解决，而不是让所有页面持续重绘。

若保留诊断开关，只允许显式 debug 配置启用，不进入普通设置 UI。

### 7.3 帧率与背压

新增配置：

```text
cdpFps: 5-30，默认 20
cdpQuality: 1-100，默认 55
cdpMaxWidth: 320-1920，默认 960
cdpBackstopIntervalMs: 1000-10000，默认 3000
```

处理策略：

1. 每个源帧立即正确 ACK。
2. 如果距上次发送不足 `1000 / cdpFps`，只覆盖 `pendingLatestFrame`。
3. 到发送时间只广播最新帧一次。
4. 若下游响应 `write()` 返回 `false`，标记客户端 congested，在 `drain` 前不继续写 JPEG，只保留最新帧。
5. SSE 客户端持续阻塞或断开时清理。

这里的目标不是“保证每一帧送达”，而是“保证最新画面尽快送达”。远控预览中旧帧没有价值。

### 7.4 target 范围

- 仅对当前观看 target 调用 `Page.startScreencast`。
- 切换 target 时先 stop 旧 target，再 attach/start 新 target。
- 元数据列表仍可展示最多 30 个页面，但不为每页持续编码。
- 历史抽屉缩略图使用最后缓存帧，不要求后台实时更新。

### 7.5 backstop

- backstop 只用于静态页首次画面、导航后丢首帧和异常恢复。
- 滚动流畅度不得依赖 backstop。
- backstop 只针对当前观看 target。
- `captureScreenshot` 必须带与 screencast 相同的质量和最大尺寸约束；必要时使用 `clip`/缩放，而不是原始全分辨率截图。

## 8. FFmpeg 后端详细设计

### 8.1 进程模型

每个 worker 最多一个 FFmpeg 子进程：

```text
resolve capture source
  -> probe encoder
  -> spawn ffmpeg
  -> parse stdout fMP4 boxes
  -> publish init segment
  -> publish media fragments
```

进程要求：

- `stdin` 用于发送 `q` 做优雅停止。
- `stdout` 只承载 fMP4 二进制。
- `stderr` 使用有界环形缓冲，保留最后 32-64 KB 供诊断。
- 启动超时默认 8 秒；超时或在首个 init segment 前退出视为失败。
- stop 时先写 `q`，等待 1.5 秒，再 SIGTERM，最后才强制终止。
- 进程退出必须关闭对应视频 HTTP 响应，促使前端重新建流。

### 8.2 编码参数

默认平衡档：

```text
fps=20
maxWidth=1280
codec=h264
pixelFormat=yuv420p
gop=20
bFrames=0
softwarePreset=ultrafast
tune=zerolatency
```

软件编码基线：

```text
-c:v libx264
-preset ultrafast
-tune zerolatency
-profile:v baseline
-pix_fmt yuv420p
-g 20
-keyint_min 20
-sc_threshold 0
-bf 0
-an
-movflags empty_moov+default_base_moof+frag_keyframe
-frag_duration 500000
-f mp4 pipe:1
```

为了降低首帧等待，关键帧间隔不超过 1 秒，fragment 建议 250-500ms。实际参数需以 MSE 是否能及时 append 和播放为准，不能只看 FFmpeg 是否成功启动。

### 8.3 硬件编码

新增配置：

```text
ffmpegEncoder: auto | software | h264_nvenc | h264_qsv | h264_amf |
                h264_videotoolbox | h264_vaapi
```

`auto` 不是只检查 `ffmpeg -encoders` 列表，而要做一次短的真实编码 probe；编码器被编译进去不代表本机驱动可用。

优先级：

- Windows：NVENC -> QSV -> AMF -> libx264。
- macOS：VideoToolbox -> libx264。
- Linux：NVENC -> VAAPI/QSV -> libx264。

硬件输入/像素格式转换失败时，可以回退软件编码，但必须在状态中报告实际使用的编码器。

### 8.4 画质档位

```text
low:
  15 FPS, 960px, 较高压缩

balanced:
  20 FPS, 1280px, 默认

high:
  30 FPS, 1600px, 更高码率
```

底层仍保留高级字段，UI 首版优先展示档位，避免普通用户面对大量 FFmpeg 参数。

码率策略优先使用 CRF/CQ，不以固定超高码率浪费静态页面带宽。低延迟优先于完美压缩率。

## 9. 平台捕获适配

### 9.1 通用窗口与内容区域定位

FFmpeg 应尽量只编码网页 viewport，不包含 Chrome 标签栏和系统标题栏，否则前端坐标无法直接映射到 CDP CSS viewport。

通过目标页面 `Runtime.evaluate` 获取：

```js
({
  screenX,
  screenY,
  outerWidth,
  outerHeight,
  innerWidth,
  innerHeight,
  devicePixelRatio,
})
```

结合 `Browser.getWindowForTarget` / `Browser.getWindowBounds` 计算窗口和内容区域。平台适配层返回统一结构：

```js
{
  sourceType,
  sourceId,
  captureX,
  captureY,
  captureWidth,
  captureHeight,
  contentWidthCss,
  contentHeightCss,
  scaleFactor,
}
```

坐标映射验收必须覆盖：

- Windows 显示缩放 100%、125%、150%。
- macOS Retina DPR。
- Linux X11 fractional scaling。
- 窗口移动和 resize 后重新计算 capture rect。

### 9.2 Windows

首版输入：

- 兼容路径：`gdigrab`。
- 优化路径：探测可用时使用 `ddagrab`。

窗口识别优先使用 HWND，而不是标题字符串：网页标题会变化且可能重复。可用小型 PowerShell 探针根据 browser PID 枚举可见顶层窗口并返回 HWND/bounds；探针只做发现，不持续轮询。

若具体 FFmpeg build 支持 `hwnd=` 输入，直接按 HWND 捕获；否则捕获桌面后按 bounds crop。

限制：

- 桌面 crop 路径会受到遮挡、最小化和虚拟桌面影响。
- `ddagrab` 捕获显示输出，仍不是 Chrome 内部 surface。
- 检测到最小化或连续黑帧时报告 `capture-source-not-visible`。

### 9.3 Linux X11

使用 `x11grab`：

```text
-f x11grab -framerate N -video_size WxH -i DISPLAY+X,Y
```

窗口 XID 和几何信息可以通过现有系统工具或轻量 X11 helper 探测。不能假设 `xdotool`/`xwininfo` 一定安装；若不增加原生模块，优先使用浏览器 JS + CDP bounds 计算 display crop。

在 Xvfb/headless 环境中，只要 Chromium 和 FFmpeg 共享同一 `DISPLAY`，该后端可工作。

### 9.4 macOS

`ffmpeg-static` 的 avfoundation 路径以显示捕获为主：

- 首次使用触发系统“屏幕录制”权限。
- 捕获对应显示后按窗口内容 bounds crop。
- 使用 `h264_videotoolbox` 作为首选编码器。

前端必须区分：

- 尚未授权。
- 用户拒绝授权。
- 授权后需要重启宿主进程。
- 没找到目标窗口或窗口不在可捕获显示上。

macOS 单窗口无侵入捕获若要求遮挡时仍正确，后续应改用 ScreenCaptureKit 原生 helper；avfoundation display crop 不能提供同等保证。

### 9.5 Wayland

检测：

```text
XDG_SESSION_TYPE=wayland 或 WAYLAND_DISPLAY 存在
```

流程：

1. 请求 XDG Desktop Portal ScreenCast session。
2. 用户在系统窗口中选择 ego Chrome 窗口。
3. 获得 PipeWire node/FD。
4. 若随包 FFmpeg 支持 PipeWire portal 输入，将 node 交给 FFmpeg。
5. 否则状态置为 `unsupported-ffmpeg-pipewire`，提示切回 CDP。

禁止默认使用：

- root 权限 `kmsgrab`。
- 自动切换整个桌面捕获而不告知用户。
- 假装 portal 授权成功但实际继续展示 CDP JPEG。

若后续发布自定义 FFmpeg npm 包，应按 OS/arch 拆分 optionalDependencies，避免所有用户下载所有平台二进制。

## 10. 二进制流协议

### 10.1 worker 路由

```text
GET /api/video/status
GET /api/video/stream?generation=N
POST /api/watch/start
POST /api/watch/switch
POST /api/watch/stop
```

`/api/video/stream` 响应：

```text
Content-Type: video/mp4
Cache-Control: no-store
Transfer-Encoding: chunked
X-Ego-Generation: N
X-Ego-Backend: ffmpeg
```

只允许当前 generation 建立流。旧 generation 返回 409，前端重新读取 status。

### 10.2 host 代理

新增 `/api/ego/video` 精确路由，使用 `node:http.request` 原样转发二进制 chunk，禁止：

- 使用 `fetch().arrayBuffer()` 缓冲整段。
- 转为 Base64。
- 经 SSE 或 JSON 包装。
- 在 host 内重封装 MP4。

代理必须处理 `backpressure`：下游 `res.write()` 返回 `false` 时暂停上游 `upRes.pause()`，`drain` 后 `resume()`。

### 10.3 MP4 分片

worker 需要一个小型 ISO BMFF box splitter，至少识别 32 位 box length 和以下 box：

```text
ftyp, moov, moof, mdat
```

- `ftyp+moov` 作为 init segment 缓存。
- `moof+mdat` 作为媒体 fragment。
- 新客户端先收到 init segment，再收到后续 fragment。
- box 长度异常或超过合理上限时终止流并报告协议错误。

不要假设 Node stdout 的 `data` chunk 正好对齐 MP4 box。

## 11. 前端播放器

### 11.1 统一控制器状态

`LivePreviewController` 增加：

```js
backend
streamState
streamMessage
streamGeneration
actualEncoder
videoElement
mediaSource
sourceBuffer
appendQueue
```

React sidebar 和浮动面板继续共用控制器逻辑，避免实现两套不同的数据面。

### 11.2 CDP renderer

- 保留 `<img>`。
- 继续使用 rAF 合帧。
- 修正缓存为最新帧覆盖，不因为 Map 重复 set 误判 LRU。
- 仅面板可见时建立帧订阅。

### 11.3 FFmpeg renderer

- 使用 `<video muted autoplay playsInline>`。
- 建立 `MediaSource`，创建 `video/mp4; codecs="avc1.42E01E"` 或由 worker status 返回的实际 codec string。
- 通过 `fetch('/api/ego/video')` 读取 `ReadableStream`。
- append queue 串行调用 `SourceBuffer.appendBuffer()`。
- 始终保持低延迟：当 `video.buffered` 落后 live edge 超过 500-800ms，跳到接近最新时间。
- 缓冲超过 2-3 秒时删除旧 range，防止长时间观看内存增长。
- generation 变化、SourceBuffer error、视频停滞或 fetch 断开时完整销毁 MediaSource 后重建，不能复用污染状态。

### 11.4 UI 状态

观察窗显示简洁状态：

```text
CDP · 20 FPS
FFmpeg · H.264 · VideoToolbox
正在请求屏幕权限
窗口被最小化或遮挡
Wayland FFmpeg 不支持，请切回 CDP
```

设置卡提供：

- 捕获后端。
- 画质档位。
- 高级区域中的 FPS、最大宽度、编码器。
- “检测 FFmpeg 能力”按钮及检测结果。

## 12. 配置模型

建议最终配置：

```js
{
  chromePath: "",

  captureBackend: "auto",
  streamProfile: "balanced",

  cdpFps: 20,
  cdpQuality: 55,
  cdpMaxWidth: 960,
  cdpBackstopIntervalMs: 3000,

  ffmpegFps: 20,
  ffmpegMaxWidth: 1280,
  ffmpegEncoder: "auto",
  ffmpegPath: "",
}
```

兼容策略：

- 现有 `castFpsCap` 映射到 `cdpFps`。
- 现有 `screencastQuality` 映射到 `cdpQuality`。
- 现有 `screencastMaxWidth` 映射到 `cdpMaxWidth`。
- 现有 `backstopIntervalMs` 映射到 `cdpBackstopIntervalMs`。

由于这些值已可能持久化，允许一个版本周期读取旧字段，但保存时只写新字段。迁移逻辑应集中在 `resolveConfig()`，不要散落在 worker 和前端。

## 13. 指标与诊断

worker 每 2 秒计算滑动指标，但只在 status 请求或低频 `metrics` SSE 事件中发送：

```js
{
  backend,
  sourceFps,
  sentFps,
  droppedFrames,
  bytesPerSecond,
  ackErrors,
  downstreamBlockedMs,
  captureLatencyMs,
  encoder,
  targetId,
}
```

CDP 重点关注：

- screencastFrame 到达频率。
- ACK 错误。
- 限帧丢弃数。
- SSE 背压时间。

FFmpeg 重点关注：

- 首个 init segment 时间。
- 编码进程 CPU 和退出码。
- fMP4 parser 错误。
- MSE 缓冲延迟。
- 黑帧/停滞检测。

日志不得逐帧输出，只记录状态切换和聚合指标，避免日志本身造成卡顿。

## 14. 错误处理与降级

错误码建议：

```text
cdp-ack-failed
cdp-start-failed
browser-disconnected
ffmpeg-not-installed
ffmpeg-not-executable
ffmpeg-encoder-unavailable
ffmpeg-capture-source-missing
capture-permission-required
capture-permission-denied
capture-source-not-visible
unsupported-ffmpeg-pipewire
video-stream-corrupt
video-player-unsupported
```

行为：

- `captureBackend=auto`：仅启动前能力检测失败时可选 CDP；运行中故障不反复自动切换，避免画面闪烁和难诊断。
- `captureBackend=ffmpeg`：失败后保持明确错误，提供用户操作切换。
- `captureBackend=cdp`：FFmpeg 不参与探测或启动。
- 任何错误都不得影响 `ego_*` 浏览器工具本身；观察窗失败必须是旁路故障。

## 15. 安全与隐私

- FFmpeg 后端捕获操作系统窗口/显示，范围可能超出网页内容，必须在启用时明确提示。
- 默认只捕获 ego 浏览器窗口或其内容区域，不默认捕获整个桌面。
- Wayland/macOS 系统授权必须由用户明确完成。
- 视频接口继续绑定 loopback worker，并经 DSH host 路由访问，不暴露独立公网端口。
- `/api/watch/*` 和 `/api/video/*` 复用 DSH 现有会话边界；若 host 路由未来可被跨站调用，需要增加 origin/CSRF 检查。
- FFmpeg 命令参数必须使用 argv 数组，不拼接 shell 字符串；窗口标题、DISPLAY 和路径不得进入 shell。

## 16. 文件改动规划

计划修改：

```text
package.json
  添加 ffmpeg-static 依赖，更新 scripts/tests

lib/config.js
  新配置 schema、旧字段迁移、默认值

lib/index.d.ts
  配置类型同步

lib/settings.js
  新配置桥接

lib/cast-server.js
  watch API 代理、视频二进制代理、背压

lib/client.js
  双 renderer、MSE 播放器、可见性订阅、设置 UI、状态提示

bin/ego-cast-worker.mjs
  CaptureManager、统一状态、路由接线、CDP 控制面保留

bin/capture-cdp.mjs
  正确 ACK、单 target、限帧、latest-frame 背压

bin/capture-ffmpeg.mjs
  FFmpeg 生命周期、编码 probe、fMP4 输出

bin/capture-platform.mjs
  Windows/X11/macOS/Wayland 来源发现和参数生成

bin/mp4-fragments.mjs
  有界 ISO BMFF box parser

tests/*.test.mjs
  配置、ACK、背压、MP4 parser、命令生成、生命周期测试

README.md
CHANGELOG.md
THIRD_PARTY_NOTICES.md
docs/ARCH.md
```

是否拆 `bin/*.mjs` 的判断：worker 已超过 1000 行，双后端继续内联会显著增加维护风险，因此这里允许按职责拆模块；不拆前端 `lib/client.js`，因为 DSH 客户端注入仍要求单文件 bundle。

## 17. 测试计划

### 17.1 单元测试

CDP：

- `screencastFrameAck` 使用 `params.sessionId` 作为 ACK 参数。
- flattened target session ID 仍作为命令 session 参数。
- `Cdp.call()` 对 CDP `error` reject。
- 20 FPS 限制下 60 FPS 输入只发送约 20 FPS，并始终发送最新帧。
- 下游阻塞时不堆积所有 JPEG。
- 无 watcher 时不启动 screencast。
- target 切换会 stop 旧 stream。

FFmpeg：

- 各平台 argv 生成不经过 shell。
- encoder probe 成功、失败和软件回退。
- 启动超时、异常退出和优雅 stop。
- stdout 任意切块情况下正确重组 `ftyp/moov/moof/mdat`。
- 非法 box length、超大 box 和截断流安全失败。
- 新订阅者先收到 init segment。
- generation 切换隔离旧进程 chunk。

配置：

- 默认值。
- 数值边界。
- 旧字段迁移。
- `captureBackend` 非法值回落。

### 17.2 集成测试

使用 fake FFmpeg Node fixture：

- 周期输出预生成 fMP4 fragments。
- 验证 worker 二进制路由不 Base64 化。
- 验证 host 代理保持 chunk 顺序。
- 模拟下游 `drain`，验证 pause/resume。
- 模拟进程崩溃，验证前端 generation 重建。

使用 mock CDP WebSocket：

- 发送滚动期间连续 `Page.screencastFrame`。
- 断言每帧 ACK 正确。
- 模拟导航、target 销毁和浏览器重连。

### 17.3 性能测试

固定场景：

1. 960x720 页面连续滚动 30 秒。
2. 动画/canvas 页面 30 秒。
3. 1080p 视频页面 30 秒。
4. 静态页面空闲 60 秒。
5. 面板关闭 60 秒。

记录：

- worker CPU/内存。
- Chrome CPU/GPU。
- DSH 前端 CPU/内存。
- 平均 FPS、P95 帧间隔。
- 端到端视觉延迟。
- 每秒传输字节。

目标基线：

```text
CDP 滚动：>= 15 FPS，P95 帧间隔 < 120ms
FFmpeg 滚动：>= 18 FPS，P95 帧间隔 < 90ms
面板关闭：不运行 FFmpeg，不保持 Page.startScreencast
静态页：不因透明动画持续满帧合成
前端缓冲：通常 < 800ms，不持续增长
```

绝对 CPU 数字与硬件相关，不设不现实的统一百分比；以同机现有版本为基线，要求明显下降并记录测试机器配置。

### 17.4 人工跨平台验收

Windows：

- Chrome 窗口移动、缩放、125% DPI。
- GDI 与可用硬件编码器。
- 窗口遮挡和最小化提示。

Linux X11/Xvfb：

- `DISPLAY` 来源正确。
- 浏览器和 FFmpeg 同显示。
- 软件编码与 VAAPI/NVENC 可用性。

Wayland：

- Portal 授权流程。
- 随包 FFmpeg 不支持 PipeWire 时错误信息准确。
- 切回 CDP 后功能正常。

macOS：

- 首次屏幕录制权限。
- Retina 坐标映射。
- VideoToolbox。
- 拒绝权限后的恢复指引。

## 18. 实施阶段

### 阶段 A：修复和量化 CDP

1. 为 `Cdp.call()` 增加协议 error reject。
2. 修复 screencast ACK。
3. 删除默认强制重绘。
4. 实现单 target 订阅。
5. 实现 FPS 限制和 latest-frame 背压。
6. 增加聚合指标。
7. 补单元和 mock CDP 测试。
8. 跑 `pnpm test`、`pnpm run build`。

阶段验收：连续滚动不再落到 backstop；关闭面板后 screencast 停止。

### 阶段 B：统一 CaptureManager 与路由

1. 引入统一后端状态机。
2. 增加 watch lease API。
3. 改造 sidebar 和浮动面板可见性生命周期。
4. 保持 CDP 后端功能完整。
5. 增加 host/worker 状态代理测试。

阶段验收：在尚未加入 FFmpeg 时，CDP 已完全经统一接口运行。

### 阶段 C：FFmpeg 核心视频流

1. 添加 `ffmpeg-static`。
2. 实现二进制路径解析和能力检测。
3. 实现 FFmpeg 进程生命周期。
4. 实现 fMP4 parser 和 init/media fragment 广播。
5. 实现 worker/host 二进制 HTTP 流及背压。
6. 使用 fake FFmpeg 完成自动测试。

阶段验收：测试视频源可在前端 `<video>` 连续播放，流不经过 Base64。

### 阶段 D：前端双 renderer

1. 增加 MSE player。
2. 增加 backend 和 profile 设置。
3. 实现切换清理和 generation 重连。
4. 增加低延迟追帧和旧 buffer 清理。
5. 同步 sidebar 与浮动面板。

阶段验收：运行中可在 CDP/FFmpeg 间切换，无双重捕获、无旧流串入。

### 阶段 E：平台适配

1. Windows gdigrab/硬件编码。
2. Linux X11/Xvfb。
3. macOS avfoundation/权限/VideoToolbox。
4. Wayland Portal 能力探测和明确失败路径。
5. 逐平台人工坐标和遮挡测试。

阶段验收：每个平台要么成功使用 FFmpeg，要么给出准确、可操作的限制信息；CDP 始终可用。

### 阶段 F：文档与发布准备

1. 更新 README 使用说明、权限和限制。
2. 更新 ARCH 双后端架构。
3. 更新 CHANGELOG。
4. 更新第三方许可证。
5. 检查 npm/git 安装时 `ffmpeg-static` 二进制获取行为。
6. 跑完整测试和 build。
7. 由人类重启 `dsh web` 并完成浏览器硬刷新验收。

## 19. 实施顺序中的停止条件

以下情况应停止继续堆功能并先解决根因：

- ACK 修复后 CDP 仍没有滚动帧：先用 CDP 协议日志确认 Chrome 是否发帧，不立即恢复 200ms 截图。
- MSE 必须积累超过 1 秒才能播放：先调整 fragment/GOP，不接受以高延迟完成“能播”。
- FFmpeg 捕获区域包含错误窗口或敏感桌面内容：停止发布该平台后端。
- Wayland 随包 FFmpeg 无 PipeWire 支持：按设计报告不支持，不使用 root workaround。
- 引入 `ffmpeg-static` 导致插件安装策略与 DSH bundle 规则冲突：先确定预构建/依赖分发方案，不把二进制手工提交进 `lib/`。

## 20. 完成定义

- CDP ACK 正确并有回归测试。
- 滚动场景不依赖高频 screenshot backstop。
- 用户可在设置中选择 `auto/cdp/ffmpeg`。
- FFmpeg 视频为二进制 H.264/fMP4，不经过 SSE/Base64。
- sidebar 和浮动面板均支持双 renderer。
- 面板不可见时停止画面后端。
- 所有后端和平台失败都有明确状态。
- 单元、集成、build 全部通过。
- Windows、Linux X11、Wayland、macOS 的支持范围和限制有文档。
- 第三方许可证完整。
- 人类完成 DSH Web 中的滚动、切换、输入坐标和资源占用验收。
