# Windows gfxcapture 可行性验证

日期：2026-08-17

## 结论

方案可行。Windows 上使用 FFmpeg `gfxcapture` 按 HWND 捕获 ego Chrome，能够直接取得目标窗口的 D3D11 surface，不再依赖桌面坐标。窗口被其他应用遮挡或移动后，采集仍保持目标 Chrome 内容。

推荐的数据路径：

```text
Chrome HWND
  -> Windows.Graphics.Capture / D3D11
  -> fps=30 + 连续时间戳
  -> h264_mf 硬件编码
  -> 100ms fragmented MP4
  -> 现有 Mp4FragmentParser / MediaSource
```

## 验证环境

- ego Chrome PID：`2612`
- ego Chrome HWND：`19797640`（`0x12E1688`）
- 初始窗口 bounds：`395,99 1280x900`
- 捕获内容尺寸：`1264x892`
- 下载位置：`C:\Users\Administrator\AppData\Local\Temp\opencode\ffmpeg-master-latest-win64-gpl`
- FFmpeg：`N-126188-g426841da9d-20260817`
- 构建来源：`BtbN/FFmpeg-Builds` 的 `ffmpeg-master-latest-win64-gpl.zip`

该构建确认包含：

- `gfxcapture` source filter
- `hwnd` 精确窗口选择
- D3D11 硬件帧输出
- `h264_mf`、`h264_nvenc`、`h264_qsv`、`h264_amf`

## 功能验证

### 精确窗口捕获

使用 `gfxcapture=hwnd=19797640` 成功输出 ego Chrome 的 `1264x892` 页面内容。

同一时刻分别截图：

- `gfxcapture(hwnd)`：仍显示目标 ego Chrome 的猫视频页面。
- 旧 `gdigrab desktop crop`：显示覆盖该屏幕区域的另一张 Bilibili 页面。

这证明 `gfxcapture` 取得的是目标窗口 surface，而不是用户当前可见桌面像素。

### 窗口移动

将目标窗口从 `(395,99)` 临时移动到 `(40,40)` 后，原 HWND 继续输出正确页面。验证结束后窗口已恢复到 `(395,99)`。

### H.264 和 fMP4

`gfxcapture` 的 D3D11 帧可以直接交给 `h264_mf`：

```text
MFT name: NVIDIA H.264 Encoder MFT
codec: H.264 Constrained Baseline
resolution: 1264x892
rate: 30 FPS
```

输出的 fragmented MP4 可由现有 `Mp4FragmentParser` 解析。2 秒、100ms 分片测试得到：

```json
{"init":809,"fragments":20,"mediaBytes":39156,"averageFragmentBytes":1958}
```

## 性能结果

10 秒、30 FPS、D3D11 直通 `h264_mf`：

```text
wall time:          10.356s
FFmpeg CPU time:     0.328s
single-core usage:   3.2%
whole-machine usage: 0.26% (12 logical processors)
exit code:           0
```

100ms fMP4 分片时序：

```text
init segment:          487ms
first media fragment:  545ms
steady fragment gap:    94ms average
```

首次启动包含 FFmpeg、WGC 和编码器初始化；稳定串流分片间隔满足低于 300ms 的目标。

## 验证中发现的必要修正

### 不可只设置 max_framerate

本机报告：

```text
Setting minimum update interval unavailable, framerate may be limited
```

仅设置 `max_framerate=30` 时，compositor 仍可能按更高更新率交付帧并产生重复时间戳。过滤链必须显式加入：

```text
fps=30,setpts=N/(30*TB)
```

### 必须跳过 MP4 trailer

现有 parser 不接受 FFmpeg 正常结束时写出的 `mfra` box。流式输出应增加：

```text
movflags=empty_moov+default_base_moof+frag_keyframe+skip_trailer
```

否则优雅停止时会触发 `unexpected MP4 media box mfra`。

### 分片时长应从 500ms 降到 100ms

当前实现使用 `frag_duration=500000`，仅 muxer 分片就会引入约 500ms 延迟，不满足低于 300ms 的目标。验证表明 `frag_duration=100000` 可稳定产生约 100ms 的媒体分片。

### NVENC 不应是唯一硬编路径

master 构建要求 NVENC API 13.1，而本机驱动提供 13.0，直接 `h264_nvenc` 失败。`h264_mf -hw_encoding 1` 成功选择 NVIDIA H.264 Encoder MFT，并保持 D3D11 硬件帧路径。

Windows 编码器优先级建议：

```text
h264_mf hardware -> h264_nvenc/qsv/amf probe -> libx264 fallback
```

## 实现边界

本轮未启动 `dsh web`，未改动插件运行代码，仅验证底层捕获、编码、分片和 parser 兼容性。

正式实现仍需完成：

1. 从 `browser.json` 读取 browser PID。
2. 枚举该进程的可见顶层窗口并取得 HWND。
3. 多 Chrome 窗口时，结合 `Browser.getWindowForTarget` bounds 匹配 target 与 HWND。
4. 探测 FFmpeg 是否包含 `gfxcapture` 和可用硬件编码器。
5. 将 Windows `desktop crop` 替换为 `gfxcapture(hwnd)`，不可静默回退到桌面采集。
6. 处理 resize、窗口关闭、最小化和 target 切换。
7. 决定支持 `gfxcapture` 的 Windows FFmpeg 二进制分发方式；当前 `ffmpeg-static@5.2.0` 不满足要求。
8. 完成 worker 到浏览器 MediaSource 的端到端延迟验证。
