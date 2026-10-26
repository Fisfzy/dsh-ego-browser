/** Injected by the DSH ModuleLoader factory wrapper (tsdown banner). */
declare function require(id: string): any

		// #region ego-browser client: realtime browser watch tab
		//
		// The watch UI is a tab in DSH's native right sidebar (with an optional
		// dsh-better-sidebar fallback). It shows what the agent's ego-browser is
		// doing in real time: live pages (URL + title) plus a CDP screencast,
		// polled from /api/ego/spaces and pushed through /api/ego/stream by the
		// ego-cast worker attached to the agent's own Chrome. The old floating
		// FAB/overlay was removed in 0.9.3 — the official sidebar covers it.
		//
		// Design constraints (kept deliberately minimal / read-only):
		//  - READ-ONLY: only displays what the agent browser is already doing;
		//    there is no pause/resume/navigate control here (that stays out of
		//    scope to avoid racing the running agent).
		//  - Self-cleaning: everything is registered through ctx.effect so
		//    unmount / hot-reload restores the DOM and stops the poller.
		//
		// == 内部结构（维护前先看 docs/ARCH.md）==
		//   TAB_CSS + ICON_*        : 侧栏样式与图标
		//   apply()                 : 入口，挂载原生侧栏 Tab / betterSidebar Tab / 设置卡
		//   LivePreviewController   : spaces 轮询 + SSE 实时帧 + 双缓冲
		//   EgoBrowserTab           : React 侧栏 UI
		// 注意：本前端是单文件（受 DSH 注入机制限制），不要在页面上拆文件；
		//   数据源 = 轮询 /api/ego/spaces + SSE /api/ego/stream(实时帧)。
		// #endregion

		// ── Settings card dependencies ───────────────────────────────────
		// Required up-front so the settings card + watch panel share the same
		// React runtime. The ModuleLoader factory's `require` resolves these
		// from the profile's node_modules (declared as peerDependencies).
		//
		// [0.1.2-alpha.1 migration] `@deepseek-ai/dsh-client-runtime` was renamed
		// to `@deepseek-ai/dsh-client-store` (packages/client/store); the browser
		// module graph now resolves the store as a static module under the plain
		// package id (no `/client` subpath). createSnapshotStore kept its shape.
		var React = require('react')
		var runtimeClient = require('@deepseek-ai/dsh-client-store')
		var createSnapshotStore = runtimeClient.createSnapshotStore
		// bindSnapshotSelector inlined from dsh-client-ui-renderer (shell-only
		// glue; business plugins depend on runtime + ui-slots only). Uses
		// React 18's built-in useSyncExternalStore with per-snapshot selector
		// memoization via useRef.
		var useSyncExternalStore = React.useSyncExternalStore
		var useRef = React.useRef
		function bindSnapshotSelector(source) {
			var subscribe = function (fn) { return source.subscribe(fn) }
			var getSnapshot = function () { return source.getSnapshot() }
			return function useSelector(sel, eq) {
				var snapshot = useSyncExternalStore(subscribe, getSnapshot)
				var prevSnapshotRef = useRef()
				var prevSelectedRef = useRef()
				if (prevSnapshotRef.current !== snapshot) {
					prevSnapshotRef.current = snapshot
					prevSelectedRef.current = sel(snapshot)
				}
				return prevSelectedRef.current
			}
		}

		// 'betterSidebar' must NOT be declared here: hosts without
		// dsh-better-sidebar have no such service, and the module loader keeps
		// any row that statically injects it pending forever — which blocks the
		// whole web boot (issue #29, reproduced on DSH 0.1.2-rc.1 without the
		// sidebar installed). Probe it defensively in apply() instead.
		const inject = ['slots', 'locale', 'connection']

		// ── Settings card: locale ─────────────────────────────────────────
		var SETTINGS_NS = 'ego-browser'
		var en = {
			title: 'ego-browser',
			intro: 'Agent browser integration. Configure the Chrome/Chromium binary path and cast parameters below.',
			isolateSpaces: 'Space isolation',
			isolateSpacesHint: 'Disabled: use persistent disk profile, logins stay across restarts. Enabled: memory-only sandbox per task.',
			isolateSpacesOff: 'Disabled (persistent profile, keep logins)',
			isolateSpacesOn: 'Enabled (isolated memory sandbox)',
		idleTimeoutMin: 'Idle auto-stop (minutes)',
		idleTimeoutMinHint: 'Stop the backing browser after N minutes without an ego_* call (0 = off). It cold-starts on the next call (~2-4s). Watching the panel does not count as activity.',
		disableFrameRelay: 'Disable live frame relay',
		disableFrameRelayHint: 'No picture is relayed at all: no ego-cast worker, no CDP/WGC screencast capture, no ffmpeg pull, and the watch panel opens no stream. ego_* tools keep working normally.',
		disableFrameRelayOff: 'Off (live view enabled)',
		disableFrameRelayOn: 'On (no picture pushed to this page)',
		residentExecutor: 'Resident executor',
		residentExecutorHint: 'Reuse one long-lived `ego-browser --serve` process across ego_* calls: the first call pays startup, later calls skip it (~16ms). A dead resident falls back to a fresh spawn automatically.',
		residentExecutorOff: 'Off (spawn per call)',
		residentExecutorOn: 'On (resident process)',
		residentIdleMin: 'Resident idle stop (minutes)',
		residentIdleMinHint: 'Stop the resident process after N minutes without an ego_* call (0 = keep it until the plugin unmounts). The browser itself is not affected.',
		relayDisabledTitle: 'Live frame relay is disabled',
		relayDisabledBody: 'Turn off "Disable live frame relay" in Settings → Plugins → ego-browser to see the live view here.',
		minUnit: 'min',
		loginImportTitle: 'Import logins from system browser',
		loginImportIntro: 'Copy login cookies from your daily Chrome/Edge/Brave into the agent browser (CDP passthrough — no offline decryption). Probe first, then import with an explicit domain list.',
		loginImportSource: 'Source',
		loginImportDomains: 'Domains (comma-separated; empty = ALL)',
		loginImportDomainsHint: 'e.g. bilibili.com, zhihu.com — subdomains included. Prefer an explicit list over importing everything.',
		loginImportCloseSource: 'Close the source browser first if it is running (windows restore on next launch)',
		loginImportProbe: 'Probe',
		loginImportRun: 'Import',
		loginImportBusy: 'Working… (a running source browser may need to close first)',
		loginImportProbeResult: 'Importable: {matched} cookies across {domains} domains (read {total} total) — nothing was written.',
		loginImportResult: 'Imported {written} cookies across {domains} domains from {source}. They persist across restarts.',
		loginImportClosed: ' (source browser was closed and can be reopened)',
			chromePath: 'Browser binary path',
			chromePathHint: 'Path to the Chrome/Chromium/Edge binary. Empty = auto-detect.',
			captureBackend: 'Capture backend', streamProfile: 'Quality profile', cdpFps: 'CDP FPS', cdpQuality: 'CDP JPEG quality', cdpMaxWidth: 'CDP max width', cdpBackstopIntervalMs: 'CDP recovery interval', ffmpegFps: 'FFmpeg FPS', ffmpegMaxWidth: 'FFmpeg max width', ffmpegBitrateKbps: 'FFmpeg bitrate', ffmpegEncoder: 'FFmpeg encoder', ffmpegPath: 'FFmpeg binary path', githubMirror: 'GitHub mirror', fpsUnit: 'fps', pxUnit: 'px', kbpsUnit: 'kbps', msUnit: 'ms',
			ffmpegTitle: 'FFmpeg installation', ffmpegReady: 'Ready', ffmpegMissing: 'No compatible FFmpeg found', ffmpegChecking: 'Checking local FFmpeg…', ffmpegDownloading: 'Downloading FFmpeg…', ffmpegVerifying: 'Verifying download…', ffmpegExtracting: 'Extracting FFmpeg…', ffmpegProbing: 'Checking capture capabilities…', ffmpegUnsupported: 'FFmpeg capture is unsupported on this platform', ffmpegFailed: 'FFmpeg installation failed', ffmpegSource: 'Source', ffmpegVersion: 'Version', ffmpegInstall: 'Download FFmpeg', ffmpegReinstall: 'Reinstall', ffmpegRecheck: 'Recheck', ffmpegRequired: 'FFmpeg (install required)', githubMirrorHint: 'Replaces https://github.com for GitHub downloads, for example https://gh-proxy.com/github.com.',
			egoCliArgs: 'Extra ego-browser CLI args', egoCliArgsHint: 'Appended to `ego-browser nodejs` argv. Takes effect on the next ego_* call. Blocked: --status/--stop/--open/--spaces/--help (they exit before the heredoc runs). Use --headless via the headless env instead.',
			chromeArgs: 'Extra Chrome launch args', chromeArgsHint: 'Appended to the Chrome launch argv. Takes effect on the next browser cold start (the browser is a singleton — run `ego-browser --stop` or restart DSH to relaunch). Blocked: --user-data-dir/--remote-debugging-port/--remote-allow-origins/--headless/--no-startup-window/--proxy-server (use EGO_LINUX_PROXY for the proxy).',
			save: 'Save', saving: 'Saving…', discard: 'Discard',
			unsaved: 'Unsaved', readOnly: 'Settings are read-only in this deployment.',
			namespaceUnavailable: 'The ego-browser configuration channel is unavailable. Please retry later.',
			retry: 'Retry',
			expand: 'Show settings', collapse: 'Hide settings',
		}
		var zh = {
			title: 'ego-browser',
			intro: 'Agent 浏览器集成。在下方配置 Chrome/Chromium 浏览器路径及推流参数。',
			isolateSpaces: '任务空间沙盒隔离',
			isolateSpacesHint: '默认关闭：使用磁盘持久化 Profile，任务中登录的账号跨电脑重启永久保留；开启后使用内存临时沙盒隔离，任务结束不落盘。',
			isolateSpacesOff: '关闭（持久化登录态，跨电脑重启不丢失）',
			isolateSpacesOn: '开启（严格沙盒隔离，任务结束不落盘）',
		idleTimeoutMin: '空闲自动回收（分钟）',
		idleTimeoutMinHint: 'N 分钟没有任何 ego_* 调用后自动关闭后台浏览器进程（0 = 关闭）。下次调用自动冷启动（约 2-4 秒）。观看观察窗不算活动。',
		disableFrameRelay: '禁用画面回传',
		disableFrameRelayHint: '完全不回传画面：不启动 ego-cast worker，不做 CDP/WGC 屏幕采集与 ffmpeg 拉流，观察窗不再建立任何拉流连接。ego_* 工具本身照常可用。',
		disableFrameRelayOff: '关闭（保留实时画面）',
		disableFrameRelayOn: '开启（不回传任何画面）',
		residentExecutor: '常驻执行进程',
		residentExecutorHint: '复用同一个 ego-browser --serve 进程执行 ego_* 调用：首次调用支付启动开销，之后每次约 16ms；常驻进程失效时自动回退到一次性 spawn。',
		residentExecutorOff: '关闭（每次调用独立 spawn）',
		residentExecutorOn: '开启（常驻进程）',
		residentIdleMin: '常驻空闲停止（分钟）',
		residentIdleMinHint: 'N 分钟没有 ego_* 调用后停止常驻进程（0 = 一直保留到插件卸载）。不影响浏览器本体。',
		relayDisabledTitle: '画面回传已禁用',
		relayDisabledBody: '在「设置 → 插件 → ego-browser」中关闭「禁用画面回传」后，这里才会显示实时画面。',
		minUnit: '分钟',
		loginImportTitle: '从系统浏览器导入登录态',
		loginImportIntro: '把你日常 Chrome/Edge/Brave 里的登录 cookie 复制进 agent 浏览器（CDP 透传，不做离线解密）。建议先「探测」看可导入项，再按域名导入。',
		loginImportSource: '来源',
		loginImportDomains: '域名（逗号分隔，留空 = 全部）',
		loginImportDomainsHint: '例如 bilibili.com, zhihu.com — 含子域名。建议明确列出，不要全量导入。',
		loginImportCloseSource: '源浏览器运行中则先优雅关闭（窗口下次启动可恢复）',
		loginImportProbe: '探测',
		loginImportRun: '导入',
		loginImportBusy: '正在处理…（运行中的源浏览器可能需要先关闭）',
		loginImportProbeResult: '可导入 {matched} 条 cookie（{domains} 个域名，共读取 {total} 条）——尚未写入。',
		loginImportResult: '已从{source}导入 {written} 条 cookie（{domains} 个域名），跨重启保留。',
		loginImportClosed: '（源浏览器已关闭，可重新打开）',
			chromePath: '浏览器路径',
			chromePathHint: 'Chrome/Chromium/Edge 可执行文件路径。留空 = 自动检测。',
			captureBackend: '捕获后端', streamProfile: '画质档位', cdpFps: 'CDP 帧率', cdpQuality: 'CDP JPEG 质量', cdpMaxWidth: 'CDP 最大宽度', cdpBackstopIntervalMs: 'CDP 恢复截图间隔', ffmpegFps: 'FFmpeg 帧率', ffmpegMaxWidth: 'FFmpeg 最大宽度', ffmpegBitrateKbps: 'FFmpeg 码率', ffmpegEncoder: 'FFmpeg 编码器', ffmpegPath: 'FFmpeg 路径', githubMirror: 'GitHub 镜像源', fpsUnit: 'fps', pxUnit: 'px', kbpsUnit: 'kbps', msUnit: 'ms',
			ffmpegTitle: 'FFmpeg 安装', ffmpegReady: '已就绪', ffmpegMissing: '未找到兼容的 FFmpeg', ffmpegChecking: '正在检测本机 FFmpeg…', ffmpegDownloading: '正在下载 FFmpeg…', ffmpegVerifying: '正在校验下载文件…', ffmpegExtracting: '正在解压 FFmpeg…', ffmpegProbing: '正在检查捕获能力…', ffmpegUnsupported: '当前平台不支持 FFmpeg 捕获', ffmpegFailed: 'FFmpeg 安装失败', ffmpegSource: '来源', ffmpegVersion: '版本', ffmpegInstall: '下载 FFmpeg', ffmpegReinstall: '重新下载', ffmpegRecheck: '重新检测', ffmpegRequired: 'FFmpeg（需要安装）', githubMirrorHint: '替换 https://github.com，例如 https://gh-proxy.com/github.com。',
			egoCliArgs: 'ego-browser CLI 附加参数', egoCliArgsHint: '追加到 `ego-browser nodejs` argv。下一次 ego_* 工具调用即生效。禁止：--status/--stop/--open/--spaces/--help（会在 heredoc 执行前退出）。--headless 请走 headless 环境变量。',
			chromeArgs: 'Chrome 启动附加参数', chromeArgsHint: '追加到 Chrome 启动 argv。仅在浏览器下次冷启动时生效（浏览器是单例常驻——需运行 `ego-browser --stop` 或重启 DSH 才会重新启动）。禁止：--user-data-dir/--remote-debugging-port/--remote-allow-origins/--headless/--no-startup-window/--proxy-server（代理请用 EGO_LINUX_PROXY）。',
			save: '保存', saving: '保存中…', discard: '放弃',
			unsaved: '未保存', readOnly: '当前部署下设置只读。',
			namespaceUnavailable: 'ego-browser 配置通道不可用，请稍后重试。',
			retry: '重试',
			expand: '展开设置', collapse: '收起设置',
		}

		// ── Watch panel locale ────────────────────────────────────────────
		var _egoLocale = (function () {
			try { var lang = navigator.language || ''; return lang.startsWith('zh') ? 'zh' : 'en' } catch { return 'en' }
		})()
		var watchEn = {
			title: 'Agent Browser',
			titleLive: 'Agent Browser · Live',
			liveView: 'Live view',
			pinned: 'Pinned',
			realtime: 'Live',
			noScreenshot: '(no screenshot — about:blank or browser not rendering)',
			noActivePages: 'No active browser pages',
			noActiveHint: 'Pages will appear here as the agent browses with ego_*',
			openExternal: 'Open real page',
		raiseWindow: 'Pop out window',
		raiseWindowHint: 'Raise the agent browser as a real window (a headless instance is replaced by a visible one on the same profile)',
			sizeSyncOff: '🔒 Size lock',
			sizeSyncOn: '🔓 Size sync',
			sizeSyncHint: 'Unlocked: resizing this panel resizes the REAL agent browser window (CDP window bounds). Click again to lock.',
			sizePresets: 'Size presets',
			sizePresetsHint: 'Set the agent browser window to a fixed aspect ratio',
			resizeHint: 'Drag to resize the agent browser window',
			sizeApiOutdated: 'Size API not loaded — restart DSH to pick up the new host build',
			executorResident: 'resident',
			executorStarting: 'resident · starting',
			executorOneShot: 'one-shot',
			executorParked: 'resident parked',
			noUrl: 'No URL to open',
			closeTab: 'Close tab',
			newTab: '(new tab)',
			history: 'Browsing history',
			historyHide: 'Hide history',
			historyShow: 'Show history',
			noHistory: 'No browsing history',
			current: 'current',
			refresh: 'Refresh',
			backToLive: '← Back to live',
			dragHint: 'Drag to move panel',
			loginTitle: 'Log in in the agent browser window (use the Pop out window button in this panel if you cannot find it)',
			loginBtn: 'Logged in, save',
			loginSaving: 'Saving…',
			loginSaved: 'Saved {n} sessions',
			loginNotConnected: 'Browser not connected',
			loginFailed: 'Save failed',
			loginDismiss: 'Dismiss',
			captchaTitle: '⚠️ CAPTCHA detected',
			captchaHint: 'Complete the verification in the agent browser window (use the Pop out window button above to bring it to the front); the agent will continue.',
			captchaDismiss: 'Dismiss',
			hintReset: 'Reset · scroll to pan · Ctrl+scroll to zoom · double-click to reset',
			hintPan: 'Ctrl+scroll to zoom · Ctrl+drag to pan · double-click to reset',
			hintScroll: 'Ctrl+drag to pan · scroll to pan',
			hintNotCaptured: 'Not captured · operation not delivered · click again to recover',
			failed: 'failed',
			stale: '⚠ Not captured',
			captured: 'Captured',
			fabTitle: 'Agent Browser live view',
			settingsTitle: 'Show settings',
			settingsHide: 'Hide settings',
			relayDisabledTitle: 'Live frame relay is disabled',
			relayDisabledBody: 'Turn off “Disable live frame relay” in Settings → Plugins → ego-browser to see the live view here. No stream is opened meanwhile.',
		}
		var watchZh = {
			title: 'Agent 浏览器',
			titleLive: 'Agent 浏览器 · 实时',
			liveView: '只读观察窗',
			pinned: '已固定查看',
			realtime: '正在实时浏览',
			noScreenshot: '（暂无截图 — about:blank 或浏览器未渲染）',
			noActivePages: '暂无活跃浏览器页',
			noActiveHint: '当 agent 开始用 ego_* 操作网页时，这里会实时显示',
			openExternal: '⧉ 打开真实页',
		raiseWindow: '弹出窗口',
		raiseWindowHint: '把 agent 浏览器弹出为真实窗口（无头实例会被同 Profile 的有头实例替换，标签页保留）',
			sizeSyncOff: '🔒 锁定尺寸',
			sizeSyncOn: '🔓 尺寸同步',
			sizeSyncHint: '解锁后拖动面板会直接改变 agent 浏览器真实窗口大小（CDP 窗口 bounds）；再点一下锁定。',
			sizePresets: '尺寸预设',
			sizePresetsHint: '按固定比例设置 agent 浏览器窗口',
			resizeHint: '拖动调整 agent 浏览器窗口大小',
			sizeApiOutdated: '尺寸接口未就绪：请重启 DSH 以加载最新 host 构建',
			executorResident: '常驻',
			executorStarting: '常驻·启动中',
			executorOneShot: '一次性',
			executorParked: '常驻已停用',
			noUrl: '无可打开的地址',
			closeTab: '关闭标签',
			newTab: '(新标签页)',
			history: '历史浏览轨迹',
			historyHide: '收起历史轨迹',
			historyShow: '历史浏览轨迹',
			noHistory: '暂无浏览记录',
			current: '当前',
			refresh: '刷新',
			backToLive: '← 返回实时',
			dragHint: '拖动移动面板',
			loginTitle: '需要账号登录时，请在 agent 浏览器窗口完成登录（找不到窗口就点本面板的「弹出窗口」按钮把它抬到最前）。',
			loginBtn: '已登录，保存',
			loginSaving: '保存中…',
			loginSaved: '已保存 {n} 条会话',
			loginNotConnected: '未连接浏览器',
			loginFailed: '保存失败',
			loginDismiss: '关闭提示',
			captchaTitle: '⚠️ 检测到人机验证',
			captchaHint: '请在 agent 浏览器窗口手动完成验证（点上方「弹出窗口」按钮可把窗口抬到最前）；agent 会继续。',
			captchaDismiss: '关闭提示',
			hintReset: '已复位 · 滚轮滚动页面 · Ctrl+滚轮缩放 · 双击复位',
			hintPan: 'Ctrl+滚轮缩放 · Ctrl+拖动平移 · 双击复位',
			hintScroll: 'Ctrl+拖动平移 · 滚轮滚动页面',
			hintNotCaptured: '画面未接管 · 本次操作未送达 · 再点一次即可恢复',
			failed: '失败',
			stale: '⚠ 未接管',
			captured: '已接管',
			fabTitle: 'Agent 浏览器实时视图',
			settingsTitle: '展开设置',
			settingsHide: '收起设置',
			relayDisabledTitle: '画面回传已禁用',
			relayDisabledBody: '在「设置 → 插件 → ego-browser」中关闭「禁用画面回传」后，这里才会显示实时画面。禁用期间不会建立任何拉流连接。',
		}
		var watchDict = { en: watchEn, zh: watchZh }
		function wt(key, params = undefined) {
			var dict = watchDict[_egoLocale] || watchEn
			var text = dict[key] || watchEn[key] || key
			if (params) { for (var k in params) { text = text.replace(new RegExp('{' + k + '}', 'g'), String(params[k])) } }
			return text
		}

		// ── Live frame relay switch (settings: disableFrameRelay) ───────────
		// The host owns the switch; this module-level mirror is what keeps the
		// client honest about it: while the relay is OFF the panel opens NO pull
		// connection at all (no EventSource on /api/ego/stream, no /api/ego/video
		// fetch) and renders an explicit disabled state instead of reconnect-looping.
		// The value arrives from two places: /ego/api/get|set (the settings card) and
		// the `frameRelay` flag the host attaches to /api/ego/spaces and
		// /api/ego/watch/status (the flag the panels read right before connecting).
		var frameRelayDisabled = false
		var frameRelayListeners = []
		function frameRelaySet(disabled) {
			disabled = disabled === true
			if (disabled === frameRelayDisabled) return
			frameRelayDisabled = disabled
			for (var i = 0; i < frameRelayListeners.length; i++) {
				try { frameRelayListeners[i](disabled) } catch (e) {}
			}
		}
		function frameRelaySubscribe(cb) {
			frameRelayListeners.push(cb)
			return function () {
				var i = frameRelayListeners.indexOf(cb)
				if (i >= 0) frameRelayListeners.splice(i, 1)
			}
		}
		// Host-reported relay state on a status payload. Returns true when the relay
		// is off (and mirrors it into the module flag).
		function frameRelayOff(status) {
			if (!status || typeof status !== 'object' || status.frameRelay !== false) return false
			frameRelaySet(true)
			return true
		}

		// ── Panel size → real browser window (size sync) ────────────────────
		// The live image is a screencast frame; by default resizing the panel only
		// scales that frame. The panel's size-sync toggle makes a panel resize set
		// the REAL agent browser window instead, so the page reflows at the size
		// the user is drawing. The worker turns the reported image box (CSS px)
		// into window bounds through CDP. Sends are debounced (a drag emits a size
		// event per pixel) and skipped when the box did not actually change, so a
		// periodic re-render cannot spam the worker.
		var SIZE_SYNC_KEY = 'dsh-ego:size-sync'
		function sizeSyncStored() {
			try { return window.localStorage.getItem(SIZE_SYNC_KEY) === '1' } catch (e) { return false }
		}
		function sizeSyncStore(enabled) {
			try { window.localStorage.setItem(SIZE_SYNC_KEY, enabled ? '1' : '0') } catch (e) {}
		}
		function createWindowSizeSync() {
			var enabled = false
			var element = null
			var observer = null
			var timer = null
			var inFlight = false
			var baseWidth = 0     // panel width at the last applied window size
			var pointerDown = false
			var dragUntil = 0     // pointer-drag grace after the last pointerup
			var lastAt = 0
			function onPointerDown() { pointerDown = true }
			function onPointerUp() {
				if (!pointerDown) return
				pointerDown = false
				dragUntil = Date.now() + 350
				if (enabled) schedule()
			}
			function panelWidth() {
				return Math.round((element && element.clientWidth) || 0)
			}
			function send() {
				timer = null
				if (!enabled || !element) return
				var w = panelWidth()
				if (w < 120) return
				var now = Date.now()
				// Only the user's own drag may change the browser window. Layout
				// changes that follow our own request (or a DSH window resize) are
				// absorbed as the new baseline — otherwise the window would chase
				// the sidebar width and shrink to nothing.
				if (!pointerDown && now > dragUntil) { baseWidth = w; return }
				var delta = w - baseWidth
				if (Math.abs(delta) < 12) return
				if (now - lastAt < 200) { schedule(); return }
				if (inFlight) { schedule(); return }
				inFlight = true
				lastAt = now
				var sentBase = w
				fetch('/api/ego/window-size', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ delta: delta }),
				}).then(function (r) { return r.json().catch(function () { return null }) })
					.then(function (parsed) {
						if (parsed && parsed.ok === true) baseWidth = sentBase
					})
					.catch(function () { return null })
					.finally(function () { inFlight = false })
			}
			function schedule() {
				if (timer !== null) return
				timer = setTimeout(send, 180)
			}
			function attach(el) {
				element = el || null
				if (!enabled) return
				if (observer !== null) { observer.disconnect(); observer = null }
				if (element && typeof ResizeObserver !== 'undefined') {
					try {
						observer = new ResizeObserver(function () { if (enabled) schedule() })
						observer.observe(element)
					} catch (e) { observer = null }
				}
				if (baseWidth === 0) baseWidth = panelWidth()
			}
			function setEnabled(next) {
				enabled = next === true
				sizeSyncStore(enabled)
				if (!enabled) {
					if (timer !== null) { clearTimeout(timer); timer = null }
					if (observer !== null) { observer.disconnect(); observer = null }
					document.removeEventListener('pointerdown', onPointerDown, true)
					document.removeEventListener('pointerup', onPointerUp, true)
					return
				}
				// Unlocking must NOT resize anything by itself: it only arms the
				// drag mapping. The window keeps its current size until the user
				// drags the sidebar edge.
				baseWidth = panelWidth()
				lastAt = 0
				document.addEventListener('pointerdown', onPointerDown, true)
				document.addEventListener('pointerup', onPointerUp, true)
				if (element) attach(element)
			}
			function dispose() {
				if (timer !== null) { clearTimeout(timer); timer = null }
				if (observer !== null) { observer.disconnect(); observer = null }
				document.removeEventListener('pointerdown', onPointerDown, true)
				document.removeEventListener('pointerup', onPointerUp, true)
				element = null
			}
			return {
				isEnabled: function () { return enabled },
				setEnabled: setEnabled,
				attach: attach,
				dispose: dispose,
			}
		}

		// ── Settings card: store ──────────────────────────────────────────
		function initialSettingsState() {
			return {
				status: 'idle',        // 'idle' | 'loading' | 'ready'
				available: false,      // true after a successful /ego/api/get
				writable: false,       // false when settings service is absent
				draft: { isolateSpaces: false, disableFrameRelay: false, residentExecutor: false, residentIdleMin: '30', idleTimeoutMin: '0', chromePath: '', captureBackend: 'auto', streamProfile: 'balanced', cdpFps: '20', cdpQuality: '55', cdpMaxWidth: '1280', cdpBackstopIntervalMs: '3000', ffmpegFps: '20', ffmpegMaxWidth: '1280', ffmpegBitrateKbps: '4000', ffmpegEncoder: 'auto', ffmpegPath: '', githubMirror: '', egoCliArgs: '', chromeArgs: '' },
				ffmpegStatus: { state: 'checking', canDownload: false, canSelectFfmpeg: false },
				dirty: false,
				applyState: { kind: 'idle' }, // 'idle' | 'saving' | 'saved' | 'error'
				errorMessage: undefined,
				_open: false,          // local disclosure state
			}
		}

		function EgoBrowserSettingsController() {
			this.store = createSnapshotStore(initialSettingsState())
			this.loaded = false
			this.generation = 0
			this.staged = new Map()
			this.ffmpegTimer = null
			void this.load()
		}
		EgoBrowserSettingsController.prototype.load = function () {
			var self = this
			var gen = ++this.generation
			this.store.update(function (s) { s.status = 'loading' })
			fetch('/ego/api/get', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}',
			}).then(function (res) {
				if (!res.ok) return null
				return res.json().catch(function () { return null })
			}).then(function (parsed) {
				if (gen !== self.generation) return
				if (!parsed || parsed.ok !== true || !parsed.value) {
					self.store.update(function (s) {
						s.status = 'ready'
						s.available = false
						s.writable = false
					})
					return
				}
				var config = parsed.value.config || {}
				var ffmpegStatus = parsed.value.ffmpegStatus || { state: 'missing', canDownload: false, canSelectFfmpeg: false }
				self.loaded = true
				// Mirror the host switch so the watch panel reacts immediately.
				frameRelaySet(config.disableFrameRelay)
				self.staged.clear()
				self.store.update(function (s) {
					s.status = 'ready'
					s.available = true
					s.writable = true
			s.draft = {
				isolateSpaces: config.isolateSpaces === true || config.isolateSpaces === 'true' || config.isolateSpaces === 1 || config.isolateSpaces === '1',
				idleTimeoutMin: String(config.idleTimeoutMin ?? 0),
				disableFrameRelay: config.disableFrameRelay === true || config.disableFrameRelay === 'true' || config.disableFrameRelay === 1 || config.disableFrameRelay === '1',
				residentExecutor: config.residentExecutor === true || config.residentExecutor === 'true' || config.residentExecutor === 1 || config.residentExecutor === '1',
				residentIdleMin: String(config.residentIdleMin ?? 30),
				chromePath: config.chromePath || '',
				captureBackend: config.captureBackend === 'ffmpeg' && !ffmpegStatus.canSelectFfmpeg ? 'cdp' : (config.captureBackend || 'auto'), streamProfile: config.streamProfile || 'balanced',
				cdpFps: String(config.cdpFps ?? 20), cdpQuality: String(config.cdpQuality ?? 55), cdpMaxWidth: String(config.cdpMaxWidth ?? 1280), cdpBackstopIntervalMs: String(config.cdpBackstopIntervalMs ?? 3000),
				ffmpegFps: String(config.ffmpegFps ?? 20), ffmpegMaxWidth: String(config.ffmpegMaxWidth ?? 1280), ffmpegBitrateKbps: String(config.ffmpegBitrateKbps ?? 4000), ffmpegEncoder: config.ffmpegEncoder || 'auto', ffmpegPath: config.ffmpegPath || '', githubMirror: config.githubMirror || '',
				egoCliArgs: config.egoCliArgs || '', chromeArgs: config.chromeArgs || '',
			}
				s.ffmpegStatus = ffmpegStatus
				s.dirty = false
				s.applyState = { kind: 'idle' }
				})
				if (isFfmpegBusy(ffmpegStatus.state)) self._scheduleFfmpegPoll()
			}).catch(function () {
				if (gen !== self.generation) return
				self.store.update(function (s) {
					s.status = 'ready'
					s.available = false
					s.writable = false
				})
			})
		}
		EgoBrowserSettingsController.prototype.edit = function (field, text) {
			this.staged.set(field, text)
			var patch = {}
			patch[field] = text
			this.store.update(function (s) {
				s.draft = Object.assign({}, s.draft, patch)
				s.dirty = true
				s.applyState = { kind: 'idle' }
			})
		}
		EgoBrowserSettingsController.prototype._setFfmpegStatus = function (status) {
			var self = this
			if (!status) return
			this.store.update(function (s) {
				s.ffmpegStatus = status
				if (!status.canSelectFfmpeg && s.draft.captureBackend === 'ffmpeg') s.draft = Object.assign({}, s.draft, { captureBackend: 'cdp' })
			})
			if (isFfmpegBusy(status.state)) self._scheduleFfmpegPoll()
		}
		EgoBrowserSettingsController.prototype._scheduleFfmpegPoll = function () {
			var self = this
			if (this.ffmpegTimer !== null) return
			this.ffmpegTimer = setTimeout(function () {
				self.ffmpegTimer = null
				void self._ffmpegRequest('ffmpeg-status')
			}, 700)
		}
		EgoBrowserSettingsController.prototype._ffmpegRequest = function (method, body) {
			var self = this
			return fetch('/ego/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
				.then(function (res) { return res.json().catch(function () { return null }) })
				.then(function (parsed) {
					if (!parsed || parsed.ok !== true || !parsed.value) throw new Error(parsed && parsed.error ? parsed.error.message : 'FFmpeg request failed')
					self._setFfmpegStatus(parsed.value.ffmpegStatus)
					return parsed.value.ffmpegStatus
				}).catch(function (error) {
					self.store.update(function (s) { s.applyState = { kind: 'error', message: error instanceof Error ? error.message : String(error) } })
				})
		}
		EgoBrowserSettingsController.prototype.checkFfmpeg = function () { void this._ffmpegRequest('ffmpeg-check') }
		EgoBrowserSettingsController.prototype.installFfmpeg = function () {
			var self = this
			var snapshot = this.store.getSnapshot()
			void this._ffmpegRequest('ffmpeg-install', { githubMirror: snapshot.draft.githubMirror || '' }).then(function () { self._scheduleFfmpegPoll() })
		}
		EgoBrowserSettingsController.prototype.discard = function () {
			if (this.staged.size === 0) {
				this.store.update(function (s) { s.applyState = { kind: 'idle' } })
				return
			}
			this.staged.clear()
			void this.load()
		}
		EgoBrowserSettingsController.prototype.save = function () {
			void this._doSave()
		}
		EgoBrowserSettingsController.prototype._doSave = function () {
			var self = this
			var gen = ++this.generation
			var patch = {}
			var NUMERIC_FIELDS = {
				idleTimeoutMin: { min: 0, max: 1440, def: 0 },
				residentIdleMin: { min: 0, max: 1440, def: 30 },
				cdpFps: { min: 5, max: 30, def: 20 }, cdpQuality: { min: 1, max: 100, def: 55 }, cdpMaxWidth: { min: 320, max: 1920, def: 1280 }, cdpBackstopIntervalMs: { min: 1000, max: 10000, def: 3000 }, ffmpegFps: { min: 5, max: 30, def: 20 }, ffmpegMaxWidth: { min: 320, max: 1920, def: 1280 }, ffmpegBitrateKbps: { min: 500, max: 20000, def: 4000 },
			}
			this.staged.forEach(function (v, k) {
				var spec = NUMERIC_FIELDS[k]
				if (spec) {
					var n = parseInt(v, 10)
					if (!Number.isFinite(n)) n = spec.def
					patch[k] = Math.max(spec.min, Math.min(spec.max, n))
				} else {
					patch[k] = v
				}
			})
			if (Object.keys(patch).length === 0) {
				this.staged.clear()
				this.store.update(function (s) {
					s.dirty = false
					s.applyState = { kind: 'idle' }
				})
				return
			}
			this.store.update(function (s) { s.applyState = { kind: 'saving' } })
			fetch('/ego/api/set', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ patch: patch }),
			}).then(function (res) {
				return res.json().catch(function () { return null })
			}).then(function (parsed) {
				if (gen !== self.generation) return
				if (!parsed || parsed.ok !== true || !parsed.value) {
					self.store.update(function (s) {
						s.applyState = { kind: 'error', message: parsed && parsed.error ? parsed.error.message : 'Save failed' }
					})
					return
				}
				var config = parsed.value.config || {}
				var ffmpegStatus = parsed.value.ffmpegStatus || self.store.getSnapshot().ffmpegStatus
				// A saved switch applies to the live panel at once — no reload.
				frameRelaySet(config.disableFrameRelay)
				self.staged.clear()
				self.store.update(function (s) {
				s.applyState = { kind: 'saved' }
			s.draft = {
				isolateSpaces: config.isolateSpaces === true || config.isolateSpaces === 'true' || config.isolateSpaces === 1 || config.isolateSpaces === '1',
				idleTimeoutMin: String(config.idleTimeoutMin ?? 0),
				disableFrameRelay: config.disableFrameRelay === true || config.disableFrameRelay === 'true' || config.disableFrameRelay === 1 || config.disableFrameRelay === '1',
				residentExecutor: config.residentExecutor === true || config.residentExecutor === 'true' || config.residentExecutor === 1 || config.residentExecutor === '1',
				residentIdleMin: String(config.residentIdleMin ?? 30),
				chromePath: config.chromePath || '',
				captureBackend: config.captureBackend === 'ffmpeg' && ffmpegStatus && !ffmpegStatus.canSelectFfmpeg ? 'cdp' : (config.captureBackend || 'auto'), streamProfile: config.streamProfile || 'balanced',
				cdpFps: String(config.cdpFps ?? 20), cdpQuality: String(config.cdpQuality ?? 55), cdpMaxWidth: String(config.cdpMaxWidth ?? 1280), cdpBackstopIntervalMs: String(config.cdpBackstopIntervalMs ?? 3000),
				ffmpegFps: String(config.ffmpegFps ?? 20), ffmpegMaxWidth: String(config.ffmpegMaxWidth ?? 1280), ffmpegBitrateKbps: String(config.ffmpegBitrateKbps ?? 4000), ffmpegEncoder: config.ffmpegEncoder || 'auto', ffmpegPath: config.ffmpegPath || '', githubMirror: config.githubMirror || '',
				egoCliArgs: config.egoCliArgs || '', chromeArgs: config.chromeArgs || '',
			}
				if (ffmpegStatus) s.ffmpegStatus = ffmpegStatus
				s.dirty = false
				})
			}).catch(function (err) {
				if (gen !== self.generation) return
				self.store.update(function (s) {
					s.applyState = { kind: 'error', message: err instanceof Error ? err.message : String(err) }
				})
			})
		}
		EgoBrowserSettingsController.prototype.toggle = function () {
			this.store.update(function (s) { s._open = !s._open })
		}

		// ── Settings card: component ─────────────────────────────────────
		// Design follows `dsh-plugin-interpreters`: a bordered DSW token card
		// (var(--dsw-alias-*)) that adapts to light/dark themes, a header button
		// with name + description + pending pill + chevron, a body split by a
		// border-top from the footer. Fields use the shared Field helper so the
		// label/input/hint rhythm matches other plugin cards.
		var h = React.createElement

		// Card CSS (scoped under .dsh-ego-card). Uses the host design-system
		// aliases so the card picks up theme changes automatically. Injected
		// once by apply(); idempotent (guarded by a data attribute).
		var SETTINGS_CARD_STYLE_ID = 'dsh-ego-card-css'
		var SETTINGS_CARD_CSS = `
.dsh-ego-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.dsh-ego-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dsh-ego-card--open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dsh-ego-card__header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dsh-ego-card__header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-ego-card__head-text{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dsh-ego-card__name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.dsh-ego-card__desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.dsh-ego-card__pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.dsh-ego-card__chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s;display:inline-flex;align-items:center}
.dsh-ego-card__chevron--open{transform:rotate(180deg)}
.dsh-ego-card__body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:12px 0 4px}
.dsh-ego-card__notice{color:var(--dsw-alias-label-tertiary);margin:0 0 8px;font-size:12px;line-height:1.5}
.dsh-ego-card__saved{color:var(--dsw-alias-state-success-primary);margin:0 0 12px;font-size:12px;line-height:1.5}
.dsh-ego-card__failed{color:var(--dsw-alias-label-error);margin:0 0 12px;font-size:12px;line-height:1.5;min-width:0}
.dsh-ego-card__form{display:flex;flex-direction:column;gap:12px}
.dsh-ego-card__field{display:flex;flex-direction:column;gap:4px}
.dsh-ego-card__field-label{display:block;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dsh-ego-card__field-row{display:flex;align-items:center;gap:8px}
.dsh-ego-card__input{width:100%;padding:6px 10px;font-size:13px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);box-sizing:border-box;font-family:inherit}
.dsh-ego-card__input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;border-color:var(--dsw-alias-brand-primary)}
.dsh-ego-card__input:disabled{opacity:.55;cursor:not-allowed}
.dsh-ego-card__input--narrow{width:120px;flex:none}
.dsh-ego-card__unit{font-size:12px;color:var(--dsw-alias-label-tertiary);flex:none}
.dsh-ego-card__hint{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:0;line-height:1.5}
.dsh-ego-card__ffmpeg{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px}
.dsh-ego-card__ffmpeg-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-ego-card__ffmpeg-status{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsh-ego-card__ffmpeg-actions{display:flex;gap:8px;flex-wrap:wrap}
.dsh-ego-card__progress{height:6px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);overflow:hidden}
.dsh-ego-card__progress-bar{height:100%;background:var(--dsw-alias-brand-primary);transition:width .2s}
.dsh-ego-card__footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.dsh-ego-card__btn{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);transition:background .16s,opacity .16s}
.dsh-ego-card__btn:disabled{cursor:not-allowed;opacity:.5}
.dsh-ego-card__btn--primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-layer-1)}
.dsh-ego-card__btn--primary:disabled{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary)}
.dsh-ego-card__btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
`

		// Chevron icon (inline SVG — matches dsh-client-ui-primitives
		// IconChevronDownOutline14 silhouette so the visual stays consistent
		// without adding a new peer dep just for one glyph).
		var CHEVRON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>'

		// Field helper — mirrors the interpreters' Field component: label +
		// input + hint, with an optional `narrow` + unit suffix for numeric
		// fields that don't need to span the full width.
		function SettingsField(props) {
			var id = props.id
			var label = props.label
			var hint = props.hint
			var value = props.value
			var disabled = props.disabled
			var onEdit = props.onEdit
			var numeric = props.numeric
			var narrow = props.narrow
			var unit = props.unit
			var inputEl = props.options ? h('select', {
				id: id, className: 'dsh-ego-card__input', value: value, disabled: disabled,
				onChange: function (e) { onEdit(e.target.value) },
			}, props.options.map(function (option) {
				var spec = typeof option === 'string' ? { value: option, label: option } : option
				return h('option', { key: spec.value, value: spec.value, disabled: !!spec.disabled }, spec.label)
			})) : h('input', {
				id: id,
				className: 'dsh-ego-card__input' + (narrow ? ' dsh-ego-card__input--narrow' : ''),
				type: numeric ? 'number' : 'text',
				...(numeric ? { inputMode: 'numeric', min: props.min, max: props.max, step: props.step } : {}),
				value: value,
				disabled: disabled,
				placeholder: props.placeholder,
				onChange: function (e) { onEdit(e.target.value) },
			})
			return h('div', { className: 'dsh-ego-card__field' },
				h('label', { className: 'dsh-ego-card__field-label', htmlFor: id }, label),
				narrow
					? h('div', { className: 'dsh-ego-card__field-row' }, inputEl, unit ? h('span', { className: 'dsh-ego-card__unit' }, unit) : null)
					: inputEl,
				hint ? h('p', { className: 'dsh-ego-card__hint' }, hint) : null,
			)
		}

		function LoginImportBlock(props) {
			var t = props.t
			var useState = React.useState
			var _source = useState('auto'), source = _source[0], setSource = _source[1]
			var _domains = useState(''), domains = _domains[0], setDomains = _domains[1]
			var _close = useState(false), closeSource = _close[0], setCloseSource = _close[1]
			var _run = useState(false), running = _run[0], setRunning = _run[1]
			var _res = useState(null), result = _res[0], setResult = _res[1]
			function run(dryRun) {
				setRunning(true)
				setResult(null)
				fetch('/api/ego/login-import', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						source: source,
						domains: domains.split(',').map(function (s) { return s.trim() }).filter(Boolean),
						closeSource: closeSource,
						dryRun: dryRun,
					}),
				})
					.then(function (r) { return r.json().catch(function () { return null }) })
					.then(function (j) { setRunning(false); setResult(j || { ok: false, error: 'no response' }) })
					.catch(function (e) { setRunning(false); setResult({ ok: false, error: String(e) }) })
			}
			var resultText = null
			var resultOk = false
			if (result) {
				resultOk = result.ok === true
				if (resultOk) {
					var domainCount = (result.domains || []).length
					var tpl = result.dryRun ? t('loginImportProbeResult') : t('loginImportResult')
					// Interpolate locally — do not rely on the host locale's
					// parameter support.
					resultText = tpl
						.replace('{matched}', String(result.matched ?? 0))
						.replace('{written}', String(result.written ?? 0))
						.replace('{domains}', String(domainCount))
						.replace('{total}', String(result.totalRead ?? 0))
						.replace('{source}', String(result.source || ''))
						+ (result.closedSource ? t('loginImportClosed') : '')
				} else {
					resultText = result.error || 'failed'
				}
			}
			return h('div', { className: 'dsh-ego-card__ffmpeg' },
				h('div', { className: 'dsh-ego-card__ffmpeg-title' }, t('loginImportTitle')),
				h('div', { className: 'dsh-ego-card__hint' }, t('loginImportIntro')),
				h('div', { className: 'dsh-ego-card__field-row' },
					h('select', {
						className: 'dsh-ego-card__input dsh-ego-card__input--narrow', value: source, disabled: running,
						onChange: function (e) { setSource(e.target.value) },
					}, ['auto', 'chrome', 'edge', 'brave'].map(function (v) { return h('option', { key: v, value: v }, v === 'auto' ? t('loginImportSource') + ': auto' : v) })),
					h('input', {
						className: 'dsh-ego-card__input', type: 'text', value: domains, disabled: running,
						placeholder: t('loginImportDomains'),
						onChange: function (e) { setDomains(e.target.value) },
					}),
				),
				h('div', { className: 'dsh-ego-card__hint' }, t('loginImportDomainsHint')),
				h('label', { className: 'dsh-ego-card__hint', style: { display: 'flex', gap: '6px', alignItems: 'center', cursor: 'pointer' } },
					h('input', { type: 'checkbox', checked: closeSource, disabled: running, onChange: function (e) { setCloseSource(e.target.checked) } }),
					t('loginImportCloseSource'),
				),
				h('div', { className: 'dsh-ego-card__ffmpeg-actions' },
					h('button', { type: 'button', className: 'dsh-ego-card__btn', disabled: running, onClick: function () { run(true) } }, t('loginImportProbe')),
					h('button', { type: 'button', className: 'dsh-ego-card__btn dsh-ego-card__btn--primary', disabled: running, onClick: function () { run(false) } }, t('loginImportRun')),
				),
				running ? h('div', { className: 'dsh-ego-card__ffmpeg-status', role: 'status' }, t('loginImportBusy')) : null,
				resultText ? h('div', { className: resultOk ? 'dsh-ego-card__saved' : 'dsh-ego-card__failed', role: 'status' }, resultText) : null,
			)
		}

		function EgoBrowserForm(props) {
			var t = props.t
			var controller = props.controller
			var useSnapshot = props.useSnapshot
			var state = useSnapshot(function (s) { return s })
			if (state.status === 'idle') void controller.load()
			var applyState = state.applyState || { kind: 'idle' }
			var saving = applyState.kind === 'saving'
			var saved = applyState.kind === 'saved'
			var errorText = applyState.kind === 'error' ? applyState.message : undefined

			var body = null
			if (!state.available) {
				body = h('div', { className: 'dsh-ego-card__body' },
					h('p', { className: 'dsh-ego-card__notice', role: 'status' }, t('namespaceUnavailable')),
					h('div', { className: 'dsh-ego-card__footer' },
						h('button', {
							type: 'button',
							className: 'dsh-ego-card__btn',
							onClick: function () { controller.load() },
						}, t('retry')),
					),
				)
			} else {
				var busy = !state.writable || saving
				var ffmpegStatus = state.ffmpegStatus || { state: 'checking', canDownload: false, canSelectFfmpeg: false }
				var ffmpegBusy = isFfmpegBusy(ffmpegStatus.state)
				var ffmpegLabelKey = ffmpegStatus.state === 'ready' ? 'ffmpegReady' : ffmpegStatus.state === 'checking' ? 'ffmpegChecking' : ffmpegStatus.state === 'downloading' ? 'ffmpegDownloading' : ffmpegStatus.state === 'verifying' ? 'ffmpegVerifying' : ffmpegStatus.state === 'extracting' ? 'ffmpegExtracting' : ffmpegStatus.state === 'probing' ? 'ffmpegProbing' : ffmpegStatus.state === 'unsupported' ? 'ffmpegUnsupported' : ffmpegStatus.state === 'failed' ? 'ffmpegFailed' : 'ffmpegMissing'
				var progress = ffmpegStatus.progress
				var progressText = progress ? formatBytes(progress.receivedBytes || 0) + (progress.totalBytes ? ' / ' + formatBytes(progress.totalBytes) : '') + (progress.percent !== null && progress.percent !== undefined ? ' (' + progress.percent + '%)' : '') : ''
				var saveDisabled = !state.dirty || saving || !state.writable
				var discardDisabled = !state.dirty || saving
				body = h('div', { className: 'dsh-ego-card__body' },
					!state.writable ? h('p', { className: 'dsh-ego-card__notice', role: 'status' }, t('readOnly')) : null,
					saved ? h('p', { className: 'dsh-ego-card__saved', role: 'status' }, t('save')) : null,
					h('div', { className: 'dsh-ego-card__form' },
						h(SettingsField, {
							id: 'plugin-config-ego-browser-isolatespaces',
							label: t('isolateSpaces'),
							hint: t('isolateSpacesHint'),
							value: state.draft.isolateSpaces ? 'true' : 'false',
							options: [
								{ value: 'false', label: t('isolateSpacesOff') },
								{ value: 'true', label: t('isolateSpacesOn') },
							],
							disabled: busy,
							onEdit: function (v) { controller.edit('isolateSpaces', v === 'true') },
						}),
						h(SettingsField, {
							id: 'plugin-config-ego-browser-disableframerelay',
							label: t('disableFrameRelay'),
							hint: t('disableFrameRelayHint'),
							value: state.draft.disableFrameRelay ? 'true' : 'false',
							options: [
								{ value: 'false', label: t('disableFrameRelayOff') },
								{ value: 'true', label: t('disableFrameRelayOn') },
							],
							disabled: busy,
							onEdit: function (v) { controller.edit('disableFrameRelay', v === 'true') },
						}),
						h(SettingsField, {
							id: 'plugin-config-ego-browser-residentexecutor',
							label: t('residentExecutor'),
							hint: t('residentExecutorHint'),
							value: state.draft.residentExecutor ? 'true' : 'false',
							options: [
								{ value: 'false', label: t('residentExecutorOff') },
								{ value: 'true', label: t('residentExecutorOn') },
							],
							disabled: busy,
							onEdit: function (v) { controller.edit('residentExecutor', v === 'true') },
						}),
						h(SettingsField, { id: 'plugin-config-ego-browser-residentidle', label: t('residentIdleMin'), hint: t('residentIdleMinHint'), value: state.draft.residentIdleMin, numeric: true, narrow: true, unit: t('minUnit'), min: 0, max: 1440, step: 1, disabled: busy, onEdit: function (v) { controller.edit('residentIdleMin', v) } }),
						h(SettingsField, { id: 'plugin-config-ego-browser-idletimeout', label: t('idleTimeoutMin'), hint: t('idleTimeoutMinHint'), value: state.draft.idleTimeoutMin, numeric: true, narrow: true, unit: t('minUnit'), min: 0, max: 1440, step: 1, disabled: busy, onEdit: function (v) { controller.edit('idleTimeoutMin', v) } }),
						h(SettingsField, {
							id: 'plugin-config-ego-browser-chromepath',
							label: t('chromePath'),
							hint: t('chromePathHint'),
							value: state.draft.chromePath || '',
							placeholder: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
							disabled: busy,
							onEdit: function (v) { controller.edit('chromePath', v) },
						}),
						h(SettingsField, {
							id: 'plugin-config-ego-browser-backend', label: t('captureBackend'), value: state.draft.captureBackend, options: ['auto', 'cdp', { value: 'ffmpeg', label: ffmpegStatus.canSelectFfmpeg ? 'ffmpeg' : t('ffmpegRequired'), disabled: !ffmpegStatus.canSelectFfmpeg }], disabled: busy, onEdit: function (v) { controller.edit('captureBackend', v) },
						}),
						h(SettingsField, { id: 'plugin-config-ego-browser-profile', label: t('streamProfile'), value: state.draft.streamProfile, options: ['low', 'balanced', 'high'], disabled: busy, onEdit: function (v) { controller.edit('streamProfile', v) } }),
						h(SettingsField, { id: 'plugin-config-ego-browser-cdpfps', label: t('cdpFps'), value: state.draft.cdpFps, numeric: true, narrow: true, unit: t('fpsUnit'), min: 5, max: 30, step: 1, disabled: busy, onEdit: function (v) { controller.edit('cdpFps', v) } }),
						h(SettingsField, { id: 'plugin-config-ego-browser-cdpquality', label: t('cdpQuality'), value: state.draft.cdpQuality, numeric: true, narrow: true, min: 1, max: 100, step: 1, disabled: busy, onEdit: function (v) { controller.edit('cdpQuality', v) } }),
						h(SettingsField, { id: 'plugin-config-ego-browser-cdpwidth', label: t('cdpMaxWidth'), value: state.draft.cdpMaxWidth, numeric: true, narrow: true, unit: t('pxUnit'), min: 320, max: 1920, step: 40, disabled: busy, onEdit: function (v) { controller.edit('cdpMaxWidth', v) } }),
						h(SettingsField, { id: 'plugin-config-ego-browser-backstop', label: t('cdpBackstopIntervalMs'), value: state.draft.cdpBackstopIntervalMs, numeric: true, narrow: true, unit: t('msUnit'), min: 1000, max: 10000, step: 100, disabled: busy, onEdit: function (v) { controller.edit('cdpBackstopIntervalMs', v) } }),
						h(SettingsField, { id: 'plugin-config-ego-browser-fffps', label: t('ffmpegFps'), value: state.draft.ffmpegFps, numeric: true, narrow: true, unit: t('fpsUnit'), min: 5, max: 30, step: 1, disabled: busy, onEdit: function (v) { controller.edit('ffmpegFps', v) } }),
						h(SettingsField, { id: 'plugin-config-ego-browser-ffwidth', label: t('ffmpegMaxWidth'), value: state.draft.ffmpegMaxWidth, numeric: true, narrow: true, unit: t('pxUnit'), min: 320, max: 1920, step: 40, disabled: busy, onEdit: function (v) { controller.edit('ffmpegMaxWidth', v) } }),
						h(SettingsField, { id: 'plugin-config-ego-browser-ffbitrate', label: t('ffmpegBitrateKbps'), value: state.draft.ffmpegBitrateKbps, numeric: true, narrow: true, unit: t('kbpsUnit'), min: 500, max: 20000, step: 250, disabled: busy, onEdit: function (v) { controller.edit('ffmpegBitrateKbps', v) } }),
						h(SettingsField, { id: 'plugin-config-ego-browser-encoder', label: t('ffmpegEncoder'), value: state.draft.ffmpegEncoder, options: ['auto', 'software', 'h264_mf', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox', 'h264_vaapi'], disabled: busy, onEdit: function (v) { controller.edit('ffmpegEncoder', v) } }),
						h(SettingsField, { id: 'plugin-config-ego-browser-ffpath', label: t('ffmpegPath'), value: state.draft.ffmpegPath, placeholder: 'ffmpeg', disabled: busy, onEdit: function (v) { controller.edit('ffmpegPath', v) },
						}),
						h(SettingsField, { id: 'plugin-config-ego-browser-ghmirror', label: t('githubMirror'), value: state.draft.githubMirror, hint: t('githubMirrorHint'), placeholder: 'https://gh-proxy.com/github.com', disabled: busy, onEdit: function (v) { controller.edit('githubMirror', v) } }),
						h(SettingsField, { id: 'plugin-config-ego-browser-ego-cli-args', label: t('egoCliArgs'), value: state.draft.egoCliArgs, hint: t('egoCliArgsHint'), placeholder: '--sdk-path /path/to/harness.js', disabled: busy, onEdit: function (v) { controller.edit('egoCliArgs', v) } }),
						h(SettingsField, { id: 'plugin-config-ego-browser-chrome-args', label: t('chromeArgs'), value: state.draft.chromeArgs, hint: t('chromeArgsHint'), placeholder: '--disable-features=Translate --window-size=1024,768', disabled: busy, onEdit: function (v) { controller.edit('chromeArgs', v) } }),
						h(LoginImportBlock, { t: t }),
						h('div', { className: 'dsh-ego-card__ffmpeg' },
							h('div', { className: 'dsh-ego-card__ffmpeg-title' }, t('ffmpegTitle')),
							h('div', { className: 'dsh-ego-card__ffmpeg-status', role: 'status' }, t(ffmpegLabelKey) + (ffmpegStatus.reason ? ': ' + ffmpegStatus.reason : '') + (progressText ? ' ' + progressText : '')),
							progress && progress.percent !== null && progress.percent !== undefined ? h('div', { className: 'dsh-ego-card__progress' }, h('div', { className: 'dsh-ego-card__progress-bar', style: { width: progress.percent + '%' } })) : null,
							ffmpegStatus.path ? h('div', { className: 'dsh-ego-card__ffmpeg-status' }, t('ffmpegSource') + ': ' + (ffmpegStatus.source || '-') + ' · ' + ffmpegStatus.path) : null,
							ffmpegStatus.version ? h('div', { className: 'dsh-ego-card__ffmpeg-status' }, t('ffmpegVersion') + ': ' + ffmpegStatus.version) : null,
							h('div', { className: 'dsh-ego-card__ffmpeg-actions' },
								h('button', { type: 'button', className: 'dsh-ego-card__btn', disabled: ffmpegBusy, onClick: function () { controller.checkFfmpeg() } }, t('ffmpegRecheck')),
								ffmpegStatus.canDownload ? h('button', { type: 'button', className: 'dsh-ego-card__btn dsh-ego-card__btn--primary', disabled: ffmpegBusy, onClick: function () { controller.installFfmpeg() } }, ffmpegStatus.source === 'managed' ? t('ffmpegReinstall') : t('ffmpegInstall')) : null,
							),
						),
					),
					h('div', { className: 'dsh-ego-card__footer' },
						errorText !== undefined ? h('p', { className: 'dsh-ego-card__failed', role: 'status' }, errorText) : null,
						h('button', {
							type: 'button',
							className: 'dsh-ego-card__btn',
							disabled: discardDisabled,
							onClick: function () { controller.discard() },
						}, t('discard')),
						h('button', {
							type: 'button',
							className: 'dsh-ego-card__btn dsh-ego-card__btn--primary',
							disabled: saveDisabled,
							onClick: function () { controller.save() },
						}, saving ? t('saving') : t('save')),
					),
				)
			}

			return body
		}

		/**
		 * 设置分区卡片（DSH <= 0.1.6 的 `settings.plugin.item` 视图）：
		 * 折叠头 + 表单体。0.1.7 起该 slot 退役，此组件仅在宿主仍在声明它时注册。
		 */
		function EgoBrowserCard(props) {
			var t = props.t
			var controller = props.controller
			var useSnapshot = props.useSnapshot
			var state = useSnapshot(function (s) { return s })
			if (state.status === 'idle') void controller.load()
			var degraded = state.status === 'ready' && !state.available
			var open = state._open || degraded
			var header = h('button', {
				type: 'button',
				className: 'dsh-ego-card__header',
				'aria-expanded': open,
				'aria-label': t(open ? 'collapse' : 'expand') + ': ' + t('title'),
				onClick: function () { if (!degraded) controller.toggle() },
			},
				h('span', { className: 'dsh-ego-card__head-text' },
					h('span', { className: 'dsh-ego-card__name' }, t('title')),
					h('span', { className: 'dsh-ego-card__desc' }, t('intro')),
				),
				state.dirty ? h('span', { className: 'dsh-ego-card__pending' }, t('unsaved')) : null,
				h('span', {
					className: 'dsh-ego-card__chevron' + (open ? ' dsh-ego-card__chevron--open' : ''),
					dangerouslySetInnerHTML: { __html: CHEVRON_SVG },
				}),
			)
			return h('li', {
				className: 'dsh-ego-card' + (open ? ' dsh-ego-card--open' : ''),
			}, header, open ? h(EgoBrowserForm, { t: t, controller: controller, useSnapshot: useSnapshot }) : null)
		}

		/**
		 * 插件页的配置视图（DSH 0.1.7+ 的 `plugins.row.config`）：
		 * `summary` 是行详情缺包描述时的回退；`page` 渲染带保存控件的完整表单。
		 * 标题、图标与面包屑由页面自绘，所以这里不再画折叠头。
		 */
		function EgoBrowserConfigView(props) {
			if (props.view === 'summary') return props.t('intro')
			if (props.form) return h(EgoHostConfigForm, { t: props.t, form: props.form })
			return h(EgoBrowserForm, { t: props.t, controller: props.controller, useSnapshot: props.useSnapshot })
		}

		// 旧的一次性迁移键：设置页只写规范键，不在宿主表单里暴露。
		var HOST_FORM_HIDDEN = ['castFpsCap', 'screencastQuality', 'screencastMaxWidth', 'backstopIntervalMs']
		var HOST_FORM_PLACEHOLDER = {
			chromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
			ffmpegPath: 'ffmpeg',
			githubMirror: 'https://gh-proxy.com/github.com',
			egoCliArgs: '--sdk-path /path/to/harness.js',
			chromeArgs: '--disable-features=Translate --window-size=1024,768',
		}

		/**
		 * 由宿主 `ConfigPageForm` 驱动的配置表单（DSH 0.1.7+）。值取自
		 * `form.state.value`（宿主已接受的那一份），保存时把改动过的字段拼成
		 * `SettingsPathOpView[]` 交给 `form.mutate(ops, revision)` —— 这条路经
		 * loader 的 volatile 提交，改完立即生效。自家的 `/ego/api/set` 网关在
		 * 0.1.7 上只会"报告成功但值不变"，所以只在没有 `form` 时回退到它。
		 */
		function EgoHostConfigForm(props) {
			var t = props.t
			var form = props.form
			var snap = form.state
			var useState = React.useState
			var useEffect = React.useEffect
			var _draft = useState(null), draft = _draft[0], setDraft = _draft[1]
			var _busy = useState(false), busy = _busy[0], setBusy = _busy[1]
			var _result = useState(null), result = _result[0], setResult = _result[1]
			// 宿主返回的 `state.value` 只是这一行的原始覆盖值（没有 schema 默认值），
			// 直接用它渲染会漏掉从未改过的设置项。所以再从自家网关取一份「全字段 +
			// 默认值」把字段集补齐，缺省值由网关（宿主侧 resolveConfig）给出。
			var _base = useState(null), base = _base[0], setBase = _base[1]
			var _reload = useState(0), reload = _reload[0], setReload = _reload[1]
			useEffect(function () {
				var alive = true
				fetch('/ego/api/get', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: '{}',
				}).then(function (r) { return r.json() }).then(function (json) {
					if (!alive) return
					var config = json && json.value && json.value.config
					if (config) setBase(config)
				}).catch(function () { /* 网关不可用时只显示宿主已知的字段 */ })
				return function () { alive = false }
			}, [reload])

			var hostValues = (snap && snap.value) || {}
			var values = Object.assign({}, base || {}, hostValues)
			var ready = !!(snap && (snap.status === 'ready' || base !== null))
			var writable = !!(snap && snap.writable)
			var effective = draft === null ? values : draft
			var keys = Object.keys(values).filter(function (k) { return HOST_FORM_HIDDEN.indexOf(k) === -1 })

			function edit(key, value) {
				var next = Object.assign({}, effective)
				next[key] = value
				setResult(null)
				setDraft(next)
			}
			function changedOps() {
				var ops = []
				for (var i = 0; i < keys.length; i++) {
					var k = keys[i]
					if (JSON.stringify(effective[k]) !== JSON.stringify(values[k])) ops.push({ op: 'set', path: [k], value: effective[k] })
				}
				return ops
			}
			function save() {
				var ops = changedOps()
				if (ops.length === 0) { setDraft(null); return }
				setBusy(true)
				setResult(null)
				Promise.resolve(form.mutate(ops, snap && snap.revision)).then(function (accepted) {
					setBusy(false)
					setDraft(null)
					setResult({ ok: accepted !== false })
					setReload(function (n) { return n + 1 })
				}).catch(function (err) {
					setBusy(false)
					setResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
				})
			}

			if (!ready) {
				return h('div', { className: 'dsh-ego-card__body' },
					h('p', { className: 'dsh-ego-card__notice', role: 'status' },
						snap && snap.status === 'unavailable' ? t('namespaceUnavailable') : t('saving')),
				)
			}

			var fields = keys.map(function (key) {
				var value = effective[key]
				var label = t(key)
				var hint = t(key + 'Hint')
				var fieldId = 'plugin-config-ego-browser-' + key.toLowerCase()
				var fieldHint = hint === key + 'Hint' ? undefined : hint
				if (typeof value === 'boolean') {
					return h(SettingsField, {
						id: fieldId, label: label, hint: fieldHint,
						value: value ? 'true' : 'false',
						options: [{ value: 'false', label: t('offLabel') }, { value: 'true', label: t('onLabel') }],
						disabled: busy || !writable,
						onEdit: function (v) { edit(key, v === 'true') },
					})
				}
				if (typeof value === 'number') {
					return h(SettingsField, {
						id: fieldId, label: label, hint: fieldHint,
						value: String(value), numeric: true, narrow: true,
						disabled: busy || !writable,
						onEdit: function (v) { var n = Number(v); edit(key, Number.isFinite(n) ? n : value) },
					})
				}
				return h(SettingsField, {
					id: fieldId, label: label, hint: fieldHint,
					value: String(value == null ? '' : value),
					placeholder: HOST_FORM_PLACEHOLDER[key],
					disabled: busy || !writable,
					onEdit: function (v) { edit(key, v) },
				})
			})

			var dirty = changedOps().length > 0
			var status = null
			if (busy) status = t('saving')
			else if (result && result.ok) status = t('savedHint')
			else if (result && result.ok === false) status = result.message || t('saveFailed')
			else if (!writable) status = t('readOnly')
			else if (dirty) status = t('unsaved')

			return h('div', { className: 'dsh-ego-card__body' },
				!writable ? h('p', { className: 'dsh-ego-card__notice', role: 'status' }, t('readOnly')) : null,
				h('div', { className: 'dsh-ego-card__form' }, fields),
				h('div', { className: 'dsh-ego-card__footer' },
					status ? h('p', { className: 'dsh-ego-card__hint', role: 'status' }, status) : null,
					h('div', { className: 'dsh-ego-card__actions' },
						h('button', {
							type: 'button', className: 'dsh-ego-card__btn', disabled: busy || !dirty,
							onClick: function () { setDraft(null); setResult(null) },
						}, t('discard')),
						h('button', {
							type: 'button', className: 'dsh-ego-card__btn dsh-ego-card__btn--primary',
							disabled: busy || !dirty || !writable,
							onClick: save,
						}, busy ? t('saving') : t('save')),
					),
				),
			)
		}

		function isFfmpegBusy(state) { return ['checking', 'downloading', 'verifying', 'extracting', 'probing'].includes(state) }
		function formatBytes(value) {
			if (!Number.isFinite(value) || value <= 0) return '0 B'
			if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KiB'
			return (value / (1024 * 1024)).toFixed(1) + ' MiB'
		}

		const SPACES_ROUTE = '/api/ego/spaces'
		const EGO_CLOSE_ROUTE = '/api/ego/close'
		const WATCH_START_ROUTE = '/api/ego/watch/start'
		const WATCH_SWITCH_ROUTE = '/api/ego/watch/switch'
		const WATCH_STOP_ROUTE = '/api/ego/watch/stop'
		const WATCH_STATUS_ROUTE = '/api/ego/watch/status'
		const VIDEO_ROUTE = '/api/ego/video'

		function postJson(path, body) {
			return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then(function (res) { return res.json().catch(function () { return {} }) })
		}

		function createKeyboardProxy(send) {
			var input = document.createElement('textarea')
			input.className = 'dsh-ego-keyboard-proxy'
			input.tabIndex = -1
			input.setAttribute('autocomplete', 'off')
			input.setAttribute('autocapitalize', 'off')
			input.setAttribute('spellcheck', 'false')
			input.style.cssText = 'position:fixed;z-index:2147483647;width:1px;height:1px;opacity:.01;pointer-events:none;resize:none;padding:0;border:0;left:0;top:0;'
			document.body.appendChild(input)
			var composing = false
			var armed = false
			var activeTargetId = null
			var pressed = new Map()
			var lastCompositionText = '', lastCompositionAt = 0, lastPasteText = '', lastPasteAt = 0
			var blurCount = 0, lastBlurAt = 0
			var modifiers = function (e) { return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0) }
			var keyId = function (e) { return e.code || e.key }
			var keyPayload = function (e) { return { key: e.key, code: e.code || '', modifiers: modifiers(e), autoRepeat: !!e.repeat, windowsVirtualKeyCode: Number(e.keyCode || e.which || 0) } }
			var isDshInput = function (target) {
				if (!target || target === input) return false
				var tag = target.tagName
				if (tag === 'INPUT' || tag === 'TEXTAREA') return true
				if (target.isContentEditable) return true
				return false
			}
			var releaseAllKeys = function () {
				for (const record of pressed.values()) send(record.targetId, 'keyUp', Object.assign({}, record.payload, { autoRepeat: false }))
				pressed.clear()
			}
			input.addEventListener('compositionstart', function (e) { composing = true; e.stopPropagation() })
			input.addEventListener('compositionend', function (e) {
				composing = false; e.stopPropagation()
				if (e.data && activeTargetId) { lastCompositionText = e.data; lastCompositionAt = Date.now(); send(activeTargetId, 'insertText', { text: e.data }) }
				window.setTimeout(function () { input.value = '' }, 0)
			})
			input.addEventListener('beforeinput', function (e) {
				e.stopPropagation()
				if (composing || /Composition/i.test(e.inputType || '')) return
				if (e.data && e.data === lastCompositionText && Date.now() - lastCompositionAt < 100) { e.preventDefault(); return }
				if (e.data && e.data === lastPasteText && Date.now() - lastPasteAt < 100) { e.preventDefault(); return }
				if (e.data && activeTargetId) { e.preventDefault(); send(activeTargetId, 'insertText', { text: e.data }); input.value = '' }
			})
			input.addEventListener('paste', function (e) {
				var text = e.clipboardData && e.clipboardData.getData('text/plain')
				if (!text) return
				e.preventDefault(); e.stopPropagation(); lastPasteText = text; lastPasteAt = Date.now(); if (activeTargetId) send(activeTargetId, 'insertText', { text: text }); input.value = ''
			})
			input.addEventListener('keydown', function (e) {
				e.stopPropagation()
				if (composing || e.key === 'Process' || e.key === 'Dead') return
				if (e.getModifierState && e.getModifierState('AltGraph') && e.key.length === 1) return
				var isShortcut = e.ctrlKey || e.metaKey || e.altKey
				var isControl = e.key.length > 1
				if (!isShortcut && !isControl) return
				if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'v') return
				if (!activeTargetId) return
				e.preventDefault(); var payload = keyPayload(e); pressed.set(keyId(e), { targetId: activeTargetId, payload: payload }); send(activeTargetId, 'keyDown', payload)
			})
			input.addEventListener('keyup', function (e) {
				e.stopPropagation()
				var id = keyId(e)
				var record = pressed.get(id)
				if (!record) return
				e.preventDefault(); pressed.delete(id); send(record.targetId, 'keyUp', keyPayload(e))
			})
			input.addEventListener('blur', function () {
				if (!armed || !activeTargetId) return
				var now = Date.now()
				if (now - lastBlurAt < 1000) { blurCount++; if (blurCount > 3) return }
				else blurCount = 0
				lastBlurAt = now
				window.setTimeout(function () { if (armed && activeTargetId) { try { input.focus({ preventScroll: true }) } catch (err) { input.focus() } } }, 0)
			})
			var onDocKeyDown = function (e) {
				if (!armed || !activeTargetId) return
				if (e.target === input) return
				if (composing || e.key === 'Process' || e.key === 'Dead') return
				if (e.getModifierState && e.getModifierState('AltGraph') && e.key.length === 1) return
				if (isDshInput(e.target) && document.activeElement === e.target) return
				var isShortcut = e.ctrlKey || e.metaKey || e.altKey
				var isControl = e.key.length > 1
				if (!isShortcut && !isControl) {
					e.preventDefault(); e.stopPropagation()
					send(activeTargetId, 'insertText', { text: e.key })
					return
				}
				if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'v') return
				e.preventDefault(); e.stopPropagation()
				var payload = keyPayload(e); pressed.set(keyId(e), { targetId: activeTargetId, payload: payload }); send(activeTargetId, 'keyDown', payload)
			}
			var onDocKeyUp = function (e) {
				if (!armed || !activeTargetId) return
				if (e.target === input) return
				var id = keyId(e)
				var record = pressed.get(id)
				if (!record) return
				e.preventDefault(); e.stopPropagation(); pressed.delete(id); send(record.targetId, 'keyUp', keyPayload(e))
			}
			var onDocPointerDown = function (e) {
				if (armed && isDshInput(e.target) && e.target !== input) {
					armed = false; releaseAllKeys()
				}
			}
			document.addEventListener('keydown', onDocKeyDown, true)
			document.addEventListener('keyup', onDocKeyUp, true)
			document.addEventListener('pointerdown', onDocPointerDown, true)
			return {
				focusAt: function (e, targetId) {
					if (activeTargetId && targetId !== activeTargetId) releaseAllKeys()
					activeTargetId = targetId
					armed = true
					blurCount = 0
					input.style.left = Math.max(0, e.clientX) + 'px'; input.style.top = Math.max(0, e.clientY) + 'px'
					try { input.focus({ preventScroll: true }) } catch (err) { input.focus() }
				},
				dispose: function () {
					armed = false
					document.removeEventListener('keydown', onDocKeyDown, true)
					document.removeEventListener('keyup', onDocKeyUp, true)
					document.removeEventListener('pointerdown', onDocPointerDown, true)
					releaseAllKeys(); input.remove()
				},
			}
		}

		function createMsePlayer(video, generation, mime, onFailure) {
			if (!window.MediaSource || !window.MediaSource.isTypeSupported(mime)) { onFailure('当前浏览器不支持此 H.264 流'); return function () {} }
			var mediaSource = new MediaSource()
			var objectUrl = URL.createObjectURL(mediaSource)
			var abort = new AbortController()
			var sourceBuffer = null, queue = [], queuedBytes = 0, disposed = false, reader = null, reading = false
			var MAX_QUEUED_VIDEO_BYTES = 4 * 1024 * 1024
			video.src = objectUrl; video.muted = true; video.autoplay = true; video.playsInline = true
			function appendNext() {
				if (disposed || !sourceBuffer || sourceBuffer.updating || queue.length === 0) return
				var chunk = queue.shift(); queuedBytes -= chunk.byteLength
				try { sourceBuffer.appendBuffer(chunk) } catch (error) { onFailure(error.message) }
			}
			function pump() {
				if (disposed || reading || !reader || queuedBytes >= MAX_QUEUED_VIDEO_BYTES) return
				reading = true
				reader.read().then(function (part) {
					reading = false
					if (disposed) return
					if (part.done) { onFailure('视频流已断开'); return }
					queue.push(part.value); queuedBytes += part.value.byteLength; appendNext(); pump()
				}).catch(function (error) { reading = false; if (!disposed && error.name !== 'AbortError') onFailure(error.message) })
			}
			mediaSource.addEventListener('sourceopen', function () {
				if (disposed) return
				try { sourceBuffer = mediaSource.addSourceBuffer(mime) } catch (error) { onFailure(error.message); return }
				sourceBuffer.mode = 'segments'
				sourceBuffer.addEventListener('updateend', function () {
					if (video.buffered.length) {
						var end = video.buffered.end(video.buffered.length - 1)
						if (end - video.currentTime > .8) video.currentTime = Math.max(0, end - .15)
						if (!sourceBuffer.updating && video.buffered.start(0) < end - 3) try { sourceBuffer.remove(video.buffered.start(0), end - 2) } catch (e) {}
					}
					appendNext(); pump()
				})
				fetch(VIDEO_ROUTE + '?generation=' + encodeURIComponent(generation), { signal: abort.signal }).then(function (res) {
					if (!res.ok || !res.body) throw new Error('视频流连接失败 (' + res.status + ')')
					reader = res.body.getReader(); pump()
				}).catch(function (error) { if (!disposed && error.name !== 'AbortError') onFailure(error.message) })
			})
			return function () {
				disposed = true; abort.abort(); queue = []; queuedBytes = 0
				try { video.pause(); video.removeAttribute('src'); video.load() } catch (e) {}
				try { URL.revokeObjectURL(objectUrl) } catch (e) {}
			}
		}
		// Treat the agent as "active" when any page was touched within this window.
		const ACTIVE_WINDOW_MS = 3000


		// ── SF-Symbols-style linear icons (inline SVG, zero deps) ──
		// Each icon carries explicit width/height (scaled from a 16 viewBox)
		// so it renders at a sane size even if no CSS rule targets it.
		// Canonical Agent Browser glyph (matches the sidebar entry in the official
		// UI): a rounded browser window with a title bar, two dots and the agent's
		// cursor. Keep EgoWatchIcon (React) in sync with this exact geometry.
		const ICON_AGENT_BROWSER = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="1.2" y="2.4" width="13.6" height="11.2" rx="2.4" stroke="currentColor" stroke-width="1.2"/><path d="M1.4 5.9h13.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="3.7" cy="4.15" r="0.6" fill="currentColor"/><circle cx="5.5" cy="4.15" r="0.6" fill="currentColor"/><path d="M8.2 7.0L12.6 10.6L10.6 10.9L11.7 13.2L10.6 13.8L9.5 11.5L8.0 13.1Z" fill="currentColor"/></svg>`;
		const ICON_REFRESH = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 4.5V9h-4.5"/></svg>`;
		const ICON_CLOCK = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg>`;

		function apply(ctx) {
			// ── Settings card: register locale + slot (always runs) ──────
			ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), 'ego-browser: settings dictionaries')
			// Inject the settings-card stylesheet once (idempotent — guarded by
			// a data attribute so HMR / repeated apply() calls don't duplicate).
			ctx.effect(() => {
				if (typeof document === 'undefined') return
				if (document.getElementById(SETTINGS_CARD_STYLE_ID) !== null) return
				var tag = document.createElement('style')
				tag.id = SETTINGS_CARD_STYLE_ID
				tag.dataset.plugin = 'ego-browser'
				tag.textContent = SETTINGS_CARD_CSS
				document.head.appendChild(tag)
				return function () { tag.remove() }
			}, 'ego-browser: settings card css')
			var controller = new EgoBrowserSettingsController()
			var useSnapshot = bindSnapshotSelector(controller.store)
			ctx.effect(() => {
				var pending = false
				var refresh = function () {
					if (pending) return
					pending = true
					queueMicrotask(function () {
						pending = false
						if (controller.loaded) void controller.load()
					})
				}
				var dispose = ctx.on('connection/reset', refresh)
				return function () { dispose() }
			}, 'ego-browser: settings invalidation')
			// 配置入口在两个 slot 上各挂一次，由宿主的声明决定哪个真正生效：
			//   - DSH >= 0.1.7：插件页的行配置页 `plugins.row.config`，键为
			//     `<包名>#<行 id>`；行 id 取本包 cordis.patch.yml 声明的
			//     `ego-browser`，即「插件 › dsh-ego-browser › ego-browser 行」。
			//   - DSH <= 0.1.6：设置 › 插件的 `settings.plugin.item`（折叠卡片）。
			// `slots.inject` 对未声明的 slot 只是静默等待（声明后才跑回调），
			// 因此两处注册互不干扰，也无需探测宿主版本。
			var configFace = { controller: controller, useSnapshot: useSnapshot }
			// 行配置的键是 `<bundle>#<rowId>`（宿主 config-ledger.rowConfigKey），
			// 而 bundle 名取的是 profile 的依赖键，随安装方式变化：
			//   - 本机 junction 安装 → `@dsh-external/ego-browser`（2026-09-23 实测，
			//     宿主的 [data-plugin-name] 就是它）
			//   - npm / git 直接依赖 → 包名 `dsh-ego-browser`
			// 两种都注册：只有匹配上的那个键会让插件页的行变成可导航。
			ctx.slots.inject('plugins.row.config', function* () {
				var bundles = ['@dsh-external/ego-browser', 'dsh-ego-browser']
				for (var bi = 0; bi < bundles.length; bi++) {
					yield ctx.slots.register({
						name: 'plugins.row.config',
						key: bundles[bi] + '#ego-browser',
						locale: SETTINGS_NS,
						inject: function () { return configFace },
					}, EgoBrowserConfigView)
				}
			})
			ctx.slots.inject('settings.plugin.item', function* () {
				yield ctx.slots.register({
					name: 'settings.plugin.item',
					key: SETTINGS_NS,
					order: 60,
					locale: SETTINGS_NS,
					inject: function () { return configFace },
				}, EgoBrowserCard)
			})

		// ── Watch panel: native right sidebar (optional dsh-better-sidebar fallback) ──
		// DSH Desktop ships its own right Sidebar, so the old floating FAB/overlay
		// fallback was removed. betterSidebar remains as an optional *sidebar*
		// fallback for hosts without the native services; if neither exists there
		// is simply no watch panel (the toolbar card still works). The services are
		// OPTIONAL and may be provided AFTER this row applies, so they are awaited
		// with ctx.inject rather than probed once with ctx.get.
		var getOptionalService = function (name) {
			try { return typeof ctx.get === 'function' ? ctx.get(name) : undefined } catch (e) { return undefined }
		}
		var betterSidebarService = getOptionalService('betterSidebar')
		// The one live panel. Replacing it disposes the previous mount, so the
		// fallback can be upgraded to the native sidebar when its services appear.
		var disposeActive = null
		var activatePanel = function (effectCtx, kind, factory) {
			if (disposeActive) { var old = disposeActive; disposeActive = null; try { old() } catch (e) {} }
			disposeActive = effectCtx.effect(function () { return factory() }, 'ego-browser watch panel (' + kind + ')')
		}
		// Fallback first: the native inject below may fire synchronously.
		if (betterSidebarService !== undefined) {
			activatePanel(ctx, 'betterSidebar', function () { return mountSidebarTab(ctx, betterSidebarService) })
		} else if (typeof ctx.inject === 'function') {
			ctx.inject(['betterSidebar'], function (sidebarCtx) {
				var svc
				try { svc = typeof sidebarCtx.get === 'function' ? sidebarCtx.get('betterSidebar') : sidebarCtx.betterSidebar } catch (e) { svc = undefined }
				if (!svc) return
				activatePanel(sidebarCtx, 'betterSidebar', function () { return mountSidebarTab(sidebarCtx, svc) })
			})
		}
		// Native upgrade path: wait for the right Sidebar's two services, then
		// take over the panel and dispose the betterSidebar fallback if mounted.
		if (typeof ctx.inject === 'function') {
			ctx.inject(['sidebarRight', 'sidebarRightTabs'], function (nativeCtx) {
				var sidebar = typeof nativeCtx.get === 'function' ? nativeCtx.get('sidebarRight') : undefined
				var tabs = typeof nativeCtx.get === 'function' ? nativeCtx.get('sidebarRightTabs') : undefined
				if (!sidebar || !tabs) return
				activatePanel(nativeCtx, 'native', function () { return mountNativeSidebarTab(nativeCtx, sidebar, tabs) })
			})
		}
	}

		// ── Sidebar Tab (React UI + vanilla LivePreviewController) ─────────────
		// Registered via ctx.betterSidebar.registerTab() when the sidebar service
		// is available. The Tab reuses the same /api/ego/spaces + /api/ego/stream
		// data sources as the native sidebar tab but renders through React into the
		// sidebar's tab content area.
		var INPUT_ROUTE = '/api/ego/input'
		var FLUSH_ROUTE = '/api/ego/flush'
		var FRAME_FOLLOW_MIN_MS = 350

		// ── Tab CSS (scoped under .dsh-ego-side-root) ──────────────────────────
		// The Tab lives inside the sidebar's content area, so no fixed positioning
		// / FAB / drag; selectors are class-scoped under .dsh-ego-side-root.
		var TAB_CSS = `
.dsh-ego-side-root {
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  overflow: hidden; color: inherit; background: transparent;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
.dsh-ego-side-root * { box-sizing: border-box; }

.dsh-ego-side-head {
  display: flex; align-items: center; gap: 4px; padding: 8px 10px;
  border-bottom: 1px solid rgba(128,128,128,.18); flex-shrink: 0;
}
.dsh-ego-side-title {
  flex: 1; font-size: 12.5px; font-weight: 600; letter-spacing: .2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  display: flex; align-items: center; gap: 5px; opacity: .85;
}
.dsh-ego-side-title svg { width: 14px; height: 14px; flex-shrink: 0; }
.dsh-ego-side-iconbtn {
  background: transparent; border: none; cursor: pointer;
  width: 26px; height: 26px; border-radius: 7px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  color: inherit; opacity: .6;
  transition: background .15s ease, opacity .15s ease;
}
.dsh-ego-side-iconbtn:hover { background: rgba(128,128,128,.18); opacity: 1; }
.dsh-ego-side-iconbtn.off { opacity: .4; }
.dsh-ego-side-iconbtn.spinning svg { animation: dsh-ego-side-spin .7s linear infinite; }
@keyframes dsh-ego-side-spin { to { transform: rotate(360deg); } }

/* ---- guide strips (login / captcha) ---- */
.dsh-ego-side-login, .dsh-ego-side-captcha {
  display: flex; align-items: center; gap: 7px; margin: 0 10px 7px; padding: 6px 9px;
  border-radius: 8px; font-size: 11px; line-height: 1.4;
}
.dsh-ego-side-login {
  border: 1px solid rgba(255,214,10,.3); background: rgba(255,214,10,.1);
}
.dsh-ego-side-captcha {
  border: 1px solid rgba(255,69,58,.4); background: rgba(255,69,58,.13);
}
.dsh-ego-side-login .dsh-ego-side-login-txt { flex: 1; min-width: 0; }
.dsh-ego-side-login .dsh-ego-side-login-txt b { color: #ffd60a; }
.dsh-ego-side-login-btn {
  flex: none; background: #0a84ff; color: #fff; border: none; border-radius: 7px;
  font-size: 10.5px; padding: 4px 9px; cursor: pointer; white-space: nowrap;
  transition: background .15s ease;
}
.dsh-ego-side-login-btn:hover { background: #338cff; }
.dsh-ego-side-login-btn.saving { opacity: .55; pointer-events: none; }
.dsh-ego-side-login-note { flex: none; font-size: 10px; opacity: .6; white-space: nowrap; }
.dsh-ego-side-captcha-txt { flex: 1; min-width: 0; }
.dsh-ego-side-captcha-txt b { color: #ff6961; }
.dsh-ego-side-captcha-kind {
  flex: none; font-size: 9.5px; padding: 2px 7px; border-radius: 999px;
  background: rgba(255,255,255,.15); text-transform: uppercase; letter-spacing: .3px;
}

/* ---- tab strip: frosted pills ---- */
.dsh-ego-side-tabs {
  display: flex; gap: 5px; padding: 7px 10px; flex-shrink: 0;
  border-bottom: 1px solid rgba(128,128,128,.12);
  overflow-x: auto; scrollbar-width: thin;
}
.dsh-ego-side-tabs:empty { display: none; }
.dsh-ego-side-tab {
  display: inline-flex; align-items: center; gap: 5px; max-width: 160px;
  white-space: nowrap; padding: 4px 10px; border-radius: 999px; cursor: pointer;
  font-size: 11px; flex-shrink: 0;
  border: 1px solid rgba(128,128,128,.2); background: rgba(128,128,128,.12);
  opacity: .7; transition: background .15s, opacity .15s, border-color .15s;
}
.dsh-ego-side-tab > .dsh-ego-side-tabtxt { overflow: hidden; text-overflow: ellipsis; }
.dsh-ego-side-tab:hover { opacity: 1; background: rgba(128,128,128,.2); }
.dsh-ego-side-tab.active {
  background: #0a84ff; color: #fff; border-color: transparent; opacity: 1;
  box-shadow: 0 2px 8px rgba(10,132,255,.3);
}
.dsh-ego-side-tabdot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .5; flex-shrink: 0; }
.dsh-ego-side-tab.active .dsh-ego-side-tabdot { background: #fff; opacity: 1; }
.dsh-ego-side-tabclose {
  flex-shrink: 0; width: 13px; height: 13px; line-height: 12px; text-align: center;
  border-radius: 50%; font-size: 11px; opacity: .5; margin-left: 1px;
}
.dsh-ego-side-tabclose:hover { background: rgba(255,255,255,.2); color: #ff453a; opacity: 1; }

/* ---- main body ---- */
.dsh-ego-side-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px; }
.dsh-ego-side-empty { padding: 20px 12px; text-align: center; font-size: 12px; opacity: .5; line-height: 1.7; }

.dsh-ego-side-liveview { display: flex; flex-direction: column; gap: 7px; min-height: 60px; overflow: hidden; }
.dsh-ego-side-livebadge {
  font-size: 10.5px; opacity: .6; letter-spacing: .2px;
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  position: relative; z-index: 40;
}
.dsh-ego-side-badgeline {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; position: relative;
}
.dsh-ego-side-badgestatus { white-space: nowrap; }
.dsh-ego-side-pageinfo {
  flex-basis: 100%; display: flex; align-items: baseline; gap: 8px;
  min-width: 0; font-size: 10.5px;
}
.dsh-ego-side-pageinfo .dsh-ego-side-livetitle {
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 62%; flex: none;
}
.dsh-ego-side-pageinfo .dsh-ego-side-liveurl {
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0;
}
.dsh-ego-side-presets {
  position: absolute; top: 24px; right: 0; z-index: 30;
  min-width: 92px; padding: 4px; display: flex; flex-direction: column; gap: 2px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  border: 1px solid rgba(128,128,128,.3); border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0,0,0,.18);
}
.dsh-ego-side-preset-item {
  border: 0; background: transparent; color: inherit; text-align: left;
  font-size: 11px; padding: 4px 10px; border-radius: 6px; cursor: pointer;
}
.dsh-ego-side-preset-item:hover { background: rgba(128,128,128,.2); }
.dsh-ego-side-stage { position: relative; display: block; min-height: 0; }
.dsh-ego-side-resize { position: absolute; z-index: 10; background: transparent; }
.dsh-ego-side-resize-right { top: 0; bottom: 0; right: 0; width: 12px; cursor: col-resize; }
.dsh-ego-side-resize-bottom { left: 0; right: 0; bottom: 0; height: 12px; cursor: row-resize; }
.dsh-ego-side-resize-corner {
  right: 0; bottom: 0; width: 20px; height: 20px; cursor: nwse-resize;
  border-bottom-right-radius: 9px;
}
/* No permanent colour band: a whisper of affordance on hover, and a slightly
   warmer hint while size-sync is unlocked. The handles themselves stay
   transparent so the frame edge looks clean. */
.dsh-ego-side-stage:hover .dsh-ego-side-resize-right {
  background: linear-gradient(to left, rgba(128,128,128,.26), rgba(128,128,128,0));
}
.dsh-ego-side-stage:hover .dsh-ego-side-resize-bottom {
  background: linear-gradient(to top, rgba(128,128,128,.26), rgba(128,128,128,0));
}
.dsh-ego-side-stage:hover .dsh-ego-side-resize-corner { background: rgba(128,128,128,.28); }
.dsh-ego-size-unlocked .dsh-ego-side-resize-right {
  background: linear-gradient(to left, rgba(217,119,87,.10), rgba(217,119,87,0));
}
.dsh-ego-size-unlocked .dsh-ego-side-resize-bottom {
  background: linear-gradient(to top, rgba(217,119,87,.10), rgba(217,119,87,0));
}
.dsh-ego-size-unlocked .dsh-ego-side-resize-corner { background: rgba(217,119,87,.10); }
.dsh-ego-side-resize:hover { background: rgba(217,119,87,.45) !important; }
.dsh-ego-side-state-dot {
  display: inline-block; width: 7px; height: 7px; border-radius: 50%;
  background: #30d158; box-shadow: 0 0 5px #30d15888; flex-shrink: 0;
  animation: dsh-ego-side-breathe 2.4s ease-in-out infinite;
}
.dsh-ego-side-state-dot.busy { background: #30d158; box-shadow: 0 0 6px #30d158bb; animation: none; }
.dsh-ego-side-state-dot.pin { background: #0a84ff; box-shadow: 0 0 5px #0a84ff88; animation: none; }
@keyframes dsh-ego-side-breathe {
  0%, 100% { box-shadow: 0 0 2px #30d15822; opacity: .5; }
  50%      { box-shadow: 0 0 10px #30d158ee; opacity: 1; }
}
.dsh-ego-side-back {
  background: rgba(128,128,128,.18); border: 1px solid rgba(128,128,128,.2);
  border-radius: 6px; cursor: pointer; font-size: 10.5px; padding: 2px 8px;
  display: inline-flex; align-items: center; gap: 3px;
  transition: background .15s ease; color: inherit;
}
.dsh-ego-side-back:hover { background: rgba(128,128,128,.3); }
.dsh-ego-side-back-on { color: #d97757; box-shadow: inset 0 0 0 1px #d97757; }
.dsh-ego-side-liveimg {
  width: 100%; border-radius: 9px; display: block;
  max-height: 50vh; object-fit: contain;
  border: 1px solid rgba(128,128,128,.2); background: #000;
  user-select: none; -webkit-user-select: none; touch-action: none;
  will-change: transform; cursor: grab;
}
/* #81: the semantic <img> keeps layout + pointer/zoom; the two overlay layers
   carry the visible pixels and only swap once the next frame has decoded. */
.dsh-ego-side-livebox { position: relative; width: 100%; min-height: 0; }
.dsh-ego-side-liveimg-semantic { opacity: 0; }
.dsh-ego-side-livebuf {
  position: absolute; inset: 0; width: 100%; height: 100%;
  display: block; object-fit: contain; opacity: 0;
  pointer-events: none; will-change: opacity;
}
.dsh-ego-side-livebuf.dsh-ego-side-livebuf-on { opacity: 1; }
.dsh-ego-side-livetitle { font-size: 12px; font-weight: 600; }
.dsh-ego-side-liveurl { font-size: 10.5px; opacity: .55; word-break: break-all; }
.dsh-ego-side-liveurl.dsh-ego-side-hint { color: #75c2ff; font-style: italic; font-weight: 500; opacity: 1; }
.dsh-ego-side-hint { animation: dsh-ego-side-hint-in .2s ease; }
@keyframes dsh-ego-side-hint-in { from { opacity: .3 } to { opacity: 1 } }

/* ---- history overlay (covers the body area) ---- */
.dsh-ego-side-history {
  flex: 1; min-height: 0; display: flex; flex-direction: column;
  overflow: hidden;
}
.dsh-ego-side-historyhead {
  padding: 8px 10px; font-size: 11px; font-weight: 600; opacity: .6;
  display: flex; align-items: center; gap: 5px;
  border-bottom: 1px solid rgba(128,128,128,.1); flex-shrink: 0;
}
.dsh-ego-side-historyhead svg { width: 11px; height: 11px; }
.dsh-ego-side-historylist { overflow-y: auto; padding: 5px; }
.dsh-ego-side-hitem {
  display: flex; gap: 7px; align-items: center; padding: 5px; border-radius: 8px;
  cursor: pointer; transition: background .15s ease;
}
.dsh-ego-side-hitem:hover { background: rgba(128,128,128,.15); }
.dsh-ego-side-hitem.active { background: rgba(10,132,255,.15); }
.dsh-ego-side-hthumb {
  width: 52px; height: 38px; border-radius: 5px; object-fit: cover; background: #000;
  flex-shrink: 0; border: 1px solid rgba(128,128,128,.2);
}
.dsh-ego-side-hinfo { min-width: 0; flex: 1; }
.dsh-ego-side-htitle { font-size: 10px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-ego-side-hurl { font-size: 9.5px; opacity: .5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-ego-side-hactive { color: #30d158; font-size: 9.5px; }
.dsh-ego-side-hnone { padding: 16px 8px; text-align: center; font-size: 10.5px; opacity: .4; }
`

		// ── LivePreviewController ───────────────────────────────────────────────
		// Vanilla class holding all mutable watch state + SSE/poll/input/zoom
		// logic. Extracted from the floating panel's imperative DOM code so the
		// React Tab component can subscribe to a snapshot store and delegate
		// pointer/wheel events to controller methods. The controller holds a ref
		// to the live <img> element (set via setLiveImg) so it can swap src in
		// place at rAF cadence without triggering React re-renders per frame.
		// `ctx` is stored so the controller can call ctx.get('betterSidebar')
		// to auto-open the Tab on the first ego_* tool call.
		function LivePreviewController(ctx) {
			this.ctx = ctx
			this.store = createSnapshotStore(this._initialState())
			this.frameCache = new Map()
			this.pageMeta = new Map()
			this.lastList = []
			this.pinned = null
			this.currentActiveId = null
			this.agentActiveId = null
			this.selectedTabId = null
			this.zoomState = { scale: 1, tx: 0, ty: 0 }
			this.liveCount = 0
			this.disposed = false
			this.visible = false
			this.clientId = 'sidebar-' + Math.random().toString(36).slice(2)
			// Desired screencast width, set by the panel from its real display
			// width (× devicePixelRatio). Capturing at 1280 for a ~550 px panel
			// made Chrome encode, ship and decode ~5x the pixels the user can
			// actually see; the worker caps this against the configured max.
			this.maxWidthHint = 800
			this.watchMaxWidth = 0
			this._maxWidthTimer = null
			this.watchStarted = false
			this.watchTargetId = null
			this.watchRenewTimer = null
			this.watchStopTimer = null
			this.watchRequest = null
			this.backend = 'cdp'
			this.streamGeneration = 0
			this.streamState = 'idle'
			this.streamMessage = ''
			this.streamMime = 'video/mp4; codecs="avc1.42E01E"'
			this.liveVideo = null
			this.videoCleanup = null
			this.documentVisible = document.visibilityState !== 'hidden'
			this.onDocumentVisibility = this._handleDocumentVisibility.bind(this)
			this.sse = null
			this.reconnectFallbackTimer = null
			this.lastSawActive = false
			this.lastFrameAt = 0
			this.followTimer = null
			this.pendingLiveFrame = null
			this.liveFlushRaf = null
			this.liveImg = null
			this.liveImgTargetId = null
			// #81: double-buffered presentation. Two overlay <img> layers; the
			// visible one keeps showing the old frame until the next frame has
			// finished decoding, so replacing a frame never blanks the panel.
			this.liveBuffers = null
			this.liveBufferIndex = 0
			this.liveBufferLoading = false
			this.liveBufferPending = null
			this.liveFrameUrl = null
			this.liveFrameTargetId = null
			this.wiringStale = false
			this._lastUnwiredAt = 0
			this._wiredRecomputeQueued = false
			this.historyOpen = false
			this._zoomHint = null
			this._zoomHintTimer = null
			this._pointerState = null
			var self = this
			this.keyboardProxy = createKeyboardProxy(function (targetId, type, params) { self.sendInput(targetId, type, params) })
			this.dismissedGuides = { login: false, captcha: false }
		}
		LivePreviewController.prototype._initialState = function () {
			return {
				spaces: [],
				pinned: null,
				selectedTabId: null,
				currentTargetId: null,
				currentSpace: null,
				liveCount: 0,
				busy: false,
				showLoginGuide: false,
				captchaKind: null,
				historyOpen: false,
				zoomHint: null,
				wiringStale: false,
				backend: 'cdp', streamState: 'idle', streamMessage: '', streamGeneration: 0, streamMime: 'video/mp4; codecs="avc1.42E01E"',
				// Mirrors the settings switch: the Tab shows the disabled state
				// (and opens no stream) while the frame relay is off.
				relayDisabled: false,
			}
		}
		LivePreviewController.prototype.subscribe = function (cb) {
			return this.store.subscribe(cb)
		}
		LivePreviewController.prototype.getSnapshot = function () {
			return this.store.getSnapshot()
		}
		LivePreviewController.prototype._recompute = function () {
			var hasPage = this.lastList.some(function (s) { return s.url && !s.url.startsWith('about:') })
			var captchaHit = this.lastList.find(function (s) { return s.humanCheck && s.humanCheck.detected })
			var self = this
			var currentSpace = null
			var currentTargetId = null
			if (this.pinned) {
				currentSpace = this.pinned
				currentTargetId = this.pinned.targetId
			} else if (this.selectedTabId !== null) {
				currentSpace = this.lastList.find(function (s) { return s.targetId === self.selectedTabId }) || null
				currentTargetId = this.selectedTabId
				// spaces payloads no longer carry thumbnails; pull the latest
				// cached JPEG from the SSE frame pipeline so the view shows
				// something instead of "no screenshot yet".
				if (currentSpace && !currentSpace.thumbnail) {
					var cached = this.frameCache.get(currentTargetId)
					if (cached) currentSpace = Object.assign({}, currentSpace, { thumbnail: cached })
				}
			} else {
				var activeMarked = this.lastList.find(function (s) { return s.active === true })
				if (!activeMarked && this.lastList.length > 0) {
					activeMarked = this.lastList.slice().sort(function (a, b) { return (b.lastActive || 0) - (a.lastActive || 0) })[0]
				}
				if (activeMarked) {
					currentSpace = Object.assign({}, activeMarked)
					currentTargetId = activeMarked.targetId
					if (!currentSpace.thumbnail) {
						var cached2 = this.frameCache.get(currentTargetId)
						if (cached2) currentSpace.thumbnail = cached2
					}
				}
			}
			this.currentActiveId = currentTargetId
			// Wiring watchdog: the live <img>/<video> is bound to this controller by a
			// ref callback at attach time. If the binding was ever missed (mount-order
			// race) or the element was replaced, liveImgTargetId drifts from the
			// current target and every click/keypress would be silently dropped.
			// Surface the drift on the badge instead of hiding it.
			this.wiringStale = currentTargetId != null && this.liveImgTargetId !== currentTargetId
			var showLogin = hasPage && !captchaHit && !this.dismissedGuides.login
			var captchaKind = (captchaHit && !this.dismissedGuides.captcha) ? (captchaHit.humanCheck.kind || 'captcha') : null
			this.store.update(function (s) {
				s.spaces = self.lastList
				s.pinned = self.pinned
				s.selectedTabId = self.selectedTabId
				s.currentTargetId = currentTargetId
				s.currentSpace = currentSpace
				s.liveCount = self.liveCount
				s.busy = self.lastSawActive
				s.showLoginGuide = showLogin
				s.captchaKind = captchaKind
				s.historyOpen = self.historyOpen
				s.zoomHint = self._zoomHint
				s.wiringStale = self.wiringStale
				s.backend = self.backend
				s.streamState = self.streamState
				s.streamMessage = self.streamMessage
				s.streamGeneration = self.streamGeneration
				s.streamMime = self.streamMime
				s.relayDisabled = frameRelayDisabled
			})
			this._syncWatch(currentTargetId)
		}
		LivePreviewController.prototype.start = function () {
			document.addEventListener('visibilitychange', this.onDocumentVisibility)
			var self = this
			// Live settings switch: off tears the pull streams down at once,
			// back on resumes them without a page reload.
			this.offRelayWatch = frameRelaySubscribe(function (disabled) { self._onRelayChange(disabled) })
			this._recompute()
			if (this.visible) { this.refresh(); this.openStream() }
		}
		LivePreviewController.prototype._onRelayChange = function (disabled) {
			if (this.disposed) return
			if (disabled) {
				this.closeStream()
				this._destroyVideo()
				this._stopWatch(false)
				this.lastList = []
				this.pageMeta.clear()
				this.frameCache.clear()
				this.streamState = 'idle'
				this.streamMessage = ''
			}
			this._recompute()
			if (!disabled && this.visible) { this.refresh(); this.openStream(); this._syncWatch(this.currentActiveId) }
		}
		LivePreviewController.prototype.dispose = function () {
			this.keyboardProxy.dispose()
			this.disposed = true
			if (this.offRelayWatch) { try { this.offRelayWatch() } catch (e) {} this.offRelayWatch = null }
			if (this.liveFlushRaf != null) try { window.cancelAnimationFrame(this.liveFlushRaf) } catch (e) {}
			if (this.followTimer) window.clearTimeout(this.followTimer)
			if (this.reconnectFallbackTimer) window.clearTimeout(this.reconnectFallbackTimer)
			if (this._zoomHintTimer) window.clearTimeout(this._zoomHintTimer)
			if (this._maxWidthTimer) window.clearTimeout(this._maxWidthTimer)
			this._maxWidthTimer = null
			document.removeEventListener('visibilitychange', this.onDocumentVisibility)
			if (this.watchRenewTimer) window.clearInterval(this.watchRenewTimer)
			if (this.watchStopTimer) window.clearTimeout(this.watchStopTimer)
			this._stopWatch(true)
			this._destroyVideo()
			this.closeStream()
		}
		LivePreviewController.prototype._handleDocumentVisibility = function () {
			this.documentVisible = document.visibilityState !== 'hidden'
			if (this.documentVisible && this.visible) {
				this.refresh()
				if (!this.sse) this.openStream()
				this._syncWatch(this.currentActiveId)
			}
		}
		LivePreviewController.prototype.setVisible = function (v) {
			var changed = this.visible !== v
			this.visible = v
			var effective = v
			if (effective) {
				// On becoming visible again, do a one-shot fallback fetch to
				// re-sync immediately (the SSE `spaces` event will also catch
				// up on the next keepalive tick, but this avoids a blank gap).
				this.refresh()
				this.openStream()
				this._syncWatch(this.currentActiveId)
			} else {
				this.closeStream()
				this._stopWatch(false)
				this._destroyVideo()
			}
		}
		// The panel width can settle after the first watch/start (macOS pane was
		// 0-width at mount, #81). When the measured width differs a lot from the
		// one the running capture was started with, restart the watch once so the
		// stream is re-created at the right resolution instead of staying blurry.
		LivePreviewController.prototype.scheduleMaxWidthRefresh = function () {
			var self = this
			if (this.disposed || this._maxWidthTimer) return
			this._maxWidthTimer = window.setTimeout(function () {
				self._maxWidthTimer = null
				if (self.disposed || !self.visible || !self.watchStarted || self.watchTargetId == null) return
				var applied = self.watchMaxWidth || 0
				var next = self.maxWidthHint || 0
				if (!(applied > 0) || !(next > 0)) return
				if (Math.abs(next - applied) < applied * 0.2) return
				var target = self.watchTargetId
				self.watchStarted = false
				self._syncWatch(target)
			}, 700)
		}
		LivePreviewController.prototype._requestWatch = function (route, body) {
			if (this.watchRequest) return null
			var self = this
			this.watchRequest = postJson(route, body).finally(function () { self.watchRequest = null })
			return this.watchRequest
		}
		LivePreviewController.prototype._applyCaptureStatus = function (status) {
			if (!status || typeof status !== 'object') return
			if (Number.isFinite(status.generation) && status.generation < this.streamGeneration) return
			if (status.generation === this.streamGeneration && this.streamState === 'streaming' && status.state === 'starting') return
			var nextBackend = status.backend || this.backend
			var nextGeneration = status.generation ?? this.streamGeneration
			var nextState = status.state || this.streamState
			var generationChanged = this.streamGeneration !== nextGeneration
			this.backend = nextBackend; this.streamState = nextState; this.streamMessage = status.message || status.code || ''; this.streamGeneration = nextGeneration; this.streamMime = status.mime || this.streamMime
			if (generationChanged || this.backend !== 'ffmpeg') this._destroyVideo()
			this._recompute()
		}
		LivePreviewController.prototype._syncWatch = function (targetId) {
			if (this.disposed || !this.visible || !targetId) return
			var self = this
			if (this.watchStopTimer) { window.clearTimeout(this.watchStopTimer); this.watchStopTimer = null }
			var route = this.watchStarted ? WATCH_SWITCH_ROUTE : WATCH_START_ROUTE
			if (this.watchStarted && this.watchTargetId === targetId) return
			var body = { clientId: this.clientId, targetId: targetId, maxWidth: this.maxWidthHint }
			var request = this._requestWatch(route, body)
			if (!request) { this.watchRequest.finally(function () { self._syncWatch(targetId) }); return }
			request.then(function (status) {
				self.watchStarted = status && status.ok !== false
				self.watchTargetId = status && status.targetId || targetId
				self.watchMaxWidth = self.maxWidthHint
				if (self.watchTargetId !== targetId) { self.selectedTabId = null; self.currentActiveId = self.watchTargetId }
				self._applyCaptureStatus(status)
				if (!self.visible) self._stopWatch(true)
			}).catch(function () {})
			if (!this.watchRenewTimer) this.watchRenewTimer = window.setInterval(function () {
				if (self.visible && self.watchTargetId) { var renewal = self._requestWatch(WATCH_START_ROUTE, { clientId: self.clientId, targetId: self.watchTargetId, maxWidth: self.maxWidthHint }); if (renewal) renewal.then(function (status) { self._applyCaptureStatus(status) }).catch(function () {}) }
			}, 5000)
		}
		LivePreviewController.prototype._stopWatch = function (immediate) {
			var self = this
			if (this.watchRenewTimer) { window.clearInterval(this.watchRenewTimer); this.watchRenewTimer = null }
			var stop = function () {
				self.watchStopTimer = null
				self.watchStarted = false; self.watchTargetId = null
				postJson(WATCH_STOP_ROUTE, { clientId: self.clientId }).catch(function () {})
			}
			if (immediate) stop()
			else { if (this.watchStopTimer) window.clearTimeout(this.watchStopTimer); this.watchStopTimer = window.setTimeout(stop, 1500) }
		}
		LivePreviewController.prototype._destroyVideo = function () {
			if (this.videoCleanup) try { this.videoCleanup() } catch (e) {}
			this.videoCleanup = null; this.liveVideo = null
		}
		LivePreviewController.prototype.setLiveVideo = function (video, targetId) {
			this._destroyVideo()
			this.liveVideo = video; this.liveImg = video; this.liveImgTargetId = targetId
			if (!video || this.backend !== 'ffmpeg' || this.streamState !== 'streaming') return
			var self = this
			this.videoCleanup = createMsePlayer(video, this.streamGeneration, this.streamMime, function (message) {
				self.streamState = 'failed'; self.streamMessage = message; self._recompute()
			})
		}
		LivePreviewController.prototype.setLiveImg = function (img, targetId) {
			this.liveImg = img
			this.liveImgTargetId = targetId
			if (img && targetId != null) {
				var cached = this.frameCache.get(targetId)
				if (cached) {
					try { img.src = cached } catch (e) {}
				}
				this._seedLiveBuffers(cached || null)
			}
		}
		// #81 — double-buffered frame presentation. `liveImg` stays the semantic
		// element (layout, natural size, pointer/zoom); the two overlay buffers
		// carry the visible pixels and swap only after decode completes.
		LivePreviewController.prototype.setLiveBuffers = function (buffers) {
			this.liveBuffers = buffers && buffers.length === 2 ? buffers : null
			this.liveBufferIndex = 0
			this.liveBufferLoading = false
			this.liveBufferPending = null
			if (!this.liveBuffers) return
			this._seedLiveBuffers(this.frameCache.get(this.liveImgTargetId) || null)
		}
		LivePreviewController.prototype._seedLiveBuffers = function (seed) {
			var buffers = this.liveBuffers
			if (!buffers) return
			for (var i = 0; i < 2; i++) {
				var el = buffers[i]
				if (!el) continue
				try { el.style.opacity = i === 0 ? '1' : '0' } catch (e) {}
				if (seed) { try { el.src = seed } catch (e) {} }
				else { try { el.removeAttribute('src') } catch (e) {} }
			}
			this.liveFrameUrl = seed || null
			this.liveBufferIndex = 0
		}
		LivePreviewController.prototype._presentLiveFrame = function (dataUrl) {
			if (!dataUrl) return
			this.liveFrameUrl = dataUrl
			this.liveFrameTargetId = this.liveImgTargetId
			if (!this.liveBuffers) {
				if (this.liveImg) { try { this.liveImg.src = dataUrl } catch (e) {} }
				return
			}
			if (this.liveBufferLoading) { this.liveBufferPending = dataUrl; return }
			var nextIndex = 1 - this.liveBufferIndex
			var next = this.liveBuffers[nextIndex]
			var current = this.liveBuffers[this.liveBufferIndex]
			if (!next) return
			var self = this
			var settled = false
			var settle = function () {
				if (settled) return
				settled = true
				if (!self.liveBuffers || self.liveBuffers[nextIndex] !== next) { self.liveBufferLoading = false; return }
				self.liveBufferLoading = false
				try {
					next.style.opacity = '1'
					if (current) current.style.opacity = '0'
				} catch (e) {}
				self.liveBufferIndex = nextIndex
				if (self.liveBufferPending) {
					var pending = self.liveBufferPending
					self.liveBufferPending = null
					self._presentLiveFrame(pending)
				}
			}
			this.liveBufferLoading = true
			try {
				next.onload = settle
				next.onerror = settle
				next.src = dataUrl
			} catch (e) {
				settle()
			}
			try { if (next.decode) next.decode().then(settle, settle) } catch (e) {}
		}
		// `refresh` is NOT a polling loop anymore. It is a one-shot fallback
		// used at start / setVisible(true) / SSE reconnect to re-sync the tab
		// list immediately. The authoritative metadata source is the SSE
		// `spaces` event broadcast by the worker every ~500ms.
		LivePreviewController.prototype.refresh = function () {
			var self = this
			// While the relay is off there is nothing to sync (the host refuses
			// the space list): surface the disabled state instead of fetching.
			if (frameRelayDisabled) {
				self.lastList = []
				self.pageMeta.clear()
				self.frameCache.clear()
				self._recompute()
				return
			}
			void (async function () {
				try {
					var res = await fetch(SPACES_ROUTE, { cache: 'no-store' })
					if (self.disposed || !res.ok) { self._renderEmpty(); return }
					var data = await res.json()
					if (!data || data.ok !== true) { self._renderEmpty(); return }
					self._applyCaptureStatus(data.capture)
					self._processSpaces(data.spaces)
				} catch (e) {
					self._renderEmpty()
				}
			})()
		}
		LivePreviewController.prototype._renderEmpty = function () {
			if (this.lastList.length === 0) this._processSpaces([])
		}
		LivePreviewController.prototype._processSpaces = function (spaces) {
			if (this.disposed) return
			this.lastList = Array.isArray(spaces) ? spaces : []
			var self = this
			for (var i = 0; i < this.lastList.length; i++) {
				var s = this.lastList[i]
				var prev = this.pageMeta.get(s.targetId) || { targetId: s.targetId }
			var meta = {
				url: s.url,
				title: s.title,
				targetId: s.targetId,
			} as any
				if (Number.isFinite(s.viewportW)) meta.vw = s.viewportW
				else if (prev.vw !== undefined) meta.vw = prev.vw
				if (Number.isFinite(s.viewportH)) meta.vh = s.viewportH
				else if (prev.vh !== undefined) meta.vh = prev.vh
				this.pageMeta.set(s.targetId, meta)
			}
			var liveIds = new Set(this.lastList.map(function (s) { return s.targetId }))
			var pm = this.pageMeta
			pm.forEach(function (_, id) { if (!liveIds.has(id)) pm.delete(id) })
			var fc = this.frameCache
			fc.forEach(function (_, id) { if (!liveIds.has(id)) fc.delete(id) })
			var activeMarked = this.lastList.find(function (s) { return s.active === true })
			if (activeMarked) this.agentActiveId = activeMarked.targetId
			this.liveCount = this.lastList.length
			// Busy signal: derived from whether any page was touched recently.
			// Previously this lived in the now-removed polling scheduler; moved
			// here so the SSE `spaces` event keeps the status dot live.
			var busy = this.lastList.some(function (s) { return (Date.now() - (s.lastActive || 0)) <= ACTIVE_WINDOW_MS })
			if (busy !== this.lastSawActive) this.lastSawActive = busy
			this._recompute()
		}
		// Open the pull streams UNLESS the frame relay is disabled. The host's
		// /api/ego/watch/status is authoritative (`frameRelay:false`), so a stale
		// client flag can never open a stream the host refuses to serve; when the
		// relay is off this opens NO EventSource and the Tab renders the disabled
		// state instead of reconnect-looping.
		LivePreviewController.prototype.openStream = function () {
			if (this.disposed || !this.visible || frameRelayDisabled) return
			var self = this
			fetch(WATCH_STATUS_ROUTE, { cache: 'no-store' }).then(function (res) { return res.ok ? res.json() : null }).then(function (status) {
				if (self.disposed || !self.visible || frameRelayDisabled) return
				if (frameRelayOff(status)) { self.closeStream(); self._destroyVideo(); self._recompute(); return }
				self._applyCaptureStatus(status)
				self._connectStream()
			}).catch(function () { if (!self.disposed && self.visible && !frameRelayDisabled) self._connectStream() })
		}
		LivePreviewController.prototype._connectStream = function () {
			if (this.disposed || frameRelayDisabled || this.sse) return
			var self = this
			this.closeStream()
			try {
				this.sse = new EventSource('/api/ego/stream')
			} catch (e) { return }
			this.sse.addEventListener('frame', function (ev) {
				try {
					var m = JSON.parse(ev.data)
					if (!m || !m.targetId || !m.data) return
					if (Number.isFinite(m.vw) && Number.isFinite(m.vh)) {
						var cur = self.pageMeta.get(m.targetId) || { targetId: m.targetId }
						self.pageMeta.set(m.targetId, Object.assign({}, cur, { vw: m.vw, vh: m.vh }))
					}
					self.applyFrame(m.targetId, 'data:image/jpeg;base64,' + m.data, m.vw, m.vh)
				} catch (e) {}
			})
			this.sse.addEventListener('spaces', function (ev) {
				if (self.disposed) return
				try {
					var list = JSON.parse(ev.data)
					if (Array.isArray(list)) {
						// _processSpaces is the authoritative path: it merges
						// pageMeta, prunes dead tabs from the caches, recomputes
						// the active page, and pushes a store snapshot. The
						// worker broadcasts this every keepalive tick (~500ms)
						// and on tab churn, replacing the old polling loop.
						self._processSpaces(list)
					}
				} catch (e) {}
			})
			this.sse.addEventListener('capture-status', function (ev) {
				try {
					self._applyCaptureStatus(JSON.parse(ev.data))
				} catch (e) {}
			})
			// Debounced reconnect fallback: EventSource auto-reconnects on
			// error; we also kick off a one-shot /api/ego/spaces fetch so the
			// panel re-syncs immediately after a successful reconnect, without
			// waiting for the worker's next keepalive broadcast. The 1.5s
			// delay lets EventSource reconnect first, avoiding a redundant
			// fetch on a momentary blip.
			this.sse.onerror = function () {
				if (self.reconnectFallbackTimer) return
				self.reconnectFallbackTimer = window.setTimeout(function () {
					self.reconnectFallbackTimer = null
					if (self.disposed || !self.visible) return
					self.refresh()
				}, 1500)
			}
		}
		LivePreviewController.prototype.closeStream = function () {
			try { if (this.sse) this.sse.close() } catch (e) {}
			this.sse = null
		}
		LivePreviewController.prototype.applyFrame = function (targetId, dataUrl, vw, vh) {
			if (this.disposed) return
			this.frameCache.delete(targetId)
			this.frameCache.set(targetId, dataUrl)
			var MAX_CACHED_FRAMES = 12
			if (this.frameCache.size > MAX_CACHED_FRAMES) {
				var self = this
				this.frameCache.forEach(function (_, id) {
					if (self.frameCache.size <= MAX_CACHED_FRAMES) return
					if (id === targetId || id === self.liveImgTargetId) return
					self.frameCache.delete(id)
				})
			}
			if (Number.isFinite(vw) && Number.isFinite(vh)) {
				var cur = this.pageMeta.get(targetId) || { targetId: targetId }
				this.pageMeta.set(targetId, Object.assign({}, cur, { vw: vw, vh: vh }))
			}
			if (this.liveImg && this.liveImgTargetId === targetId) {
				var self2 = this
				this.pendingLiveFrame = dataUrl
				if (!this.liveFlushRaf && !this.disposed) {
					this.liveFlushRaf = window.requestAnimationFrame(function () {
						self2.liveFlushRaf = null
						if (self2.disposed || !self2.liveImg || self2.pendingLiveFrame == null) return
						var frameUrl = self2.pendingLiveFrame
						self2.pendingLiveFrame = null
						self2._presentLiveFrame(frameUrl)
					})
				}
				return
			}
			if (!this.pinned && this.selectedTabId === null && targetId === this.agentActiveId) {
				var now = Date.now()
				if (now - this.lastFrameAt >= FRAME_FOLLOW_MIN_MS) {
					this.lastFrameAt = now
					if (this.followTimer) window.clearTimeout(this.followTimer)
					var self3 = this
					this.followTimer = window.setTimeout(function () {
						if (self3.disposed || self3.pinned || self3.selectedTabId !== null) return
						if (self3.liveImg && self3.liveImgTargetId === targetId) return
						var meta = self3.pageMeta.get(targetId)
						if (!meta) return
						self3.currentActiveId = targetId
						self3._recompute()
					}, 0)
				}
			}
		}
		LivePreviewController.prototype.sendInput = function (targetId, type, params) {
			var targetValid = !!targetId
			if (!targetValid || this.disposed || ((type !== 'mouseReleased' && type !== 'keyUp') && !this.visible)) return
			var self = this
			void fetch(INPUT_ROUTE, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(Object.assign({ targetId: targetId, type: type }, params)),
			}).then(function (res) {
				if (res.status === 409) {
					self.liveImgTargetId = null
					self._pointerState = null
					self.refresh()
				}
			}).catch(function () {})
		}
		// A window resize answers with the exact new page viewport. Record it
		// immediately: the frame metadata that feeds click mapping arrives a
		// fraction later, and clicks in between would land at the old position.
		LivePreviewController.prototype.noteViewport = function (targetId, width, height) {
			if (!targetId || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
			var prev = this.pageMeta.get(targetId) || { targetId: targetId }
			this.pageMeta.set(targetId, Object.assign({}, prev, { vw: Math.round(width), vh: Math.round(height) }))
			this._recompute()
		}
		LivePreviewController.prototype.browserXY = function (e) {
			if (this.liveImgTargetId == null || !this.liveImg) return null
			var m = this.pageMeta.get(this.liveImgTargetId)
			var vw = m && m.vw, vh = m && m.vh
			if (!Number.isFinite(vw) || !Number.isFinite(vh)) return null
			var img = this.liveImg
			var rect = img.getBoundingClientRect()
			var natW = img.naturalWidth || img.videoWidth || rect.width
			var natH = img.naturalHeight || img.videoHeight || rect.height
			if (!natW || !natH) return null
			var scale = Math.min(rect.width / natW, rect.height / natH)
			var contentW = natW * scale
			var contentH = natH * scale
			var ox = (rect.width - contentW) / 2
			var oy = (rect.height - contentH) / 2
			var rx = e.clientX - rect.left - ox
			var ry = e.clientY - rect.top - oy
			return { x: (rx / contentW) * vw, y: (ry / contentH) * vh }
		}
		LivePreviewController.prototype.pinTo = function (space) {
			if (this.disposed) return
			this.pinned = space
			this.selectedTabId = null
			this._recompute()
		}
		LivePreviewController.prototype.unpin = function () {
			this.pinned = null
			this._recompute()
		}
		LivePreviewController.prototype.selectTab = function (targetId) {
			if (this.selectedTabId === targetId) {
				this.selectedTabId = null
				this.pinned = null
			} else {
				this.selectedTabId = targetId
				this.pinned = null
			}
			this._recompute()
			this._syncWatch(this.selectedTabId || this.currentActiveId)
		}
		LivePreviewController.prototype.closeTab = function (targetId) {
			var self = this
			void (async function () {
				try {
					await fetch(EGO_CLOSE_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId: targetId }) })
				} catch (e) {}
				if (self.selectedTabId === targetId) { self.selectedTabId = null; self.pinned = null }
				self.refresh()
			})()
		}
		LivePreviewController.prototype.toggleHistory = function () {
			this.historyOpen = !this.historyOpen
			this._recompute()
		}
		LivePreviewController.prototype.dismissGuide = function (which) {
			this.dismissedGuides[which] = true
			this._recompute()
		}
		LivePreviewController.prototype.flushLogin = function () {
			return (async function () {
				var r = await fetch(FLUSH_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
				return r.json()
			})()
		}
		// Zoom/pan/input handlers (called from React JSX)
		LivePreviewController.prototype._showHint = function (txt) {
			this._zoomHint = txt
			this._recompute()
			if (this._zoomHintTimer) window.clearTimeout(this._zoomHintTimer)
			var self = this
			this._zoomHintTimer = window.setTimeout(function () {
				self._zoomHint = null
				self._recompute()
			}, 2000)
		}
		// Called by the element ref callbacks right after a (re)bind. If the badge
		// was showing ⚠未接管, clear it via a microtask recompute — store updates
		// scheduled from the commit phase are safe and cannot loop (the flag is
		// already false when the next render runs).
		LivePreviewController.prototype.noteWired = function () {
			if (!this.wiringStale) return
			this.wiringStale = false
			if (this._wiredRecomputeQueued) return
			this._wiredRecomputeQueued = true
			var self = this
			Promise.resolve().then(function () {
				self._wiredRecomputeQueued = false
				if (!self.disposed) self._recompute()
			})
		}
		// Fail visible, never silent: a pointer/wheel intent that cannot be mapped
		// (browserXY → null because the live view was never wired) used to vanish
		// without a trace. Warn once per 5s and show a hint; _showHint triggers a
		// recompute → re-render → ref callback re-fires → the view rebinds, so the
		// NEXT click already works (self-healing through the retry).
		LivePreviewController.prototype._signalUnwired = function () {
			var now = Date.now()
			if (now - this._lastUnwiredAt < 5e3) return
			this._lastUnwiredAt = now
			try { console.warn('[ego-browser] live view not wired (liveImgTargetId=' + this.liveImgTargetId + ', current=' + this.currentActiveId + ') — input dropped') } catch (e) {}
			this._showHint(wt('hintNotCaptured'))
		}
		LivePreviewController.prototype._applyZoom = function () {
			if (!this.liveImg) return
			this.liveImg.style.transformOrigin = '0 0'
			this.liveImg.style.transform = 'translate(' + this.zoomState.tx + 'px,' + this.zoomState.ty + 'px) scale(' + this.zoomState.scale + ')'
		}
		LivePreviewController.prototype.resetZoom = function () {
			this.zoomState = { scale: 1, tx: 0, ty: 0 }
			this._applyZoom()
			this._showHint(wt('hintReset'))
		}
		LivePreviewController.prototype.handleWheel = function (e) {
			e.preventDefault()
			e.stopPropagation()
			if (e.ctrlKey || e.metaKey) {
				if (!this.liveImg) return
				var rect = this.liveImg.getBoundingClientRect()
				var mx = e.clientX - rect.left, my = e.clientY - rect.top
				var next = Math.min(8, Math.max(1, this.zoomState.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
				if (next <= 1) { this.resetZoom(); return }
				this.zoomState.tx = mx - (mx - this.zoomState.tx) * (next / this.zoomState.scale)
				this.zoomState.ty = my - (my - this.zoomState.ty) * (next / this.zoomState.scale)
				this.zoomState.scale = next
				this._applyZoom()
				this._showHint(wt('hintPan'))
				return
			}
			var p = this.browserXY(e)
			if (p && this.liveImgTargetId) {
				this.sendInput(this.liveImgTargetId, 'mouseWheel', {
					x: p.x, y: p.y,
					deltaX: e.deltaX || 0,
					deltaY: e.deltaY || (e.deltaMode === 1 ? 40 : (e.deltaY || 100)),
				})
			} else {
				this._signalUnwired()
			}
		}
		LivePreviewController.prototype.handlePointerDown = function (e) {
			if (e.button !== 0) return
			this._pointerState = {
				viewPanning: false, browserDrag: false,
				sx: e.clientX, sy: e.clientY,
				stx: this.zoomState.tx, sty: this.zoomState.ty,
				lastDragPos: null, downButtons: 0, targetId: this.liveImgTargetId,
			}
			try { e.currentTarget.setPointerCapture(e.pointerId) } catch (err) {}
			if (e.ctrlKey || e.metaKey) {
				this._pointerState.viewPanning = true
				e.currentTarget.style.cursor = 'grabbing'
				this._showHint(wt('hintScroll'))
				return
			}
			this._pointerState.browserDrag = true
			this.keyboardProxy.focusAt(e, this._pointerState.targetId)
			this._pointerState.downButtons = 1
			var p = this.browserXY(e)
			if (p) {
				this._pointerState.lastDragPos = p
				this.sendInput(this._pointerState.targetId, 'mousePressed', { x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
			} else {
				this._signalUnwired()
			}
		}
		LivePreviewController.prototype.handlePointerMove = function (e) {
			if (!this._pointerState) {
				var p = this.browserXY(e)
				if (p) this.sendInput(this.liveImgTargetId, 'mouseMoved', { x: p.x, y: p.y, buttons: 0 })
				return
			}
			if (this._pointerState.viewPanning) {
				this.zoomState.tx = this._pointerState.stx + (e.clientX - this._pointerState.sx)
				this.zoomState.ty = this._pointerState.sty + (e.clientY - this._pointerState.sy)
				this._applyZoom()
				return
			}
			if (this._pointerState.browserDrag) {
				var p2 = this.browserXY(e)
				if (p2) {
					this.sendInput(this._pointerState.targetId, 'mouseMoved', { x: p2.x, y: p2.y, buttons: this._pointerState.downButtons })
					this._pointerState.lastDragPos = p2
				}
			}
		}
		LivePreviewController.prototype.handlePointerUp = function (e) {
			if (!this._pointerState) return
			if (this._pointerState.viewPanning) {
				if (e.currentTarget) e.currentTarget.style.cursor = 'grab'
			}
			if (this._pointerState.browserDrag) {
				if (this._pointerState.lastDragPos && this._pointerState.targetId) {
					this.sendInput(this._pointerState.targetId, 'mouseReleased', {
						x: this._pointerState.lastDragPos.x, y: this._pointerState.lastDragPos.y,
						button: 'left', buttons: 0, clickCount: 1,
					})
				}
			}
			if (e.currentTarget) e.currentTarget.style.cursor = 'grab'
			this._pointerState = null
		}
		LivePreviewController.prototype.handleDoubleClick = function (e) {
			e.preventDefault()
			this.resetZoom()
		}

		// ── EgoBrowserTab: React component for the sidebar tab ─────────────────
		// Renders header + guide strips + tab strip + main live view (or history
		// overlay). Subscribes to the controller's snapshot store; delegates
		// pointer/wheel events on the live <img> to controller methods. The
		// controller holds a direct ref to the <img> so SSE frames swap src at rAF
		// cadence without triggering React re-renders per frame.
		function EgoBrowserTab(props) {
			var visible = props.visible
			var visibleRef = React.useRef(visible)
			visibleRef.current = visible
			var ctx = props.ctx
			var controllerRef = React.useRef(null)
			if (controllerRef.current === null) controllerRef.current = new LivePreviewController(ctx)
			var controller = controllerRef.current

			// Create the snapshot hook once per controller instance
			var useSnapshotRef = React.useRef(null)
			if (useSnapshotRef.current === null) {
				useSnapshotRef.current = bindSnapshotSelector(controller.store)
			}
			// bindSnapshotSelector returns a selector hook that REQUIRES a selector
			// function arg (it uses useSyncExternalStoreWithSelector internally).
			// Calling it with no args → "w is not a function" (w is the minified
			// selector param). Pass identity selector to get the whole snapshot.
			var state = useSnapshotRef.current(function (s) { return s })

			var imgRef = React.useRef(null)
			var videoRef = React.useRef(null)
			var rootRef = React.useRef(null)
			// Size-sync toggle: unlocked, the live image box drives the REAL agent
			// browser window size (via the worker's CDP window bounds route).
			var sizeSyncRef = React.useRef(null)
			if (sizeSyncRef.current === null) {
				sizeSyncRef.current = createWindowSizeSync()
				sizeSyncRef.current.setEnabled(sizeSyncStored())
			}
			var sizeSync = sizeSyncRef.current
			var sizeSyncState = React.useState(sizeSync.isEnabled())
			var sizeSyncOn = sizeSyncState[0]
			var setSizeSyncOn = sizeSyncState[1]

			// #73: executor diagnostics from the host (resident/one-shot, pid,
			// age, last rebuild reason). Polled slowly; failures are silent.
			var residentState = React.useState(null)
			var residentInfo = residentState[0]
			var setResidentInfo = residentState[1]
			React.useEffect(function () {
				var disposed = false
				var load = function () {
					fetch('/api/ego/executor', { cache: 'no-store' })
						.then(function (r) { return r.ok ? r.json() : null })
						.then(function (json) { if (!disposed && json && json.ok) setResidentInfo(json) })
						.catch(function () {})
				}
				load()
				var timer = window.setInterval(load, 15000)
				return function () { disposed = true; window.clearInterval(timer) }
			}, [])

			// Aspect-ratio presets: one-shot resizes, independent of the drag
			// toggle. The worker keeps the current width and derives the height.
			var presetState = React.useState(false)
			var presetOpen = presetState[0]
			var setPresetOpen = presetState[1]
			var noticeState = React.useState('')
			var sizeNotice = noticeState[0]
			var setSizeNotice = noticeState[1]
			var presetRef = React.useRef(null)
			var PRESETS = [
				{ label: '16:9', ratio: 16 / 9 },
				{ label: '4:3', ratio: 4 / 3 },
				{ label: '21:9', ratio: 21 / 9 },
				{ label: '1:1', ratio: 1 },
				{ label: '9:16', ratio: 9 / 16 },
			]
			// Surface a host/client version mismatch instead of failing silently:
			// the client bundle can be newer than the running host process.
			var noteSizeResult = function (status, parsed) {
				if (status === 400 || status === 404) setSizeNotice(wt('sizeApiOutdated'))
				else if (parsed && parsed.ok === true) setSizeNotice('')
			}
			var applyPreset = function (ratio) {
				setPresetOpen(false)
				fetch('/api/ego/window-size', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ aspect: ratio }),
				}).then(function (r) {
					return r.json().catch(function () { return null }).then(function (parsed) {
						noteSizeResult(r.status, parsed)
						if (parsed && parsed.ok === true && parsed.viewport && controller.liveImgTargetId) {
							controller.noteViewport(controller.liveImgTargetId, parsed.viewport.width, parsed.viewport.height)
						}
						return parsed
					})
				}).catch(function () { return null })
			}
			React.useEffect(function () {
				if (!presetOpen) return
				var onDoc = function (event) {
					var menu = presetRef.current
					if (menu && event.target instanceof Node && menu.contains(event.target)) return
					setPresetOpen(false)
				}
				document.addEventListener('pointerdown', onDoc, true)
				return function () { document.removeEventListener('pointerdown', onDoc, true) }
			}, [presetOpen])
			// Resize handles over the live stage: dragging the right/bottom edge or
			// the corner resizes the REAL browser window. They work regardless of
			// the size-sync lock; the lock only governs whether sidebar-width
			// changes follow the window.
			var beginResize = function (axis) {
				return function (event) {
					event.preventDefault()
					event.stopPropagation()
					var startX = event.clientX
					var startY = event.clientY
					var sentX = 0
					var sentY = 0
					var lastAt = 0
					var inFlight = false
					var sendStep = function (stepX: number, stepY: number) {
						var payload: Record<string, number> = {}
						if (Math.abs(stepX) >= 1) payload.delta = Math.round(stepX)
						if (Math.abs(stepY) >= 1) payload.dy = Math.round(stepY)
						if (payload.delta === undefined && payload.dy === undefined) return
						fetch('/api/ego/window-size', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify(payload),
						}).then(function (r) {
							return r.json().catch(function () { return null }).then(function (parsed) {
								noteSizeResult(r.status, parsed)
								if (parsed && parsed.ok === true && parsed.viewport && controller.liveImgTargetId) {
									controller.noteViewport(controller.liveImgTargetId, parsed.viewport.width, parsed.viewport.height)
								}
								return parsed
							})
						}).catch(function () { return null })
							.finally(function () { inFlight = false })
					}
					var onMove = function (ev) {
						var dxTotal = axis === 'y' ? 0 : ev.clientX - startX
						var dyTotal = axis === 'x' ? 0 : ev.clientY - startY
						var stepX = dxTotal - sentX
						var stepY = dyTotal - sentY
						if (Math.abs(stepX) < 3 && Math.abs(stepY) < 3) return
						var now = Date.now()
						if (inFlight || now - lastAt < 120) return
						inFlight = true
						lastAt = now
						sentX = dxTotal
						sentY = dyTotal
						sendStep(stepX, stepY)
					}
					var onUp = function () {
						document.removeEventListener('pointermove', onMove)
						document.removeEventListener('pointerup', onUp)
						document.removeEventListener('pointercancel', onUp)
					}
					document.addEventListener('pointermove', onMove)
					document.addEventListener('pointerup', onUp)
					document.addEventListener('pointercancel', onUp)
				}
			}

			// Bind the live <img>/<video> to the controller the moment the element
			// attaches. The deps-based effect below only fires when target/backend/
			// generation change — but the <img> typically mounts LATER (placeholder →
			// first cached frame → thumbnail branch), with no dep change at that
			// moment, so the effect never wires it: liveImgTargetId stays null and
			// every click/keypress is silently dropped. A ref callback fires on every
			// attach, so the wiring cannot be missed regardless of mount order.
			var bindLiveImg = function (el) {
				imgRef.current = el
				if (el && state.currentTargetId != null &&
					(controller.liveImg !== el || controller.liveImgTargetId !== state.currentTargetId)) {
					controller.setLiveImg(el, state.currentTargetId)
					controller.noteWired()
				}
				if (sizeSyncOn) sizeSync.attach(el)
			}
			var bindLiveVideo = function (el) {
				videoRef.current = el
				if (el && state.currentTargetId != null &&
					(controller.liveImg !== el || controller.liveImgTargetId !== state.currentTargetId)) {
					controller.setLiveVideo(el, state.currentTargetId)
					controller.noteWired()
				}
				if (el) controller.setLiveBuffers(null)
				if (sizeSyncOn) sizeSync.attach(el)
			}

			// #81: two overlay <img> layers behind the semantic image. Stable ref
			// callbacks (React would otherwise detach/re-attach on every render).
			var liveBuffersRef = React.useRef([null, null])
			var syncLiveBuffersRef = React.useRef(function () {
				var list = liveBuffersRef.current
				controller.setLiveBuffers(list[0] && list[1] ? [list[0], list[1]] : null)
			})
			var bindLiveBufA = React.useRef(function (el) { liveBuffersRef.current[0] = el; syncLiveBuffersRef.current() })
			var bindLiveBufB = React.useRef(function (el) { liveBuffersRef.current[1] = el; syncLiveBuffersRef.current() })

			React.useEffect(function () {
				controller.start()
				return function () { controller.dispose() }
			}, [controller])

			// Tell the worker how wide the screencast should be: capturing at the
			// configured 1280 for a ~550 px panel wasted most of Chrome's encoder.
			// Must run before setVisible() so the first watch/start already carries
			// a measured width; a 0-width root used to lock the hint at 480 and
			// blur the frame (#81). A ResizeObserver keeps it fresh for later
			// watch restarts.
			React.useEffect(function () {
				var root = rootRef.current
				if (!root || !controller) return
				var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
				var update = function () {
					var width = root.clientWidth
					if (!(width > 0)) return
					var next = Math.max(480, Math.min(1280, Math.round(width * dpr * 1.15)))
					if (next === controller.maxWidthHint) return
					controller.maxWidthHint = next
					controller.scheduleMaxWidthRefresh()
				}
				update()
				var observer = null
				if (typeof ResizeObserver !== 'undefined') {
					try { observer = new ResizeObserver(update); observer.observe(root) } catch (e) { observer = null }
				}
				return function () { if (observer) { try { observer.disconnect() } catch (e) {} } }
			}, [visible, controller])

			React.useEffect(function () {
				controller.setVisible(visible && !document.hidden)
			}, [visible, controller])

			// Minimizing the DSH window (or hiding it) must stop the screencast:
			// there is nothing to look at, and continuous capture is the bulk of
			// the CPU cost. Coming back restores the watch and stream.
			React.useEffect(function () {
				var onVisibility = function () { controller.setVisible(!!visibleRef.current && !document.hidden) }
				document.addEventListener('visibilitychange', onVisibility)
				return function () { document.removeEventListener('visibilitychange', onVisibility) }
			}, [controller])

			// Reattach the size observer when the panel becomes visible or the shown
			// tab changes; a hidden panel must not keep reporting sizes.
			React.useEffect(function () {
				if (!visible) sizeSync.attach(null)
				else sizeSync.attach(imgRef.current || videoRef.current)
			}, [visible, sizeSync, state.currentTargetId, state.streamGeneration])

			React.useEffect(function () {
				return function () { sizeSync.dispose() }
			}, [sizeSync])

			// Attach the live <img> to the controller whenever the target changes
			React.useEffect(function () {
				if (imgRef.current && state.currentTargetId != null) {
					controller.setLiveImg(imgRef.current, state.currentTargetId)
				}
				if (videoRef.current && state.currentTargetId != null) controller.setLiveVideo(videoRef.current, state.currentTargetId)
			}, [state.currentTargetId, state.backend, state.streamGeneration, state.streamState, controller])

			// Native wheel listener (React onWheel is passive, can't preventDefault)
			React.useEffect(function () {
				var img = imgRef.current || videoRef.current
				if (!img) return
				var handler = function (e) { controller.handleWheel(e) }
				img.addEventListener('wheel', handler, { passive: false })
				return function () { img.removeEventListener('wheel', handler) }
			}, [controller, state.currentTargetId, state.backend, state.streamGeneration])

			var h = React.createElement

			// Header
			var header = h('div', { className: 'dsh-ego-side-head' },
				h('span', { className: 'dsh-ego-side-title' },
					h('span', { dangerouslySetInnerHTML: { __html: ICON_AGENT_BROWSER } }),
					h('span', { style: { marginLeft: '5px' } }, state.busy ? wt('titleLive') : wt('title'))
				),
				h('button', {
					className: 'dsh-ego-side-iconbtn' + (state.busy ? ' spinning' : ''),
					title: wt('refresh'),
					onClick: function () {
						controller.refresh()
					},
				}, h('span', { dangerouslySetInnerHTML: { __html: ICON_REFRESH } })),
				h('button', {
					className: 'dsh-ego-side-iconbtn' + (state.historyOpen ? '' : ' off'),
					title: state.historyOpen ? wt('historyHide') : wt('historyShow'),
					onClick: function () { controller.toggleHistory() },
				}, h('span', { dangerouslySetInnerHTML: { __html: ICON_CLOCK } }))
			)

			// History overlay: covers the body area
			if (state.historyOpen) {
				var sorted = state.spaces.slice().sort(function (a, b) { return (a.lastActive || 0) - (b.lastActive || 0) })
				return h('div', { className: 'dsh-ego-side-root' },
					header,
					h('div', { className: 'dsh-ego-side-history' },
						h('div', { className: 'dsh-ego-side-historyhead' },
							h('span', { dangerouslySetInnerHTML: { __html: ICON_CLOCK } }),
							' ' + wt('history')
						),
						h('div', { className: 'dsh-ego-side-historylist' },
							sorted.length === 0
								? h('div', { className: 'dsh-ego-side-hnone' }, wt('noHistory'))
								: sorted.map(function (s) {
									return h('div', {
										key: s.targetId,
										className: 'dsh-ego-side-hitem' + (s.targetId === state.currentTargetId ? ' active' : ''),
										onClick: function () { controller.pinTo(s); controller.toggleHistory() },
									},
										s.thumbnail
											? h('img', { className: 'dsh-ego-side-hthumb', src: s.thumbnail, alt: '' })
											: h('div', { className: 'dsh-ego-side-hthumb' }),
										h('div', { className: 'dsh-ego-side-hinfo' },
											h('div', { className: 'dsh-ego-side-htitle' }, s.title || s.url || wt('newTab')),
											h('div', { className: 'dsh-ego-side-hurl' }, s.url || '(about:blank)'),
											s.targetId === state.currentTargetId ? h('div', { className: 'dsh-ego-side-hactive' }, '● ' + wt('current')) : null
										)
									)
								})
						)
					)
				)
			}

			// Guide strips
			var guides = []
			if (state.showLoginGuide) {
				guides.push(h(EgoLoginGuide, { key: 'login', controller: controller }))
			}
			if (state.captchaKind) {
				guides.push(h(EgoCaptchaGuide, { key: 'captcha', kind: state.captchaKind, controller: controller }))
			}

			// Tab strip
			var tabsEl = state.spaces.length > 0
				? h('div', { className: 'dsh-ego-side-tabs' },
					state.spaces.map(function (s) {
						var isActive = s.targetId === state.selectedTabId || (state.selectedTabId === null && s.targetId === state.currentTargetId)
						return h('div', {
							key: s.targetId,
							className: 'dsh-ego-side-tab' + (isActive ? ' active' : ''),
							title: s.url || '',
							onClick: function () { controller.selectTab(s.targetId) },
						},
							h('span', { className: 'dsh-ego-side-tabdot' }),
							h('span', { className: 'dsh-ego-side-tabtxt' }, s.title || s.url || wt('newTab')),
							h('span', {
								className: 'dsh-ego-side-tabclose',
								title: wt('closeTab'),
								onClick: function (e) { e.stopPropagation(); controller.closeTab(s.targetId) },
							}, '×')
						)
					})
				)
				: null

			// Main live view
			var body
			var currentSpace = state.currentSpace
			if (!currentSpace) {
				body = h('div', { className: 'dsh-ego-side-body' },
					h('div', { className: 'dsh-ego-side-empty' },
						h('div', null, state.relayDisabled ? wt('relayDisabledTitle') : wt('noActivePages')),
						h('div', { style: { fontSize: '11px' } }, state.relayDisabled ? wt('relayDisabledBody') : wt('noActiveHint'))
					)
				)
			} else {
				var liveImg = state.backend === 'ffmpeg'
					? h('video', {
						ref: bindLiveVideo, key: 'livevideo-' + state.streamGeneration, className: 'dsh-ego-side-liveimg', muted: true, autoPlay: true, playsInline: true,
						onPointerDown: function (e) { controller.handlePointerDown(e) }, onPointerMove: function (e) { controller.handlePointerMove(e) }, onPointerUp: function (e) { controller.handlePointerUp(e) }, onPointerCancel: function (e) { controller.handlePointerUp(e) }, onDoubleClick: function (e) { controller.handleDoubleClick(e) },
					})
					: currentSpace.thumbnail
					? h('div', { className: 'dsh-ego-side-livebox' },
						h('img', {
							ref: bindLiveImg,
							key: 'liveimg',
							className: 'dsh-ego-side-liveimg dsh-ego-side-liveimg-semantic',
							src: currentSpace.thumbnail,
							alt: 'live',
							draggable: false,
							decoding: 'async',
							onPointerDown: function (e) { controller.handlePointerDown(e) },
							onPointerMove: function (e) { controller.handlePointerMove(e) },
							onPointerUp: function (e) { controller.handlePointerUp(e) },
							onPointerCancel: function (e) { controller.handlePointerUp(e) },
							onDoubleClick: function (e) { controller.handleDoubleClick(e) },
						}),
						h('img', { ref: bindLiveBufA.current, key: 'livebuf-a', className: 'dsh-ego-side-liveimg dsh-ego-side-livebuf', alt: '', draggable: false, decoding: 'async' }),
						h('img', { ref: bindLiveBufB.current, key: 'livebuf-b', className: 'dsh-ego-side-liveimg dsh-ego-side-livebuf', alt: '', draggable: false, decoding: 'async' }),
					)
					: h('div', { className: 'dsh-ego-side-liveurl' }, state.streamMessage || wt('noScreenshot'))

				body = h('div', { className: 'dsh-ego-side-body' },
					h('div', { className: 'dsh-ego-side-liveview' },
						h('div', { className: 'dsh-ego-side-livebadge' },
							h('div', { className: 'dsh-ego-side-badgeline' },
								h('span', { className: 'dsh-ego-side-state-dot' + (state.pinned ? ' pin' : state.busy ? ' busy' : '') }),
								h('span', {
									className: 'dsh-ego-side-badgestatus',
									title: residentInfo ? ('executor: ' + (residentInfo.mode || '') + (residentInfo.pid ? ' pid=' + residentInfo.pid : '') + ' · ' + (residentInfo.parkReason || residentInfo.lastRebuildReason || '')) : undefined,
								},
									(state.backend === 'ffmpeg' ? 'FFmpeg · H.264' : 'CDP') + ' · ' + (state.streamState === 'failed' ? (state.streamMessage || wt('failed')) : state.streamState) + (state.currentTargetId ? (state.wiringStale ? ' · ' + wt('stale') : ' · ' + wt('captured')) : '')
									+ (residentInfo ? ' · ' + (residentInfo.mode === 'resident' ? wt('executorResident') + (residentInfo.ageMs ? ' ' + Math.round(residentInfo.ageMs / 60000) + 'm' : '') : residentInfo.parked ? wt('executorParked') : residentInfo.mode === 'starting' ? wt('executorStarting') : wt('executorOneShot')) : ''),
								),
								h('span', { style: { flex: 1 } }),
								state.pinned
									? h('button', {
										className: 'dsh-ego-side-back', type: 'button',
										onClick: function () { controller.unpin() },
									}, wt('backToLive'))
									: null,
								h('button', {
									className: 'dsh-ego-side-back', type: 'button',
									title: wt('openExternal'),
									onClick: function () {
										var url = currentSpace.url
										if (url && !url.startsWith('about:') && !url.startsWith('chrome://')) window.open(url, '_blank', 'noopener')
									},
								}, wt('openExternal')),
								// Raise the real agent window (issue #51): headless
								// instances get replaced by a headed one on the same
								// profile; headed ones just pop to the front.
								h('button', {
									className: 'dsh-ego-side-back', type: 'button',
									title: wt('raiseWindowHint'),
									onClick: function () {
										fetch('/api/ego/raise', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
											.then(function (r) { return r.json().catch(function () { return null }) })
											.catch(function () { return null })
									},
								}, wt('raiseWindow')),
								// Size-sync toggle: unlocked, dragging the panel or the
								// stage edges resizes the REAL browser window.
								h('button', {
									className: 'dsh-ego-side-back' + (sizeSyncOn ? ' dsh-ego-side-back-on' : ''), type: 'button',
									title: wt('sizeSyncHint'),
									onClick: function () {
										var next = !sizeSyncOn
										setSizeSyncOn(next)
										sizeSync.setEnabled(next)
										if (next) sizeSync.attach(imgRef.current || videoRef.current)
									},
								}, sizeSyncOn ? wt('sizeSyncOn') : wt('sizeSyncOff')),
								// Aspect presets: a fixed-ratio resize of the real window.
								h('button', {
									className: 'dsh-ego-side-back' + (presetOpen ? ' dsh-ego-side-back-on' : ''), type: 'button',
									title: wt('sizePresetsHint'),
									onClick: function () { setPresetOpen(!presetOpen) },
								}, wt('sizePresets')),
								presetOpen
									? h('div', { className: 'dsh-ego-side-presets', ref: presetRef },
										PRESETS.map(function (preset) {
											return h('button', {
												key: preset.label, type: 'button', className: 'dsh-ego-side-preset-item',
												onClick: function () { applyPreset(preset.ratio) },
											}, preset.label)
										})
									)
									: null
							),
							// Page info lives in this header now, not under the frame:
							// title first, then the URL (or the transient zoom hint).
							h('div', { className: 'dsh-ego-side-pageinfo' },
								h('span', { className: 'dsh-ego-side-livetitle', title: currentSpace.title || currentSpace.url || '' }, currentSpace.title || currentSpace.url || wt('newTab')),
								h('span', { className: 'dsh-ego-side-liveurl' + ((state.zoomHint || sizeNotice) ? ' dsh-ego-side-hint' : '') }, sizeNotice || state.zoomHint || currentSpace.url || '')
							)
						),
						h('div', { className: 'dsh-ego-side-stage' + (sizeSyncOn ? ' dsh-ego-size-unlocked' : '') },
							liveImg,
							h('div', { className: 'dsh-ego-side-resize dsh-ego-side-resize-right', title: wt('resizeHint'), onPointerDown: beginResize('x') }),
							h('div', { className: 'dsh-ego-side-resize dsh-ego-side-resize-bottom', title: wt('resizeHint'), onPointerDown: beginResize('y') }),
							h('div', { className: 'dsh-ego-side-resize dsh-ego-side-resize-corner', title: wt('resizeHint'), onPointerDown: beginResize('xy') })
						)
					)
				)
			}

			return h('div', { className: 'dsh-ego-side-root', ref: rootRef }, header, guides, tabsEl, body)
		}

		function EgoLoginGuide(props) {
			var controller = props.controller
			var h = React.createElement
			var noteState = React.useState('')
			var note = noteState[0], setNote = noteState[1]
			var savingState = React.useState(false)
			var saving = savingState[0], setSaving = savingState[1]
			return h('div', { className: 'dsh-ego-side-login' },
				h('span', { className: 'dsh-ego-side-login-txt' },
					wt('loginTitle')
				),
				h('button', {
					className: 'dsh-ego-side-login-btn' + (saving ? ' saving' : ''),
					type: 'button',
					disabled: saving,
					onClick: function () {
						setSaving(true)
						setNote('')
						controller.flushLogin().then(function (j) {
							if (j && j.ok) setNote(wt('loginSaved', { n: j.total || '' }))
							else setNote(j && j.error ? wt('loginNotConnected') : wt('loginFailed'))
						}).catch(function () { setNote(wt('loginFailed')) }).finally(function () { setSaving(false) })
					},
				}, saving ? wt('loginSaving') : wt('loginBtn')),
				note ? h('span', { className: 'dsh-ego-side-login-note' }, note) : null,
				h('button', {
					className: 'dsh-ego-side-iconbtn', type: 'button', title: wt('loginDismiss'),
					onClick: function () { controller.dismissGuide('login') },
				}, '×')
			)
		}

		function EgoCaptchaGuide(props) {
			var controller = props.controller
			var kind = props.kind
			var h = React.createElement
			return h('div', { className: 'dsh-ego-side-captcha' },
				h('span', { className: 'dsh-ego-side-captcha-txt' },
					h('b', null, wt('captchaTitle')),
					' — ' + wt('captchaHint')
				),
				h('span', { className: 'dsh-ego-side-captcha-kind' }, kind),
				h('button', {
					className: 'dsh-ego-side-iconbtn', type: 'button', title: wt('captchaDismiss'),
					onClick: function () { controller.dismissGuide('captcha') },
				}, '×')
			)
		}

		// ── startWatchProbe: SSE-driven first-tool-call detector ─────────────
		// Shared by the betterSidebar tab and the native right Sidebar tab.
		// Listens for `tool-call` events on the SSE stream to detect when the
		// agent first calls an ego_* tool, then asks the host to open the watch
		// panel. No polling: the host-side markEgoToolCall() pushes the event
		// into the SSE stream the moment a tool runs.
		//
		// Why "increase beyond baseline" not "0 → >0": toolCallCount is a
		// host-process counter that persists across page reloads. The baseline is
		// fetched ONCE at mount; after that, only a NEW tool call opens the
		// panel. The one-shot guard lives with the caller (per session).
		function startWatchProbe(openWatchTab) {
			var probeDisposed = false
			var baseline = null // null = not yet observed; set on first fetch
			// One-shot baseline fetch (NOT a polling loop). After this, the
			// SSE `tool-call` event is the sole signal.
			void (async function () {
				if (probeDisposed) return
				try {
					var res = await fetch(SPACES_ROUTE, { cache: 'no-store' })
					if (!res.ok) return
					var data = await res.json()
					// The host marks the payload when the frame relay is off; the
					// probe must not hold a push channel in that case.
					if (data && data.frameRelay === false) { frameRelaySet(true); closeProbeSse() }
					if (data && typeof data.toolCallCount === 'number') {
						baseline = data.toolCallCount
					}
				} catch (e) {}
			})()
			// Listen for tool-call events on the shared SSE stream. The probe
			// opens its OWN EventSource so it works even before the panel is
			// mounted. While the frame relay is disabled there is no push
			// channel at all, so the probe stays CLOSED rather than opening a
			// stream the host refuses to serve.
			var probeSse = null
			var openProbeSse = function () {
				if (probeDisposed || probeSse || frameRelayDisabled) return
				try { probeSse = new EventSource('/api/ego/stream') } catch (e) { probeSse = null; return }
				probeSse.addEventListener('tool-call', onProbeToolCall)
			}
			var closeProbeSse = function () {
				try { if (probeSse) probeSse.close() } catch (e) {}
				probeSse = null
			}
			var onProbeToolCall = function (ev) {
				if (probeDisposed) return
				try {
					var m = JSON.parse(ev.data)
					if (!m || typeof m.count !== 'number') return
					var sid = typeof m.sessionId === 'string' && m.sessionId !== '' ? m.sessionId : undefined
					if (baseline === null) {
						// Event arrived before the baseline fetch resolved —
						// treat this count as the baseline (it's the first
						// we've seen) and open on the NEXT one. But if count
						// is already >0, the agent has called a tool this
						// session, so open now.
						baseline = m.count
						if (m.count > 0) openWatchTab(sid)
						return
					}
					if (m.count > baseline) openWatchTab(sid)
				} catch (e) {}
			}
			openProbeSse()
			// The settings switch can also flip at runtime; mirror it here.
			var offProbeRelay = frameRelaySubscribe(function (disabled) {
				if (disabled) closeProbeSse()
				else openProbeSse()
			})
			return function () {
				probeDisposed = true
				if (offProbeRelay) { try { offProbeRelay() } catch (e) {} }
				closeProbeSse()
			}
		}

		// ── mountSidebarTab: register the ego-browser watch tab ────────────────
		function mountSidebarTab(ctx, betterSidebar) {
			if (!betterSidebar) return function () {}
			// Inject Tab CSS once (cleaned up on dispose)
			var styleEl = document.createElement('style')
			styleEl.textContent = TAB_CSS
			document.head.appendChild(styleEl)

			var disposeTab = betterSidebar.registerTab({
				id: 'ego-browser:watch',
				title: function () { return wt('title') },
				order: 70,
				single: true,
				// No urlTarget: this tab is a live screencast of the AGENT
				// browser, not a renderer for arbitrary URLs. Claiming http(s)
				// links here stole every chat link from the built-in browser
				// tab and dead-ended on the empty state (issue #48).
				component: EgoBrowserTab,
			})

			// Sessions whose sidebar already auto-opened this page load. Keyed PER
			// SESSION: each conversation gets its own one-shot, and the open is scoped to
			// the CALLING session, so a background conversation's tool call opens the Tab
			// in ITS OWN sidebar instead of the one the user is looking at.
			var autoOpened = {}
			var openWatchTab = function (sessionId) {
				var key = sessionId || ''
				if (autoOpened[key] === true) return
				autoOpened[key] = true
				try {
					// The second argument is the session scope; without it the open lands
					// in whatever sidebar is currently on screen.
					betterSidebar.openTab({ type: 'ego-browser:watch' }, sessionId ? { sessionId: sessionId } : undefined)
				} catch (e) {}
			}
			var closeProbe = startWatchProbe(openWatchTab)

			return function () {
				closeProbe()
				disposeTab()
				styleEl.remove()
			}
		}

		// ── mountNativeSidebarTab: register into DSH's own right Sidebar (#64) ─
		// DSH ships @deepseek-ai/dsh-client-ui-sidebar-right as a base package. A
		// tab type registers in two stages: the static type into ctx.sidebarRightTabs,
		// then the body into the keyed `sidebar.right.pane.tab` slot under the same
		// definition id. The body receives the framework's `useTabInfo` hook and any
		// extra props from our inject face (here: the client ctx, which EgoBrowserTab
		// needs to build LivePreviewController).
		var NATIVE_WATCH_ID = 'dsh-ego-browser:watch'
		var NATIVE_WATCH_KIND = 'ego-browser:watch'

		function EgoNativeWatchBody(props) {
			var info = props.useTabInfo()
			var visible = !!(info && info.tab && info.tab.visible)
			return React.createElement(EgoBrowserTab, { visible: visible, ctx: props.ctx })
		}

		// Sidebar guide glyph: the canonical Agent Browser icon (browser window +
		// agent cursor, same geometry as ICON_AGENT_BROWSER above). Self-contained
		// (no import from the host icon set) so the entry can never fail on a host
		// whose primitives package is not resolvable for this row; monochrome via
		// currentColor so it follows the guide's own icon colour like every
		// neighbour. IconProps shape: { size, className }.
		function EgoWatchIcon(props) {
			var size = props && typeof props.size === 'number' ? props.size : 16
			var h = React.createElement
			return h('svg', {
				width: size,
				height: size,
				viewBox: '0 0 16 16',
				fill: 'none',
				xmlns: 'http://www.w3.org/2000/svg',
				className: props && props.className,
				'aria-hidden': 'true',
			},
				// window frame
				h('rect', {
					x: 1.2, y: 2.4, width: 13.6, height: 11.2, rx: 2.4,
					stroke: 'currentColor', strokeWidth: 1.2,
				}),
				// title bar
				h('path', {
					d: 'M1.4 5.9h13.2',
					stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round',
				}),
				// window dots
				h('circle', { cx: 3.7, cy: 4.15, r: 0.6, fill: 'currentColor' }),
				h('circle', { cx: 5.5, cy: 4.15, r: 0.6, fill: 'currentColor' }),
				// the agent's cursor, aimed into the page
				h('path', {
					d: 'M8.2 7.0L12.6 10.6L10.6 10.9L11.7 13.2L10.6 13.8L9.5 11.5L8.0 13.1Z',
					fill: 'currentColor',
				})
			)
		}

		function mountNativeSidebarTab(ctx, sidebar, tabs) {
			if (!sidebar || !tabs) return function () {}
			// Inject Tab CSS once (cleaned up on dispose)
			var styleEl = document.createElement('style')
			styleEl.textContent = TAB_CSS
			document.head.appendChild(styleEl)

			var disposeType = tabs.register({
				id: NATIVE_WATCH_ID,
				kind: NATIVE_WATCH_KIND,
				keepMounted: true,
				priority: 'extension',
				title: function () { return wt('title') },
				guide: [{
					id: 'ego-watch',
					order: 90,
					title: function () { return wt('title') },
					icon: EgoWatchIcon,
				}],
			})

			var disposeBody = ctx.slots.register({
				name: 'sidebar.right.pane.tab',
				key: NATIVE_WATCH_ID,
				inject: function () { return { ctx: ctx } },
			}, EgoNativeWatchBody)

			// Sessions whose native sidebar already auto-opened this page load.
			var autoOpened = {}
			var openWatchTab = function (sessionId) {
				var key = sessionId || ''
				if (autoOpened[key] === true) return
				// Navigation commands act on the mounted seat's session; opening
				// from a background session would throw (or open in the wrong
				// column), so require a match when the mounted session is known.
				var showing
				try {
					var m = sidebar.mounted
					showing = m && typeof m.getSnapshot === 'function' ? m.getSnapshot() : undefined
				} catch (e) { showing = undefined }
				if (sessionId && showing !== undefined && showing !== sessionId) return
				try {
					sidebar.openTab(NATIVE_WATCH_KIND)
					autoOpened[key] = true
				} catch (e) {}
			}
			var closeProbe = startWatchProbe(openWatchTab)

			return function () {
				closeProbe()
				try { disposeBody() } catch (e) {}
				try { disposeType() } catch (e) {}
				styleEl.remove()
			}
		}


		function escapeHtml(s) {
			return String(s).replace(/[&<>"']/g, (c) => ({
				'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
			}[c]))
		}


export const name = 'ego-browser'
export { apply, inject }
