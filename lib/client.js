window.__ModuleLoader__.load({ id: "dsh-ego-browser", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

//#region src/client/index.ts
var React = require("react");
var createSnapshotStore = require("@deepseek-ai/dsh-client-store").createSnapshotStore;
var useSyncExternalStore = React.useSyncExternalStore;
var useRef = React.useRef;
function bindSnapshotSelector(source) {
	var subscribe = function(fn) {
		return source.subscribe(fn);
	};
	var getSnapshot = function() {
		return source.getSnapshot();
	};
	return function useSelector(sel, eq) {
		var snapshot = useSyncExternalStore(subscribe, getSnapshot);
		var prevSnapshotRef = useRef();
		var prevSelectedRef = useRef();
		if (prevSnapshotRef.current !== snapshot) {
			prevSnapshotRef.current = snapshot;
			prevSelectedRef.current = sel(snapshot);
		}
		return prevSelectedRef.current;
	};
}
const inject = [
	"slots",
	"locale",
	"connection"
];
var SETTINGS_NS = "ego-browser";
var en = {
	title: "ego-browser",
	intro: "Agent browser integration. Configure the Chrome/Chromium binary path and cast parameters below.",
	isolateSpaces: "Space isolation",
	isolateSpacesHint: "Disabled: use persistent disk profile, logins stay across restarts. Enabled: memory-only sandbox per task.",
	isolateSpacesOff: "Disabled (persistent profile, keep logins)",
	isolateSpacesOn: "Enabled (isolated memory sandbox)",
	idleTimeoutMin: "Idle auto-stop (minutes)",
	idleTimeoutMinHint: "Stop the backing browser after N minutes without an ego_* call (0 = off). It cold-starts on the next call (~2-4s). Watching the panel does not count as activity.",
	disableFrameRelay: "Disable live frame relay",
	disableFrameRelayHint: "No picture is relayed at all: no ego-cast worker, no CDP/WGC screencast capture, no ffmpeg pull, and the watch panel opens no stream. ego_* tools keep working normally.",
	disableFrameRelayOff: "Off (live view enabled)",
	disableFrameRelayOn: "On (no picture pushed to this page)",
	relayDisabledTitle: "Live frame relay is disabled",
	relayDisabledBody: "Turn off \"Disable live frame relay\" in Settings → Plugins → ego-browser to see the live view here.",
	minUnit: "min",
	loginImportTitle: "Import logins from system browser",
	loginImportIntro: "Copy login cookies from your daily Chrome/Edge/Brave into the agent browser (CDP passthrough — no offline decryption). Probe first, then import with an explicit domain list.",
	loginImportSource: "Source",
	loginImportDomains: "Domains (comma-separated; empty = ALL)",
	loginImportDomainsHint: "e.g. bilibili.com, zhihu.com — subdomains included. Prefer an explicit list over importing everything.",
	loginImportCloseSource: "Close the source browser first if it is running (windows restore on next launch)",
	loginImportProbe: "Probe",
	loginImportRun: "Import",
	loginImportBusy: "Working… (a running source browser may need to close first)",
	loginImportProbeResult: "Importable: {matched} cookies across {domains} domains (read {total} total) — nothing was written.",
	loginImportResult: "Imported {written} cookies across {domains} domains from {source}. They persist across restarts.",
	loginImportClosed: " (source browser was closed and can be reopened)",
	chromePath: "Browser binary path",
	chromePathHint: "Path to the Chrome/Chromium/Edge binary. Empty = auto-detect.",
	captureBackend: "Capture backend",
	streamProfile: "Quality profile",
	cdpFps: "CDP FPS",
	cdpQuality: "CDP JPEG quality",
	cdpMaxWidth: "CDP max width",
	cdpBackstopIntervalMs: "CDP recovery interval",
	ffmpegFps: "FFmpeg FPS",
	ffmpegMaxWidth: "FFmpeg max width",
	ffmpegBitrateKbps: "FFmpeg bitrate",
	ffmpegEncoder: "FFmpeg encoder",
	ffmpegPath: "FFmpeg binary path",
	githubMirror: "GitHub mirror",
	fpsUnit: "fps",
	pxUnit: "px",
	kbpsUnit: "kbps",
	msUnit: "ms",
	ffmpegTitle: "FFmpeg installation",
	ffmpegReady: "Ready",
	ffmpegMissing: "No compatible FFmpeg found",
	ffmpegChecking: "Checking local FFmpeg…",
	ffmpegDownloading: "Downloading FFmpeg…",
	ffmpegVerifying: "Verifying download…",
	ffmpegExtracting: "Extracting FFmpeg…",
	ffmpegProbing: "Checking capture capabilities…",
	ffmpegUnsupported: "FFmpeg capture is unsupported on this platform",
	ffmpegFailed: "FFmpeg installation failed",
	ffmpegSource: "Source",
	ffmpegVersion: "Version",
	ffmpegInstall: "Download FFmpeg",
	ffmpegReinstall: "Reinstall",
	ffmpegRecheck: "Recheck",
	ffmpegRequired: "FFmpeg (install required)",
	githubMirrorHint: "Replaces https://github.com for GitHub downloads, for example https://gh-proxy.com/github.com.",
	egoCliArgs: "Extra ego-browser CLI args",
	egoCliArgsHint: "Appended to `ego-browser nodejs` argv. Takes effect on the next ego_* call. Blocked: --status/--stop/--open/--spaces/--help (they exit before the heredoc runs). Use --headless via the headless env instead.",
	chromeArgs: "Extra Chrome launch args",
	chromeArgsHint: "Appended to the Chrome launch argv. Takes effect on the next browser cold start (the browser is a singleton — run `ego-browser --stop` or restart DSH to relaunch). Blocked: --user-data-dir/--remote-debugging-port/--remote-allow-origins/--headless/--no-startup-window/--proxy-server (use EGO_LINUX_PROXY for the proxy).",
	save: "Save",
	saving: "Saving…",
	discard: "Discard",
	unsaved: "Unsaved",
	readOnly: "Settings are read-only in this deployment.",
	namespaceUnavailable: "The ego-browser configuration channel is unavailable. Please retry later.",
	retry: "Retry",
	expand: "Show settings",
	collapse: "Hide settings"
};
var zh = {
	title: "ego-browser",
	intro: "Agent 浏览器集成。在下方配置 Chrome/Chromium 浏览器路径及推流参数。",
	isolateSpaces: "任务空间沙盒隔离",
	isolateSpacesHint: "默认关闭：使用磁盘持久化 Profile，任务中登录的账号跨电脑重启永久保留；开启后使用内存临时沙盒隔离，任务结束不落盘。",
	isolateSpacesOff: "关闭（持久化登录态，跨电脑重启不丢失）",
	isolateSpacesOn: "开启（严格沙盒隔离，任务结束不落盘）",
	idleTimeoutMin: "空闲自动回收（分钟）",
	idleTimeoutMinHint: "N 分钟没有任何 ego_* 调用后自动关闭后台浏览器进程（0 = 关闭）。下次调用自动冷启动（约 2-4 秒）。观看观察窗不算活动。",
	disableFrameRelay: "禁用画面回传",
	disableFrameRelayHint: "完全不回传画面：不启动 ego-cast worker，不做 CDP/WGC 屏幕采集与 ffmpeg 拉流，观察窗不再建立任何拉流连接。ego_* 工具本身照常可用。",
	disableFrameRelayOff: "关闭（保留实时画面）",
	disableFrameRelayOn: "开启（不回传任何画面）",
	relayDisabledTitle: "画面回传已禁用",
	relayDisabledBody: "在「设置 → 插件 → ego-browser」中关闭「禁用画面回传」后，这里才会显示实时画面。",
	minUnit: "分钟",
	loginImportTitle: "从系统浏览器导入登录态",
	loginImportIntro: "把你日常 Chrome/Edge/Brave 里的登录 cookie 复制进 agent 浏览器（CDP 透传，不做离线解密）。建议先「探测」看可导入项，再按域名导入。",
	loginImportSource: "来源",
	loginImportDomains: "域名（逗号分隔，留空 = 全部）",
	loginImportDomainsHint: "例如 bilibili.com, zhihu.com — 含子域名。建议明确列出，不要全量导入。",
	loginImportCloseSource: "源浏览器运行中则先优雅关闭（窗口下次启动可恢复）",
	loginImportProbe: "探测",
	loginImportRun: "导入",
	loginImportBusy: "正在处理…（运行中的源浏览器可能需要先关闭）",
	loginImportProbeResult: "可导入 {matched} 条 cookie（{domains} 个域名，共读取 {total} 条）——尚未写入。",
	loginImportResult: "已从{source}导入 {written} 条 cookie（{domains} 个域名），跨重启保留。",
	loginImportClosed: "（源浏览器已关闭，可重新打开）",
	chromePath: "浏览器路径",
	chromePathHint: "Chrome/Chromium/Edge 可执行文件路径。留空 = 自动检测。",
	captureBackend: "捕获后端",
	streamProfile: "画质档位",
	cdpFps: "CDP 帧率",
	cdpQuality: "CDP JPEG 质量",
	cdpMaxWidth: "CDP 最大宽度",
	cdpBackstopIntervalMs: "CDP 恢复截图间隔",
	ffmpegFps: "FFmpeg 帧率",
	ffmpegMaxWidth: "FFmpeg 最大宽度",
	ffmpegBitrateKbps: "FFmpeg 码率",
	ffmpegEncoder: "FFmpeg 编码器",
	ffmpegPath: "FFmpeg 路径",
	githubMirror: "GitHub 镜像源",
	fpsUnit: "fps",
	pxUnit: "px",
	kbpsUnit: "kbps",
	msUnit: "ms",
	ffmpegTitle: "FFmpeg 安装",
	ffmpegReady: "已就绪",
	ffmpegMissing: "未找到兼容的 FFmpeg",
	ffmpegChecking: "正在检测本机 FFmpeg…",
	ffmpegDownloading: "正在下载 FFmpeg…",
	ffmpegVerifying: "正在校验下载文件…",
	ffmpegExtracting: "正在解压 FFmpeg…",
	ffmpegProbing: "正在检查捕获能力…",
	ffmpegUnsupported: "当前平台不支持 FFmpeg 捕获",
	ffmpegFailed: "FFmpeg 安装失败",
	ffmpegSource: "来源",
	ffmpegVersion: "版本",
	ffmpegInstall: "下载 FFmpeg",
	ffmpegReinstall: "重新下载",
	ffmpegRecheck: "重新检测",
	ffmpegRequired: "FFmpeg（需要安装）",
	githubMirrorHint: "替换 https://github.com，例如 https://gh-proxy.com/github.com。",
	egoCliArgs: "ego-browser CLI 附加参数",
	egoCliArgsHint: "追加到 `ego-browser nodejs` argv。下一次 ego_* 工具调用即生效。禁止：--status/--stop/--open/--spaces/--help（会在 heredoc 执行前退出）。--headless 请走 headless 环境变量。",
	chromeArgs: "Chrome 启动附加参数",
	chromeArgsHint: "追加到 Chrome 启动 argv。仅在浏览器下次冷启动时生效（浏览器是单例常驻——需运行 `ego-browser --stop` 或重启 DSH 才会重新启动）。禁止：--user-data-dir/--remote-debugging-port/--remote-allow-origins/--headless/--no-startup-window/--proxy-server（代理请用 EGO_LINUX_PROXY）。",
	save: "保存",
	saving: "保存中…",
	discard: "放弃",
	unsaved: "未保存",
	readOnly: "当前部署下设置只读。",
	namespaceUnavailable: "ego-browser 配置通道不可用，请稍后重试。",
	retry: "重试",
	expand: "展开设置",
	collapse: "收起设置"
};
var _egoLocale = (function() {
	try {
		return (navigator.language || "").startsWith("zh") ? "zh" : "en";
	} catch {
		return "en";
	}
})();
var watchEn = {
	title: "Agent Browser",
	titleLive: "Agent Browser · Live",
	liveView: "Live view",
	pinned: "Pinned",
	realtime: "Live",
	noScreenshot: "(no screenshot — about:blank or browser not rendering)",
	noActivePages: "No active browser pages",
	noActiveHint: "Pages will appear here as the agent browses with ego_*",
	openExternal: "Open real page",
	raiseWindow: "Pop out window",
	raiseWindowHint: "Raise the agent browser as a real window (a headless instance is replaced by a visible one on the same profile)",
	noUrl: "No URL to open",
	closeTab: "Close tab",
	newTab: "(new tab)",
	history: "Browsing history",
	historyHide: "Hide history",
	historyShow: "Show history",
	noHistory: "No browsing history",
	current: "current",
	refresh: "Refresh",
	backToLive: "← Back to live",
	dragHint: "Drag to move panel",
	loginTitle: "Log in via the ego-lite agent browser window on your desktop",
	loginBtn: "Logged in, save",
	loginSaving: "Saving…",
	loginSaved: "Saved {n} sessions",
	loginNotConnected: "Browser not connected",
	loginFailed: "Save failed",
	loginDismiss: "Dismiss",
	captchaTitle: "⚠️ CAPTCHA detected",
	captchaHint: "Complete verification in the ego-lite agent browser window; the agent will continue.",
	captchaDismiss: "Dismiss",
	hintReset: "Reset · scroll to pan · Ctrl+scroll to zoom · double-click to reset",
	hintPan: "Ctrl+scroll to zoom · Ctrl+drag to pan · double-click to reset",
	hintScroll: "Ctrl+drag to pan · scroll to pan",
	hintNotCaptured: "Not captured · operation not delivered · click again to recover",
	failed: "failed",
	stale: "⚠ Not captured",
	captured: "Captured",
	fabTitle: "Agent Browser live view",
	settingsTitle: "Show settings",
	settingsHide: "Hide settings",
	relayDisabledTitle: "Live frame relay is disabled",
	relayDisabledBody: "Turn off “Disable live frame relay” in Settings → Plugins → ego-browser to see the live view here. No stream is opened meanwhile."
};
var watchDict = {
	en: watchEn,
	zh: {
		title: "Agent 浏览器",
		titleLive: "Agent 浏览器 · 实时",
		liveView: "只读观察窗",
		pinned: "已固定查看",
		realtime: "正在实时浏览",
		noScreenshot: "（暂无截图 — about:blank 或浏览器未渲染）",
		noActivePages: "暂无活跃浏览器页",
		noActiveHint: "当 agent 开始用 ego_* 操作网页时，这里会实时显示",
		openExternal: "⧉ 打开真实页",
		raiseWindow: "弹出窗口",
		raiseWindowHint: "把 agent 浏览器弹出为真实窗口（无头实例会被同 Profile 的有头实例替换，标签页保留）",
		noUrl: "无可打开的地址",
		closeTab: "关闭标签",
		newTab: "(新标签页)",
		history: "历史浏览轨迹",
		historyHide: "收起历史轨迹",
		historyShow: "历史浏览轨迹",
		noHistory: "暂无浏览记录",
		current: "当前",
		refresh: "刷新",
		backToLive: "← 返回实时",
		dragHint: "拖动移动面板",
		loginTitle: "需要账号登录时，请到桌面上那个 「ego lite — agent」 Chrome 窗口完成登录。",
		loginBtn: "已登录，保存",
		loginSaving: "保存中…",
		loginSaved: "已保存 {n} 条会话",
		loginNotConnected: "未连接浏览器",
		loginFailed: "保存失败",
		loginDismiss: "关闭提示",
		captchaTitle: "⚠️ 检测到人机验证",
		captchaHint: "请在桌面那个 「ego lite — agent」 浏览器窗口手动完成验证，agent 会继续。",
		captchaDismiss: "关闭提示",
		hintReset: "已复位 · 滚轮滚动页面 · Ctrl+滚轮缩放 · 双击复位",
		hintPan: "Ctrl+滚轮缩放 · Ctrl+拖动平移 · 双击复位",
		hintScroll: "Ctrl+拖动平移 · 滚轮滚动页面",
		hintNotCaptured: "画面未接管 · 本次操作未送达 · 再点一次即可恢复",
		failed: "失败",
		stale: "⚠ 未接管",
		captured: "已接管",
		fabTitle: "Agent 浏览器实时视图",
		settingsTitle: "展开设置",
		settingsHide: "收起设置",
		relayDisabledTitle: "画面回传已禁用",
		relayDisabledBody: "在「设置 → 插件 → ego-browser」中关闭「禁用画面回传」后，这里才会显示实时画面。禁用期间不会建立任何拉流连接。"
	}
};
function wt(key, params = void 0) {
	var text = (watchDict[_egoLocale] || watchEn)[key] || watchEn[key] || key;
	if (params) for (var k in params) text = text.replace(new RegExp("{" + k + "}", "g"), String(params[k]));
	return text;
}
var frameRelayDisabled = false;
var frameRelayListeners = [];
function frameRelaySet(disabled) {
	disabled = disabled === true;
	if (disabled === frameRelayDisabled) return;
	frameRelayDisabled = disabled;
	for (var i = 0; i < frameRelayListeners.length; i++) try {
		frameRelayListeners[i](disabled);
	} catch (e) {}
}
function frameRelaySubscribe(cb) {
	frameRelayListeners.push(cb);
	return function() {
		var i = frameRelayListeners.indexOf(cb);
		if (i >= 0) frameRelayListeners.splice(i, 1);
	};
}
function frameRelayOff(status) {
	if (!status || typeof status !== "object" || status.frameRelay !== false) return false;
	frameRelaySet(true);
	return true;
}
function initialSettingsState() {
	return {
		status: "idle",
		available: false,
		writable: false,
		draft: {
			isolateSpaces: false,
			disableFrameRelay: false,
			idleTimeoutMin: "0",
			chromePath: "",
			captureBackend: "auto",
			streamProfile: "balanced",
			cdpFps: "20",
			cdpQuality: "55",
			cdpMaxWidth: "960",
			cdpBackstopIntervalMs: "3000",
			ffmpegFps: "20",
			ffmpegMaxWidth: "1280",
			ffmpegBitrateKbps: "4000",
			ffmpegEncoder: "auto",
			ffmpegPath: "",
			githubMirror: "",
			egoCliArgs: "",
			chromeArgs: ""
		},
		ffmpegStatus: {
			state: "checking",
			canDownload: false,
			canSelectFfmpeg: false
		},
		dirty: false,
		applyState: { kind: "idle" },
		errorMessage: void 0,
		_open: false
	};
}
function EgoBrowserSettingsController() {
	this.store = createSnapshotStore(initialSettingsState());
	this.loaded = false;
	this.generation = 0;
	this.staged = /* @__PURE__ */ new Map();
	this.ffmpegTimer = null;
	this.load();
}
EgoBrowserSettingsController.prototype.load = function() {
	var self = this;
	var gen = ++this.generation;
	this.store.update(function(s) {
		s.status = "loading";
	});
	fetch("/ego/api/get", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}"
	}).then(function(res) {
		if (!res.ok) return null;
		return res.json().catch(function() {
			return null;
		});
	}).then(function(parsed) {
		if (gen !== self.generation) return;
		if (!parsed || parsed.ok !== true || !parsed.value) {
			self.store.update(function(s) {
				s.status = "ready";
				s.available = false;
				s.writable = false;
			});
			return;
		}
		var config = parsed.value.config || {};
		var ffmpegStatus = parsed.value.ffmpegStatus || {
			state: "missing",
			canDownload: false,
			canSelectFfmpeg: false
		};
		self.loaded = true;
		frameRelaySet(config.disableFrameRelay);
		self.staged.clear();
		self.store.update(function(s) {
			s.status = "ready";
			s.available = true;
			s.writable = true;
			s.draft = {
				isolateSpaces: config.isolateSpaces === true || config.isolateSpaces === "true" || config.isolateSpaces === 1 || config.isolateSpaces === "1",
				idleTimeoutMin: String(config.idleTimeoutMin ?? 0),
				disableFrameRelay: config.disableFrameRelay === true || config.disableFrameRelay === "true" || config.disableFrameRelay === 1 || config.disableFrameRelay === "1",
				chromePath: config.chromePath || "",
				captureBackend: config.captureBackend === "ffmpeg" && !ffmpegStatus.canSelectFfmpeg ? "cdp" : config.captureBackend || "auto",
				streamProfile: config.streamProfile || "balanced",
				cdpFps: String(config.cdpFps ?? 20),
				cdpQuality: String(config.cdpQuality ?? 55),
				cdpMaxWidth: String(config.cdpMaxWidth ?? 960),
				cdpBackstopIntervalMs: String(config.cdpBackstopIntervalMs ?? 3e3),
				ffmpegFps: String(config.ffmpegFps ?? 20),
				ffmpegMaxWidth: String(config.ffmpegMaxWidth ?? 1280),
				ffmpegBitrateKbps: String(config.ffmpegBitrateKbps ?? 4e3),
				ffmpegEncoder: config.ffmpegEncoder || "auto",
				ffmpegPath: config.ffmpegPath || "",
				githubMirror: config.githubMirror || "",
				egoCliArgs: config.egoCliArgs || "",
				chromeArgs: config.chromeArgs || ""
			};
			s.ffmpegStatus = ffmpegStatus;
			s.dirty = false;
			s.applyState = { kind: "idle" };
		});
		if (isFfmpegBusy(ffmpegStatus.state)) self._scheduleFfmpegPoll();
	}).catch(function() {
		if (gen !== self.generation) return;
		self.store.update(function(s) {
			s.status = "ready";
			s.available = false;
			s.writable = false;
		});
	});
};
EgoBrowserSettingsController.prototype.edit = function(field, text) {
	this.staged.set(field, text);
	var patch = {};
	patch[field] = text;
	this.store.update(function(s) {
		s.draft = Object.assign({}, s.draft, patch);
		s.dirty = true;
		s.applyState = { kind: "idle" };
	});
};
EgoBrowserSettingsController.prototype._setFfmpegStatus = function(status) {
	var self = this;
	if (!status) return;
	this.store.update(function(s) {
		s.ffmpegStatus = status;
		if (!status.canSelectFfmpeg && s.draft.captureBackend === "ffmpeg") s.draft = Object.assign({}, s.draft, { captureBackend: "cdp" });
	});
	if (isFfmpegBusy(status.state)) self._scheduleFfmpegPoll();
};
EgoBrowserSettingsController.prototype._scheduleFfmpegPoll = function() {
	var self = this;
	if (this.ffmpegTimer !== null) return;
	this.ffmpegTimer = setTimeout(function() {
		self.ffmpegTimer = null;
		self._ffmpegRequest("ffmpeg-status");
	}, 700);
};
EgoBrowserSettingsController.prototype._ffmpegRequest = function(method, body) {
	var self = this;
	return fetch("/ego/api/" + method, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body || {})
	}).then(function(res) {
		return res.json().catch(function() {
			return null;
		});
	}).then(function(parsed) {
		if (!parsed || parsed.ok !== true || !parsed.value) throw new Error(parsed && parsed.error ? parsed.error.message : "FFmpeg request failed");
		self._setFfmpegStatus(parsed.value.ffmpegStatus);
		return parsed.value.ffmpegStatus;
	}).catch(function(error) {
		self.store.update(function(s) {
			s.applyState = {
				kind: "error",
				message: error instanceof Error ? error.message : String(error)
			};
		});
	});
};
EgoBrowserSettingsController.prototype.checkFfmpeg = function() {
	this._ffmpegRequest("ffmpeg-check");
};
EgoBrowserSettingsController.prototype.installFfmpeg = function() {
	var self = this;
	var snapshot = this.store.getSnapshot();
	this._ffmpegRequest("ffmpeg-install", { githubMirror: snapshot.draft.githubMirror || "" }).then(function() {
		self._scheduleFfmpegPoll();
	});
};
EgoBrowserSettingsController.prototype.discard = function() {
	if (this.staged.size === 0) {
		this.store.update(function(s) {
			s.applyState = { kind: "idle" };
		});
		return;
	}
	this.staged.clear();
	this.load();
};
EgoBrowserSettingsController.prototype.save = function() {
	this._doSave();
};
EgoBrowserSettingsController.prototype._doSave = function() {
	var self = this;
	var gen = ++this.generation;
	var patch = {};
	var NUMERIC_FIELDS = {
		idleTimeoutMin: {
			min: 0,
			max: 1440,
			def: 0
		},
		cdpFps: {
			min: 5,
			max: 30,
			def: 20
		},
		cdpQuality: {
			min: 1,
			max: 100,
			def: 55
		},
		cdpMaxWidth: {
			min: 320,
			max: 1920,
			def: 960
		},
		cdpBackstopIntervalMs: {
			min: 1e3,
			max: 1e4,
			def: 3e3
		},
		ffmpegFps: {
			min: 5,
			max: 30,
			def: 20
		},
		ffmpegMaxWidth: {
			min: 320,
			max: 1920,
			def: 1280
		},
		ffmpegBitrateKbps: {
			min: 500,
			max: 2e4,
			def: 4e3
		}
	};
	this.staged.forEach(function(v, k) {
		var spec = NUMERIC_FIELDS[k];
		if (spec) {
			var n = parseInt(v, 10);
			if (!Number.isFinite(n)) n = spec.def;
			patch[k] = Math.max(spec.min, Math.min(spec.max, n));
		} else patch[k] = v;
	});
	if (Object.keys(patch).length === 0) {
		this.staged.clear();
		this.store.update(function(s) {
			s.dirty = false;
			s.applyState = { kind: "idle" };
		});
		return;
	}
	this.store.update(function(s) {
		s.applyState = { kind: "saving" };
	});
	fetch("/ego/api/set", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ patch })
	}).then(function(res) {
		return res.json().catch(function() {
			return null;
		});
	}).then(function(parsed) {
		if (gen !== self.generation) return;
		if (!parsed || parsed.ok !== true || !parsed.value) {
			self.store.update(function(s) {
				s.applyState = {
					kind: "error",
					message: parsed && parsed.error ? parsed.error.message : "Save failed"
				};
			});
			return;
		}
		var config = parsed.value.config || {};
		var ffmpegStatus = parsed.value.ffmpegStatus || self.store.getSnapshot().ffmpegStatus;
		frameRelaySet(config.disableFrameRelay);
		self.staged.clear();
		self.store.update(function(s) {
			s.applyState = { kind: "saved" };
			s.draft = {
				isolateSpaces: config.isolateSpaces === true || config.isolateSpaces === "true" || config.isolateSpaces === 1 || config.isolateSpaces === "1",
				idleTimeoutMin: String(config.idleTimeoutMin ?? 0),
				disableFrameRelay: config.disableFrameRelay === true || config.disableFrameRelay === "true" || config.disableFrameRelay === 1 || config.disableFrameRelay === "1",
				chromePath: config.chromePath || "",
				captureBackend: config.captureBackend === "ffmpeg" && ffmpegStatus && !ffmpegStatus.canSelectFfmpeg ? "cdp" : config.captureBackend || "auto",
				streamProfile: config.streamProfile || "balanced",
				cdpFps: String(config.cdpFps ?? 20),
				cdpQuality: String(config.cdpQuality ?? 55),
				cdpMaxWidth: String(config.cdpMaxWidth ?? 960),
				cdpBackstopIntervalMs: String(config.cdpBackstopIntervalMs ?? 3e3),
				ffmpegFps: String(config.ffmpegFps ?? 20),
				ffmpegMaxWidth: String(config.ffmpegMaxWidth ?? 1280),
				ffmpegBitrateKbps: String(config.ffmpegBitrateKbps ?? 4e3),
				ffmpegEncoder: config.ffmpegEncoder || "auto",
				ffmpegPath: config.ffmpegPath || "",
				githubMirror: config.githubMirror || "",
				egoCliArgs: config.egoCliArgs || "",
				chromeArgs: config.chromeArgs || ""
			};
			if (ffmpegStatus) s.ffmpegStatus = ffmpegStatus;
			s.dirty = false;
		});
	}).catch(function(err) {
		if (gen !== self.generation) return;
		self.store.update(function(s) {
			s.applyState = {
				kind: "error",
				message: err instanceof Error ? err.message : String(err)
			};
		});
	});
};
EgoBrowserSettingsController.prototype.toggle = function() {
	this.store.update(function(s) {
		s._open = !s._open;
	});
};
var h = React.createElement;
var SETTINGS_CARD_STYLE_ID = "dsh-ego-card-css";
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
`;
var CHEVRON_SVG = "<svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M6 9l6 6 6-6\"/></svg>";
function SettingsField(props) {
	var id = props.id;
	var label = props.label;
	var hint = props.hint;
	var value = props.value;
	var disabled = props.disabled;
	var onEdit = props.onEdit;
	var numeric = props.numeric;
	var narrow = props.narrow;
	var unit = props.unit;
	var inputEl = props.options ? h("select", {
		id,
		className: "dsh-ego-card__input",
		value,
		disabled,
		onChange: function(e) {
			onEdit(e.target.value);
		}
	}, props.options.map(function(option) {
		var spec = typeof option === "string" ? {
			value: option,
			label: option
		} : option;
		return h("option", {
			key: spec.value,
			value: spec.value,
			disabled: !!spec.disabled
		}, spec.label);
	})) : h("input", {
		id,
		className: "dsh-ego-card__input" + (narrow ? " dsh-ego-card__input--narrow" : ""),
		type: numeric ? "number" : "text",
		...numeric ? {
			inputMode: "numeric",
			min: props.min,
			max: props.max,
			step: props.step
		} : {},
		value,
		disabled,
		placeholder: props.placeholder,
		onChange: function(e) {
			onEdit(e.target.value);
		}
	});
	return h("div", { className: "dsh-ego-card__field" }, h("label", {
		className: "dsh-ego-card__field-label",
		htmlFor: id
	}, label), narrow ? h("div", { className: "dsh-ego-card__field-row" }, inputEl, unit ? h("span", { className: "dsh-ego-card__unit" }, unit) : null) : inputEl, hint ? h("p", { className: "dsh-ego-card__hint" }, hint) : null);
}
function LoginImportBlock(props) {
	var t = props.t;
	var useState = React.useState;
	var _source = useState("auto"), source = _source[0], setSource = _source[1];
	var _domains = useState(""), domains = _domains[0], setDomains = _domains[1];
	var _close = useState(false), closeSource = _close[0], setCloseSource = _close[1];
	var _run = useState(false), running = _run[0], setRunning = _run[1];
	var _res = useState(null), result = _res[0], setResult = _res[1];
	function run(dryRun) {
		setRunning(true);
		setResult(null);
		fetch("/api/ego/login-import", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				source,
				domains: domains.split(",").map(function(s) {
					return s.trim();
				}).filter(Boolean),
				closeSource,
				dryRun
			})
		}).then(function(r) {
			return r.json().catch(function() {
				return null;
			});
		}).then(function(j) {
			setRunning(false);
			setResult(j || {
				ok: false,
				error: "no response"
			});
		}).catch(function(e) {
			setRunning(false);
			setResult({
				ok: false,
				error: String(e)
			});
		});
	}
	var resultText = null;
	var resultOk = false;
	if (result) {
		resultOk = result.ok === true;
		if (resultOk) {
			var domainCount = (result.domains || []).length;
			resultText = (result.dryRun ? t("loginImportProbeResult") : t("loginImportResult")).replace("{matched}", String(result.matched ?? 0)).replace("{written}", String(result.written ?? 0)).replace("{domains}", String(domainCount)).replace("{total}", String(result.totalRead ?? 0)).replace("{source}", String(result.source || "")) + (result.closedSource ? t("loginImportClosed") : "");
		} else resultText = result.error || "failed";
	}
	return h("div", { className: "dsh-ego-card__ffmpeg" }, h("div", { className: "dsh-ego-card__ffmpeg-title" }, t("loginImportTitle")), h("div", { className: "dsh-ego-card__hint" }, t("loginImportIntro")), h("div", { className: "dsh-ego-card__field-row" }, h("select", {
		className: "dsh-ego-card__input dsh-ego-card__input--narrow",
		value: source,
		disabled: running,
		onChange: function(e) {
			setSource(e.target.value);
		}
	}, [
		"auto",
		"chrome",
		"edge",
		"brave"
	].map(function(v) {
		return h("option", {
			key: v,
			value: v
		}, v === "auto" ? t("loginImportSource") + ": auto" : v);
	})), h("input", {
		className: "dsh-ego-card__input",
		type: "text",
		value: domains,
		disabled: running,
		placeholder: t("loginImportDomains"),
		onChange: function(e) {
			setDomains(e.target.value);
		}
	})), h("div", { className: "dsh-ego-card__hint" }, t("loginImportDomainsHint")), h("label", {
		className: "dsh-ego-card__hint",
		style: {
			display: "flex",
			gap: "6px",
			alignItems: "center",
			cursor: "pointer"
		}
	}, h("input", {
		type: "checkbox",
		checked: closeSource,
		disabled: running,
		onChange: function(e) {
			setCloseSource(e.target.checked);
		}
	}), t("loginImportCloseSource")), h("div", { className: "dsh-ego-card__ffmpeg-actions" }, h("button", {
		type: "button",
		className: "dsh-ego-card__btn",
		disabled: running,
		onClick: function() {
			run(true);
		}
	}, t("loginImportProbe")), h("button", {
		type: "button",
		className: "dsh-ego-card__btn dsh-ego-card__btn--primary",
		disabled: running,
		onClick: function() {
			run(false);
		}
	}, t("loginImportRun"))), running ? h("div", {
		className: "dsh-ego-card__ffmpeg-status",
		role: "status"
	}, t("loginImportBusy")) : null, resultText ? h("div", {
		className: resultOk ? "dsh-ego-card__saved" : "dsh-ego-card__failed",
		role: "status"
	}, resultText) : null);
}
function EgoBrowserCard(props) {
	var t = props.t;
	var controller = props.controller;
	var useSnapshot = props.useSnapshot;
	var state = useSnapshot(function(s) {
		return s;
	});
	if (state.status === "idle") controller.load();
	var degraded = state.status === "ready" && !state.available;
	var open = state._open || degraded;
	var applyState = state.applyState || { kind: "idle" };
	var saving = applyState.kind === "saving";
	var saved = applyState.kind === "saved";
	var errorText = applyState.kind === "error" ? applyState.message : void 0;
	var header = h("button", {
		type: "button",
		className: "dsh-ego-card__header",
		"aria-expanded": open,
		"aria-label": t(open ? "collapse" : "expand") + ": " + t("title"),
		onClick: function() {
			if (!degraded) controller.toggle();
		}
	}, h("span", { className: "dsh-ego-card__head-text" }, h("span", { className: "dsh-ego-card__name" }, t("title")), h("span", { className: "dsh-ego-card__desc" }, t("intro"))), state.dirty ? h("span", { className: "dsh-ego-card__pending" }, t("unsaved")) : null, h("span", {
		className: "dsh-ego-card__chevron" + (open ? " dsh-ego-card__chevron--open" : ""),
		dangerouslySetInnerHTML: { __html: CHEVRON_SVG }
	}));
	var body = null;
	if (!open) body = null;
	else if (!state.available) body = h("div", { className: "dsh-ego-card__body" }, h("p", {
		className: "dsh-ego-card__notice",
		role: "status"
	}, t("namespaceUnavailable")), h("div", { className: "dsh-ego-card__footer" }, h("button", {
		type: "button",
		className: "dsh-ego-card__btn",
		onClick: function() {
			controller.load();
		}
	}, t("retry"))));
	else {
		var busy = !state.writable || saving;
		var ffmpegStatus = state.ffmpegStatus || {
			state: "checking",
			canDownload: false,
			canSelectFfmpeg: false
		};
		var ffmpegBusy = isFfmpegBusy(ffmpegStatus.state);
		var ffmpegLabelKey = ffmpegStatus.state === "ready" ? "ffmpegReady" : ffmpegStatus.state === "checking" ? "ffmpegChecking" : ffmpegStatus.state === "downloading" ? "ffmpegDownloading" : ffmpegStatus.state === "verifying" ? "ffmpegVerifying" : ffmpegStatus.state === "extracting" ? "ffmpegExtracting" : ffmpegStatus.state === "probing" ? "ffmpegProbing" : ffmpegStatus.state === "unsupported" ? "ffmpegUnsupported" : ffmpegStatus.state === "failed" ? "ffmpegFailed" : "ffmpegMissing";
		var progress = ffmpegStatus.progress;
		var progressText = progress ? formatBytes(progress.receivedBytes || 0) + (progress.totalBytes ? " / " + formatBytes(progress.totalBytes) : "") + (progress.percent !== null && progress.percent !== void 0 ? " (" + progress.percent + "%)" : "") : "";
		var saveDisabled = !state.dirty || saving || !state.writable;
		var discardDisabled = !state.dirty || saving;
		body = h("div", { className: "dsh-ego-card__body" }, !state.writable ? h("p", {
			className: "dsh-ego-card__notice",
			role: "status"
		}, t("readOnly")) : null, saved ? h("p", {
			className: "dsh-ego-card__saved",
			role: "status"
		}, t("save")) : null, h("div", { className: "dsh-ego-card__form" }, h(SettingsField, {
			id: "plugin-config-ego-browser-isolatespaces",
			label: t("isolateSpaces"),
			hint: t("isolateSpacesHint"),
			value: state.draft.isolateSpaces ? "true" : "false",
			options: [{
				value: "false",
				label: t("isolateSpacesOff")
			}, {
				value: "true",
				label: t("isolateSpacesOn")
			}],
			disabled: busy,
			onEdit: function(v) {
				controller.edit("isolateSpaces", v === "true");
			}
		}), h(SettingsField, {
			id: "plugin-config-ego-browser-disableframerelay",
			label: t("disableFrameRelay"),
			hint: t("disableFrameRelayHint"),
			value: state.draft.disableFrameRelay ? "true" : "false",
			options: [{
				value: "false",
				label: t("disableFrameRelayOff")
			}, {
				value: "true",
				label: t("disableFrameRelayOn")
			}],
			disabled: busy,
			onEdit: function(v) {
				controller.edit("disableFrameRelay", v === "true");
			}
		}), h(SettingsField, {
			id: "plugin-config-ego-browser-idletimeout",
			label: t("idleTimeoutMin"),
			hint: t("idleTimeoutMinHint"),
			value: state.draft.idleTimeoutMin,
			numeric: true,
			narrow: true,
			unit: t("minUnit"),
			min: 0,
			max: 1440,
			step: 1,
			disabled: busy,
			onEdit: function(v) {
				controller.edit("idleTimeoutMin", v);
			}
		}), h(SettingsField, {
			id: "plugin-config-ego-browser-chromepath",
			label: t("chromePath"),
			hint: t("chromePathHint"),
			value: state.draft.chromePath || "",
			placeholder: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
			disabled: busy,
			onEdit: function(v) {
				controller.edit("chromePath", v);
			}
		}), h(SettingsField, {
			id: "plugin-config-ego-browser-backend",
			label: t("captureBackend"),
			value: state.draft.captureBackend,
			options: [
				"auto",
				"cdp",
				{
					value: "ffmpeg",
					label: ffmpegStatus.canSelectFfmpeg ? "ffmpeg" : t("ffmpegRequired"),
					disabled: !ffmpegStatus.canSelectFfmpeg
				}
			],
			disabled: busy,
			onEdit: function(v) {
				controller.edit("captureBackend", v);
			}
		}), h(SettingsField, {
			id: "plugin-config-ego-browser-profile",
			label: t("streamProfile"),
			value: state.draft.streamProfile,
			options: [
				"low",
				"balanced",
				"high"
			],
			disabled: busy,
			onEdit: function(v) {
				controller.edit("streamProfile", v);
			}
		}), h(SettingsField, {
			id: "plugin-config-ego-browser-cdpfps",
			label: t("cdpFps"),
			value: state.draft.cdpFps,
			numeric: true,
			narrow: true,
			unit: t("fpsUnit"),
			min: 5,
			max: 30,
			step: 1,
			disabled: busy,
			onEdit: function(v) {
				controller.edit("cdpFps", v);
			}
		}), h(SettingsField, {
			id: "plugin-config-ego-browser-cdpquality",
			label: t("cdpQuality"),
			value: state.draft.cdpQuality,
			numeric: true,
			narrow: true,
			min: 1,
			max: 100,
			step: 1,
			disabled: busy,
			onEdit: function(v) {
				controller.edit("cdpQuality", v);
			}
		}), h(SettingsField, {
			id: "plugin-config-ego-browser-cdpwidth",
			label: t("cdpMaxWidth"),
			value: state.draft.cdpMaxWidth,
			numeric: true,
			narrow: true,
			unit: t("pxUnit"),
			min: 320,
			max: 1920,
			step: 40,
			disabled: busy,
			onEdit: function(v) {
				controller.edit("cdpMaxWidth", v);
			}
		}), h(SettingsField, {
			id: "plugin-config-ego-browser-backstop",
			label: t("cdpBackstopIntervalMs"),
			value: state.draft.cdpBackstopIntervalMs,
			numeric: true,
			narrow: true,
			unit: t("msUnit"),
			min: 1e3,
			max: 1e4,
			step: 100,
			disabled: busy,
			onEdit: function(v) {
				controller.edit("cdpBackstopIntervalMs", v);
			}
		}), h(SettingsField, {
			id: "plugin-config-ego-browser-fffps",
			label: t("ffmpegFps"),
			value: state.draft.ffmpegFps,
			numeric: true,
			narrow: true,
			unit: t("fpsUnit"),
			min: 5,
			max: 30,
			step: 1,
			disabled: busy,
			onEdit: function(v) {
				controller.edit("ffmpegFps", v);
			}
		}), h(SettingsField, {
			id: "plugin-config-ego-browser-ffwidth",
			label: t("ffmpegMaxWidth"),
			value: state.draft.ffmpegMaxWidth,
			numeric: true,
			narrow: true,
			unit: t("pxUnit"),
			min: 320,
			max: 1920,
			step: 40,
			disabled: busy,
			onEdit: function(v) {
				controller.edit("ffmpegMaxWidth", v);
			}
		}), h(SettingsField, {
			id: "plugin-config-ego-browser-ffbitrate",
			label: t("ffmpegBitrateKbps"),
			value: state.draft.ffmpegBitrateKbps,
			numeric: true,
			narrow: true,
			unit: t("kbpsUnit"),
			min: 500,
			max: 2e4,
			step: 250,
			disabled: busy,
			onEdit: function(v) {
				controller.edit("ffmpegBitrateKbps", v);
			}
		}), h(SettingsField, {
			id: "plugin-config-ego-browser-encoder",
			label: t("ffmpegEncoder"),
			value: state.draft.ffmpegEncoder,
			options: [
				"auto",
				"software",
				"h264_mf",
				"h264_nvenc",
				"h264_qsv",
				"h264_amf",
				"h264_videotoolbox",
				"h264_vaapi"
			],
			disabled: busy,
			onEdit: function(v) {
				controller.edit("ffmpegEncoder", v);
			}
		}), h(SettingsField, {
			id: "plugin-config-ego-browser-ffpath",
			label: t("ffmpegPath"),
			value: state.draft.ffmpegPath,
			placeholder: "ffmpeg",
			disabled: busy,
			onEdit: function(v) {
				controller.edit("ffmpegPath", v);
			}
		}), h(SettingsField, {
			id: "plugin-config-ego-browser-ghmirror",
			label: t("githubMirror"),
			value: state.draft.githubMirror,
			hint: t("githubMirrorHint"),
			placeholder: "https://gh-proxy.com/github.com",
			disabled: busy,
			onEdit: function(v) {
				controller.edit("githubMirror", v);
			}
		}), h(SettingsField, {
			id: "plugin-config-ego-browser-ego-cli-args",
			label: t("egoCliArgs"),
			value: state.draft.egoCliArgs,
			hint: t("egoCliArgsHint"),
			placeholder: "--sdk-path /path/to/harness.js",
			disabled: busy,
			onEdit: function(v) {
				controller.edit("egoCliArgs", v);
			}
		}), h(SettingsField, {
			id: "plugin-config-ego-browser-chrome-args",
			label: t("chromeArgs"),
			value: state.draft.chromeArgs,
			hint: t("chromeArgsHint"),
			placeholder: "--disable-features=Translate --window-size=1024,768",
			disabled: busy,
			onEdit: function(v) {
				controller.edit("chromeArgs", v);
			}
		}), h(LoginImportBlock, { t }), h("div", { className: "dsh-ego-card__ffmpeg" }, h("div", { className: "dsh-ego-card__ffmpeg-title" }, t("ffmpegTitle")), h("div", {
			className: "dsh-ego-card__ffmpeg-status",
			role: "status"
		}, t(ffmpegLabelKey) + (ffmpegStatus.reason ? ": " + ffmpegStatus.reason : "") + (progressText ? " " + progressText : "")), progress && progress.percent !== null && progress.percent !== void 0 ? h("div", { className: "dsh-ego-card__progress" }, h("div", {
			className: "dsh-ego-card__progress-bar",
			style: { width: progress.percent + "%" }
		})) : null, ffmpegStatus.path ? h("div", { className: "dsh-ego-card__ffmpeg-status" }, t("ffmpegSource") + ": " + (ffmpegStatus.source || "-") + " · " + ffmpegStatus.path) : null, ffmpegStatus.version ? h("div", { className: "dsh-ego-card__ffmpeg-status" }, t("ffmpegVersion") + ": " + ffmpegStatus.version) : null, h("div", { className: "dsh-ego-card__ffmpeg-actions" }, h("button", {
			type: "button",
			className: "dsh-ego-card__btn",
			disabled: ffmpegBusy,
			onClick: function() {
				controller.checkFfmpeg();
			}
		}, t("ffmpegRecheck")), ffmpegStatus.canDownload ? h("button", {
			type: "button",
			className: "dsh-ego-card__btn dsh-ego-card__btn--primary",
			disabled: ffmpegBusy,
			onClick: function() {
				controller.installFfmpeg();
			}
		}, ffmpegStatus.source === "managed" ? t("ffmpegReinstall") : t("ffmpegInstall")) : null))), h("div", { className: "dsh-ego-card__footer" }, errorText !== void 0 ? h("p", {
			className: "dsh-ego-card__failed",
			role: "status"
		}, errorText) : null, h("button", {
			type: "button",
			className: "dsh-ego-card__btn",
			disabled: discardDisabled,
			onClick: function() {
				controller.discard();
			}
		}, t("discard")), h("button", {
			type: "button",
			className: "dsh-ego-card__btn dsh-ego-card__btn--primary",
			disabled: saveDisabled,
			onClick: function() {
				controller.save();
			}
		}, saving ? t("saving") : t("save"))));
	}
	return h("li", { className: "dsh-ego-card" + (open ? " dsh-ego-card--open" : "") }, header, open ? body : null);
}
function isFfmpegBusy(state) {
	return [
		"checking",
		"downloading",
		"verifying",
		"extracting",
		"probing"
	].includes(state);
}
function formatBytes(value) {
	if (!Number.isFinite(value) || value <= 0) return "0 B";
	if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KiB";
	return (value / (1024 * 1024)).toFixed(1) + " MiB";
}
const SPACES_ROUTE = "/api/ego/spaces";
const EGO_CLOSE_ROUTE = "/api/ego/close";
const WATCH_START_ROUTE = "/api/ego/watch/start";
const WATCH_SWITCH_ROUTE = "/api/ego/watch/switch";
const WATCH_STOP_ROUTE = "/api/ego/watch/stop";
const WATCH_STATUS_ROUTE = "/api/ego/watch/status";
const VIDEO_ROUTE = "/api/ego/video";
function postJson(path, body) {
	return fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body || {})
	}).then(function(res) {
		return res.json().catch(function() {
			return {};
		});
	});
}
function createKeyboardProxy(send) {
	var input = document.createElement("textarea");
	input.className = "dsh-ego-keyboard-proxy";
	input.tabIndex = -1;
	input.setAttribute("autocomplete", "off");
	input.setAttribute("autocapitalize", "off");
	input.setAttribute("spellcheck", "false");
	input.style.cssText = "position:fixed;z-index:2147483647;width:1px;height:1px;opacity:.01;pointer-events:none;resize:none;padding:0;border:0;left:0;top:0;";
	document.body.appendChild(input);
	var composing = false;
	var armed = false;
	var activeTargetId = null;
	var pressed = /* @__PURE__ */ new Map();
	var lastCompositionText = "", lastCompositionAt = 0, lastPasteText = "", lastPasteAt = 0;
	var blurCount = 0, lastBlurAt = 0;
	var modifiers = function(e) {
		return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
	};
	var keyId = function(e) {
		return e.code || e.key;
	};
	var keyPayload = function(e) {
		return {
			key: e.key,
			code: e.code || "",
			modifiers: modifiers(e),
			autoRepeat: !!e.repeat,
			windowsVirtualKeyCode: Number(e.keyCode || e.which || 0)
		};
	};
	var isDshInput = function(target) {
		if (!target || target === input) return false;
		var tag = target.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA") return true;
		if (target.isContentEditable) return true;
		return false;
	};
	var releaseAllKeys = function() {
		for (const record of pressed.values()) send(record.targetId, "keyUp", Object.assign({}, record.payload, { autoRepeat: false }));
		pressed.clear();
	};
	input.addEventListener("compositionstart", function(e) {
		composing = true;
		e.stopPropagation();
	});
	input.addEventListener("compositionend", function(e) {
		composing = false;
		e.stopPropagation();
		if (e.data && activeTargetId) {
			lastCompositionText = e.data;
			lastCompositionAt = Date.now();
			send(activeTargetId, "insertText", { text: e.data });
		}
		window.setTimeout(function() {
			input.value = "";
		}, 0);
	});
	input.addEventListener("beforeinput", function(e) {
		e.stopPropagation();
		if (composing || /Composition/i.test(e.inputType || "")) return;
		if (e.data && e.data === lastCompositionText && Date.now() - lastCompositionAt < 100) {
			e.preventDefault();
			return;
		}
		if (e.data && e.data === lastPasteText && Date.now() - lastPasteAt < 100) {
			e.preventDefault();
			return;
		}
		if (e.data && activeTargetId) {
			e.preventDefault();
			send(activeTargetId, "insertText", { text: e.data });
			input.value = "";
		}
	});
	input.addEventListener("paste", function(e) {
		var text = e.clipboardData && e.clipboardData.getData("text/plain");
		if (!text) return;
		e.preventDefault();
		e.stopPropagation();
		lastPasteText = text;
		lastPasteAt = Date.now();
		if (activeTargetId) send(activeTargetId, "insertText", { text });
		input.value = "";
	});
	input.addEventListener("keydown", function(e) {
		e.stopPropagation();
		if (composing || e.key === "Process" || e.key === "Dead") return;
		if (e.getModifierState && e.getModifierState("AltGraph") && e.key.length === 1) return;
		var isShortcut = e.ctrlKey || e.metaKey || e.altKey;
		var isControl = e.key.length > 1;
		if (!isShortcut && !isControl) return;
		if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "v") return;
		if (!activeTargetId) return;
		e.preventDefault();
		var payload = keyPayload(e);
		pressed.set(keyId(e), {
			targetId: activeTargetId,
			payload
		});
		send(activeTargetId, "keyDown", payload);
	});
	input.addEventListener("keyup", function(e) {
		e.stopPropagation();
		var id = keyId(e);
		var record = pressed.get(id);
		if (!record) return;
		e.preventDefault();
		pressed.delete(id);
		send(record.targetId, "keyUp", keyPayload(e));
	});
	input.addEventListener("blur", function() {
		if (!armed || !activeTargetId) return;
		var now = Date.now();
		if (now - lastBlurAt < 1e3) {
			blurCount++;
			if (blurCount > 3) return;
		} else blurCount = 0;
		lastBlurAt = now;
		window.setTimeout(function() {
			if (armed && activeTargetId) try {
				input.focus({ preventScroll: true });
			} catch (err) {
				input.focus();
			}
		}, 0);
	});
	var onDocKeyDown = function(e) {
		if (!armed || !activeTargetId) return;
		if (e.target === input) return;
		if (composing || e.key === "Process" || e.key === "Dead") return;
		if (e.getModifierState && e.getModifierState("AltGraph") && e.key.length === 1) return;
		if (isDshInput(e.target) && document.activeElement === e.target) return;
		var isShortcut = e.ctrlKey || e.metaKey || e.altKey;
		var isControl = e.key.length > 1;
		if (!isShortcut && !isControl) {
			e.preventDefault();
			e.stopPropagation();
			send(activeTargetId, "insertText", { text: e.key });
			return;
		}
		if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "v") return;
		e.preventDefault();
		e.stopPropagation();
		var payload = keyPayload(e);
		pressed.set(keyId(e), {
			targetId: activeTargetId,
			payload
		});
		send(activeTargetId, "keyDown", payload);
	};
	var onDocKeyUp = function(e) {
		if (!armed || !activeTargetId) return;
		if (e.target === input) return;
		var id = keyId(e);
		var record = pressed.get(id);
		if (!record) return;
		e.preventDefault();
		e.stopPropagation();
		pressed.delete(id);
		send(record.targetId, "keyUp", keyPayload(e));
	};
	var onDocPointerDown = function(e) {
		if (armed && isDshInput(e.target) && e.target !== input) {
			armed = false;
			releaseAllKeys();
		}
	};
	document.addEventListener("keydown", onDocKeyDown, true);
	document.addEventListener("keyup", onDocKeyUp, true);
	document.addEventListener("pointerdown", onDocPointerDown, true);
	return {
		focusAt: function(e, targetId) {
			if (activeTargetId && targetId !== activeTargetId) releaseAllKeys();
			activeTargetId = targetId;
			armed = true;
			blurCount = 0;
			input.style.left = Math.max(0, e.clientX) + "px";
			input.style.top = Math.max(0, e.clientY) + "px";
			try {
				input.focus({ preventScroll: true });
			} catch (err) {
				input.focus();
			}
		},
		dispose: function() {
			armed = false;
			document.removeEventListener("keydown", onDocKeyDown, true);
			document.removeEventListener("keyup", onDocKeyUp, true);
			document.removeEventListener("pointerdown", onDocPointerDown, true);
			releaseAllKeys();
			input.remove();
		}
	};
}
function createMsePlayer(video, generation, mime, onFailure) {
	if (!window.MediaSource || !window.MediaSource.isTypeSupported(mime)) {
		onFailure("当前浏览器不支持此 H.264 流");
		return function() {};
	}
	var mediaSource = new MediaSource();
	var objectUrl = URL.createObjectURL(mediaSource);
	var abort = new AbortController();
	var sourceBuffer = null, queue = [], queuedBytes = 0, disposed = false, reader = null, reading = false;
	var MAX_QUEUED_VIDEO_BYTES = 4 * 1024 * 1024;
	video.src = objectUrl;
	video.muted = true;
	video.autoplay = true;
	video.playsInline = true;
	function appendNext() {
		if (disposed || !sourceBuffer || sourceBuffer.updating || queue.length === 0) return;
		var chunk = queue.shift();
		queuedBytes -= chunk.byteLength;
		try {
			sourceBuffer.appendBuffer(chunk);
		} catch (error) {
			onFailure(error.message);
		}
	}
	function pump() {
		if (disposed || reading || !reader || queuedBytes >= MAX_QUEUED_VIDEO_BYTES) return;
		reading = true;
		reader.read().then(function(part) {
			reading = false;
			if (disposed) return;
			if (part.done) {
				onFailure("视频流已断开");
				return;
			}
			queue.push(part.value);
			queuedBytes += part.value.byteLength;
			appendNext();
			pump();
		}).catch(function(error) {
			reading = false;
			if (!disposed && error.name !== "AbortError") onFailure(error.message);
		});
	}
	mediaSource.addEventListener("sourceopen", function() {
		if (disposed) return;
		try {
			sourceBuffer = mediaSource.addSourceBuffer(mime);
		} catch (error) {
			onFailure(error.message);
			return;
		}
		sourceBuffer.mode = "segments";
		sourceBuffer.addEventListener("updateend", function() {
			if (video.buffered.length) {
				var end = video.buffered.end(video.buffered.length - 1);
				if (end - video.currentTime > .8) video.currentTime = Math.max(0, end - .15);
				if (!sourceBuffer.updating && video.buffered.start(0) < end - 3) try {
					sourceBuffer.remove(video.buffered.start(0), end - 2);
				} catch (e) {}
			}
			appendNext();
			pump();
		});
		fetch(VIDEO_ROUTE + "?generation=" + encodeURIComponent(generation), { signal: abort.signal }).then(function(res) {
			if (!res.ok || !res.body) throw new Error("视频流连接失败 (" + res.status + ")");
			reader = res.body.getReader();
			pump();
		}).catch(function(error) {
			if (!disposed && error.name !== "AbortError") onFailure(error.message);
		});
	});
	return function() {
		disposed = true;
		abort.abort();
		queue = [];
		queuedBytes = 0;
		try {
			video.pause();
			video.removeAttribute("src");
			video.load();
		} catch (e) {}
		try {
			URL.revokeObjectURL(objectUrl);
		} catch (e) {}
	};
}
const OPEN_KEY = "dsh.ego.watch.open";
const ACTIVE_WINDOW_MS = 3e3;
const PANEL_CSS = `
/* ---- deep Apple / macOS dark-glass chrome ---- */
:root { --ego-ios-gap: 6px; }

#dsh-ego-fab {
  position: fixed; left: 0; top: 0; z-index: 9999;
  width: 48px; height: 48px; border-radius: 50%;
  border: 1px solid rgba(255,255,255,.14);
  background: rgba(30,30,32,.72);
  -webkit-backdrop-filter: blur(22px) saturate(180%);
  backdrop-filter: blur(22px) saturate(180%);
  color: #f5f5f7; cursor: grab;
  touch-action: none; user-select: none; -webkit-user-select: none;
  box-shadow: 0 10px 30px rgba(0,0,0,.45);
  display: flex; align-items: center; justify-content: center;
}
#dsh-ego-fab.dsh-ego-dragging { cursor: grabbing; opacity:.85; }
#dsh-ego-fab:hover { transform: scale(1.09); }
#dsh-ego-fab[hidden] { display: none; }
#dsh-ego-fab .dsh-ego-dot {
  position: absolute; top: 1px; right: 1px; width: 11px; height: 11px;
  border-radius: 50%; background: #86868b;
  border: 2px solid rgba(30,30,32,.9);
}
#dsh-ego-fab svg { width: 22px; height: 22px; }
/* FAB status dot: steady green while the agent is driving the browser
   (busy), breathing green when idle (browser open, no recent action). */
#dsh-ego-fab.dsh-ego-live:not(.dsh-ego-busy) .dsh-ego-dot {
  background: #30d158; box-shadow: 0 0 8px #30d158aa;
  animation: dsh-ego-breathe 2.4s ease-in-out infinite;
}
#dsh-ego-fab.dsh-ego-busy .dsh-ego-dot {
  background: #30d158; box-shadow: 0 0 9px #30d158cc; animation: none;
}
@keyframes dsh-ego-breathe {
  0%, 100% { box-shadow: 0 0 2px #30d15822; opacity: .5; }
  50%      { box-shadow: 0 0 11px #30d158ee; opacity: 1; }
}

#dsh-ego-panel {
  position: fixed; left: 0; top: 0; z-index: 9998;
  width: 408px; max-height: 78vh;
  display: flex; flex-direction: column; overflow: hidden;
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 16px;
  background: rgba(28,28,30,.74);
  -webkit-backdrop-filter: blur(26px) saturate(180%);
  backdrop-filter: blur(26px) saturate(180%);
  color: #f5f5f7;
  box-shadow: 0 14px 44px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.08);
  /* Pop-out animation: the panel springs up-left out of the ball's spot.
     transform-origin sits near its bottom-right (closest to the FAB). */
  opacity: 0; pointer-events: none;
  transform-origin: 82% 100%;
  transform: translateY(12px) scale(.88);
  transition: opacity .26s cubic-bezier(.16,.8,.3,1.05),
              transform .26s cubic-bezier(.16,.8,.3,1.15),
              visibility .26s;
  will-change: transform, opacity;
}
#dsh-ego-panel.dsh-ego-panel-open { opacity: 1; pointer-events: auto; transform: none; }
#dsh-ego-panel[hidden] { display: none; }
#dsh-ego-panel.open-drawer { width: 640px; }

/* FAB press / open feedback */
#dsh-ego-fab:active { transform: scale(.95); }
#dsh-ego-fab.dsh-ego-on { transform: scale(1.12); box-shadow: 0 0 0 6px rgba(10,132,255,.22), 0 10px 30px rgba(0,0,0,.5); }
#dsh-ego-fab.dsh-ego-on:hover { transform: scale(1.18); }

/* Drag handles for the panel: its header doubles as a title-bar grip. */
#dsh-ego-head { cursor: grab; }
#dsh-ego-head.dsh-ego-grabbing { cursor: grabbing; }
#dsh-ego-head .dsh-ego-grip {
  flex: none; width: 22px; height: 22px; border-radius: 6px;
  display: inline-flex; align-items: center; justify-content: center;
  color:#86868b; opacity:.8;
}
#dsh-ego-head .dsh-ego-grip svg { width: 13px; height: 13px; }

#dsh-ego-head { display:flex; align-items:center; gap:4px; padding:10px 14px;
  border-bottom:1px solid rgba(255,255,255,.08); }
#dsh-ego-title { flex:1; font-size:13px; font-weight:600; letter-spacing:.2px;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:flex; align-items:center; gap:6px; }
#dsh-ego-title svg { width:16px; height:16px; color:#0a84ff; flex-shrink:0; }
#dsh-ego-iconbtn {
  background: transparent; border:none; color: #aeaeb2; cursor: pointer;
  width: 28px; height: 28px; border-radius: 8px; padding: 0;
  display:flex; align-items:center; justify-content:center;
  transition: background .15s ease, color .15s ease;
}
#dsh-ego-iconbtn svg { width: 15px; height: 15px; }
#dsh-ego-iconbtn:hover { background: rgba(255,255,255,.12); color: #f5f5f7; }
#dsh-ego-iconbtn.off { opacity:.5; }
#dsh-ego-iconbtn.spinning svg { animation: dsh-ego-spin .7s linear infinite; }
@keyframes dsh-ego-spin { to { transform: rotate(360deg); } }

#dsh-ego-body { flex:1; overflow-y:auto; padding:12px 14px; min-height:60px; }
.dsh-ego-empty { padding:20px 12px; text-align:center; color:#86868b; font-size:12.5px; line-height:1.7; }
.dsh-ego-off { padding:6px 14px 10px; text-align:center; font-size:11px; color:#6e6e73; }
.dsh-ego-off svg { width:11px; height:11px; vertical-align:-1px; color:#6e6e73; }

/* ---- login guide strip (top of the panel body) ---- */
#dsh-ego-login { display:none; align-items:center; gap:8px; margin:0 14px 9px; padding:7px 10px;
  border-radius:9px; border:1px solid rgba(255,214,10,.28); background: rgba(255,214,10,.09); }
#dsh-ego-login.show { display:flex; }
#dsh-ego-login .dsh-ego-login-txt { flex:1; min-width:0; font-size:11px; line-height:1.45; color:#f5f5f7; }
#dsh-ego-login .dsh-ego-login-txt b { color:#ffd60a; }
#dsh-ego-login .dsh-ego-login-btn { flex:none; background:#0a84ff; color:#fff; border:none; border-radius:8px;
  font-size:11px; padding:4px 10px; cursor:pointer; white-space:nowrap; transition: background .15s ease; }
#dsh-ego-login .dsh-ego-login-btn:hover { background:#338cff; }
#dsh-ego-login .dsh-ego-login-btn.saving { opacity:.55; pointer-events:none; }
#dsh-ego-login .dsh-ego-login-note { flex:none; font-size:10.5px; color:#6e6e73; white-space:nowrap; }
/* dismiss (×) on guide strips so the user can close them and reclaim the space */
.dsh-ego-dismiss { flex:none; width:18px; height:18px; line-height:1; border-radius:50%; border:none;
  background: rgba(255,255,255,.12); color:inherit; font-size:13px; cursor:pointer; opacity:.75;
  display:inline-flex; align-items:center; justify-content:center; padding:0; transition: background .15s,opacity .15s; }
.dsh-ego-dismiss:hover { background: rgba(255,69,58,.35); opacity:1; }
#dsh-ego-login .dsh-ego-dismiss { color:#ffd60a; }
#dsh-ego-captcha .dsh-ego-dismiss { color:#ffd8d5; }

/* ---- human-verification (CAPTCHA) reminder strip ---- */
#dsh-ego-captcha { display:none; align-items:center; gap:8px; margin:0 14px 9px; padding:8px 11px;
  border-radius:9px; border:1px solid rgba(255,69,58,.4); background: rgba(255,69,58,.13); color:#ffe1de; }
#dsh-ego-captcha.show { display:flex; }
#dsh-ego-captcha .dsh-ego-captcha-txt { flex:1; min-width:0; font-size:11.5px; line-height:1.5; }
#dsh-ego-captcha .dsh-ego-captcha-txt b { color:#ff6961; }
#dsh-ego-captcha .dsh-ego-captcha-kind { flex:none; font-size:10px; padding:2px 8px; border-radius:999px;
  background: rgba(255,255,255,.12); color:#ffd8d5; text-transform:uppercase; letter-spacing:.4px; }

/* ---- tab bar: frosted pills ---- */
#dsh-ego-tabs { display:flex; gap:6px; padding:9px 12px;
  border-bottom:1px solid rgba(255,255,255,.08); overflow-x:auto; flex-shrink:0; scrollbar-width:thin; }
#dsh-ego-tabs:empty { display:none; }
.dsh-ego-tab {
  display:inline-flex; align-items:center; gap:6px; max-width:176px; white-space:nowrap;
  padding:5px 12px; border-radius: 999px; cursor:pointer; font-size:11.5px; flex-shrink:0;
  border:1px solid rgba(255,255,255,.1);
  background: rgba(72,72,74,.45); color:#aeaeb2;
  transition: background .15s ease, color .15s ease, border-color .15s ease;
}
.dsh-ego-tab > .dsh-ego-tabtxt { overflow:hidden; text-overflow:ellipsis; }
.dsh-ego-tab:hover { color:#f5f5f7; background: rgba(72,72,74,.65); }
.dsh-ego-tab.active {
  background: #0a84ff; color:#fff; border-color: transparent;
  box-shadow: 0 2px 10px rgba(10,132,255,.35);
}
.dsh-ego-tab .dsh-ego-tabdot { width:7px; height:7px; border-radius:50%; background:#86868b; flex-shrink:0; }
.dsh-ego-tab.active .dsh-ego-tabdot { background:#fff; }
.dsh-ego-tab .dsh-ego-tabclose { flex-shrink:0; width:14px; height:14px; line-height:13px; text-align:center;
  border-radius:50%; font-size:12px; color:#86868b; margin-left:2px; }
.dsh-ego-tab .dsh-ego-tabclose:hover { background:rgba(255,255,255,.2); color:#ff453a; }
.dsh-ego-tab.active .dsh-ego-tabclose { color:rgba(255,255,255,.85); }
.dsh-ego-tab.active .dsh-ego-tabclose:hover { color:#ff453a; background:rgba(255,255,255,.25); }

/* ---- main live view ---- */
.dsh-ego-liveview { display:flex; flex-direction:column; gap:9px; min-height:60px;
  overflow:hidden; /* clips the zoomed image so it doesn't bleed outside */ }
.dsh-ego-livebadge { font-size:11px; color:#86868b; letter-spacing:.3px;
  display:flex; align-items:center; gap:6px; }
.dsh-ego-state-dot { display:inline-block; width:8px; height:8px; border-radius:50%;
  background:#30d158; box-shadow:0 0 6px #30d15888; flex-shrink:0;
  animation: dsh-ego-breathe 2.4s ease-in-out infinite; }
.dsh-ego-state-dot.busy { background:#30d158; box-shadow:0 0 7px #30d158bb; animation:none; }
.dsh-ego-state-dot.pin { background:#0a84ff; box-shadow:0 0 6px #0a84ff88; animation:none; }
.dsh-ego-back {
  background: rgba(255,255,255,.12); color:#f5f5f7;
  border:1px solid rgba(255,255,255,.12); border-radius:7px;
  cursor:pointer; font-size:11px; padding:3px 9px;
  display:inline-flex; align-items:center; gap:4px;
  transition: background .15s ease;
}
.dsh-ego-back:hover { background: rgba(255,255,255,.2); }
.dsh-ego-liveimg {
  width:100%; border-radius:11px; display:block;
  max-height:50vh; object-fit:contain;
  border:1px solid rgba(255,255,255,.14);
  background:#000; /* letterbox behind landscape jpeg */
  box-shadow: 0 4px 16px rgba(0,0,0,.35);
  user-select:none; -webkit-user-select:none; touch-action:none;
  will-change:transform; cursor:grab;
}
.dsh-ego-zoomhint { font-size:10.5px; color:#6e6e73; letter-spacing:.2px; margin-top:-3px; }
.dsh-ego-livetitle { font-size:13px; font-weight:600; }
.dsh-ego-liveurl { font-size:11.5px; color:#86868b; word-break:break-all; }
.dsh-ego-liveurl.dsh-ego-hint { color:#75c2ff; font-style:italic; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-shadow:0 0 6px rgba(117,194,255,.4); }
.dsh-ego-hint { animation: dsh-ego-hint-in .2s ease; }
@keyframes dsh-ego-hint-in { from { opacity:.3 } to { opacity:1 } }

/* ---- history drawer ---- */
#dsh-ego-history { display:none; flex-direction:column; width:224px; flex-shrink:0;
  border-left:1px solid rgba(255,255,255,.08); background: rgba(0,0,0,.18); }
#dsh-ego-history.open { display:flex; }
#dsh-ego-historyhead { padding:9px 12px; font-size:12px; font-weight:600; color:#86868b;
  display:flex; align-items:center; gap:6px;
  border-bottom:1px solid rgba(255,255,255,.06); }
#dsh-ego-historyhead svg { width:12px; height:12px; }
#dsh-ego-historylist { overflow-y:auto; padding:7px; }
.dsh-ego-hitem { display:flex; gap:8px; align-items:center; padding:6px; border-radius:9px; cursor:pointer;
  transition: background .15s ease; }
.dsh-ego-hitem:hover { background: rgba(255,255,255,.1); }
.dsh-ego-hthumb { width:58px; height:42px; border-radius:6px; object-fit:cover; background:#000;
  flex-shrink:0; border:1px solid rgba(255,255,255,.14); }
.dsh-ego-hinfo { min-width:0; }
.dsh-ego-hurl { font-size:10.5px; color:#86868b; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsh-ego-htitle { font-size:10.5px; font-weight:500; color:#f5f5f7; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsh-ego-hactive { color:#30d158; font-size:10.5px; }
.dsh-ego-hnone { padding:16px 8px; text-align:center; font-size:11px; color:#6e6e73; }

#dsh-ego-cols { display:flex; flex:1; min-height:0; }
.dsh-ego-maincol { flex:1; min-width:0; display:flex; flex-direction:column; }
`;
const ICON_GLOBE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 3c2.5 2.4 3.8 5.4 3.8 9S14.5 18.6 12 21"/><path d="M12 3C9.5 5.4 8.2 8.4 8.2 12s1.3 6.6 3.8 9"/><path d="M3 12h18"/></svg>`;
const ICON_REFRESH = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 4.5V9h-4.5"/></svg>`;
const ICON_CLOCK = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg>`;
const ICON_CLOSE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
const ICON_GRIP = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="6" r="1.8"/><circle cx="16" cy="6" r="1.8"/><circle cx="8" cy="12" r="1.8"/><circle cx="16" cy="12" r="1.8"/><circle cx="8" cy="18" r="1.8"/><circle cx="16" cy="18" r="1.8"/></svg>`;
function apply(ctx) {
	ctx.effect(() => ctx.locale.register(SETTINGS_NS, {
		zh,
		en
	}), "ego-browser: settings dictionaries");
	ctx.effect(() => {
		if (typeof document === "undefined") return;
		if (document.getElementById(SETTINGS_CARD_STYLE_ID) !== null) return;
		var tag = document.createElement("style");
		tag.id = SETTINGS_CARD_STYLE_ID;
		tag.dataset.plugin = "ego-browser";
		tag.textContent = SETTINGS_CARD_CSS;
		document.head.appendChild(tag);
		return function() {
			tag.remove();
		};
	}, "ego-browser: settings card css");
	var controller = new EgoBrowserSettingsController();
	var useSnapshot = bindSnapshotSelector(controller.store);
	ctx.effect(() => {
		var pending = false;
		var refresh = function() {
			if (pending) return;
			pending = true;
			queueMicrotask(function() {
				pending = false;
				if (controller.loaded) controller.load();
			});
		};
		var dispose = ctx.on("connection/reset", refresh);
		return function() {
			dispose();
		};
	}, "ego-browser: settings invalidation");
	ctx.slots.inject("settings.plugin.item", function* () {
		yield ctx.slots.register({
			name: "settings.plugin.item",
			key: SETTINGS_NS,
			order: 60,
			locale: SETTINGS_NS,
			inject: function() {
				return {
					controller,
					useSnapshot
				};
			}
		}, EgoBrowserCard);
	});
	var betterSidebarService;
	try {
		betterSidebarService = typeof ctx.get === "function" ? ctx.get("betterSidebar") : void 0;
	} catch (e) {
		betterSidebarService = void 0;
	}
	if (betterSidebarService !== void 0) ctx.effect(() => mountSidebarTab(ctx, betterSidebarService), "ego-browser sidebar tab");
	else {
		var disposeFloating = null;
		ctx.effect(() => {
			disposeFloating = mountFloatingWatch(ctx);
			return function() {
				if (disposeFloating) {
					var d = disposeFloating;
					disposeFloating = null;
					d();
				}
			};
		}, "ego-browser watch panel");
		if (typeof ctx.inject === "function") ctx.inject(["betterSidebar"], function(sidebarCtx) {
			var svc;
			try {
				svc = typeof sidebarCtx.get === "function" ? sidebarCtx.get("betterSidebar") : sidebarCtx.betterSidebar;
			} catch (e) {
				svc = void 0;
			}
			if (!svc) return;
			if (disposeFloating) {
				var d2 = disposeFloating;
				disposeFloating = null;
				d2();
			}
			sidebarCtx.effect(function() {
				return mountSidebarTab(sidebarCtx, svc);
			}, "ego-browser sidebar tab");
		});
	}
}
function mountFloatingWatch(ctx) {
	if (document.getElementById("dsh-ego-fab") !== null) return () => {};
	const style = document.createElement("style");
	style.textContent = PANEL_CSS;
	document.head.appendChild(style);
	const panel = document.createElement("div");
	panel.id = "dsh-ego-panel";
	panel.hidden = true;
	panel.innerHTML = `
					<div id="dsh-ego-head">
						<span class="dsh-ego-grip" title="${wt("dragHint")}">${ICON_GRIP}</span>
						<span id="dsh-ego-title">${ICON_GLOBE}<span style="margin-left:6px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${wt("title")}</span></span>
						<button id="dsh-ego-refresh" class="dsh-ego-iconbtn" title="${wt("refresh")}">${ICON_REFRESH}</button>
						<button id="dsh-ego-historybtn" class="dsh-ego-iconbtn off" title="${wt("historyShow")}">${ICON_CLOCK}</button>
						<button id="dsh-ego-close" class="dsh-ego-iconbtn" title="${wt("settingsHide")}">${ICON_CLOSE}</button>
					</div>
					<div id="dsh-ego-tabs"></div>
					<div id="dsh-ego-login">
						<span class="dsh-ego-login-txt">${wt("loginTitle")}</span>
						<button id="dsh-ego-login-btn" class="dsh-ego-login-btn" type="button">${wt("loginBtn")}</button>
						<span class="dsh-ego-login-note" id="dsh-ego-login-note"></span>
						<button class="dsh-ego-dismiss" type="button" title="${wt("loginDismiss")}" data-dismiss="login">×</button>
					</div>
					<div id="dsh-ego-captcha">
						<span class="dsh-ego-captcha-txt"><b>${wt("captchaTitle")}</b> — ${wt("captchaHint")}</span>
						<span class="dsh-ego-captcha-kind" id="dsh-ego-captcha-kind"></span>
						<button class="dsh-ego-dismiss" type="button" title="${wt("captchaDismiss")}" data-dismiss="captcha">×</button>
					</div>
					<div id="dsh-ego-cols">
						<div class="dsh-ego-maincol">
							<div id="dsh-ego-body"></div>
						</div>
						<aside id="dsh-ego-history">
							<div id="dsh-ego-historyhead">${ICON_CLOCK} ${wt("history")}</div>
							<div id="dsh-ego-historylist"></div>
						</aside>
					</div>
					<div class="dsh-ego-off">${wt("liveView")} · ${wt("realtime")} · ${ICON_CLOCK} ${wt("historyShow")}</div>
				`;
	const fab = document.createElement("button");
	fab.id = "dsh-ego-fab";
	fab.type = "button";
	fab.title = wt("fabTitle");
	fab.textContent = "";
	fab.innerHTML = `${ICON_GLOBE}<span class="dsh-ego-dot"></span>`;
	const body = panel.querySelector("#dsh-ego-body");
	const titleEl = panel.querySelector("#dsh-ego-title");
	const refreshBtn = panel.querySelector("#dsh-ego-refresh");
	const closeBtn = panel.querySelector("#dsh-ego-close");
	const historyBtn = panel.querySelector("#dsh-ego-historybtn");
	const historyEl = panel.querySelector("#dsh-ego-history");
	const historyList = panel.querySelector("#dsh-ego-historylist");
	const tabsEl = panel.querySelector("#dsh-ego-tabs");
	const loginEl = panel.querySelector("#dsh-ego-login");
	const loginBtn = panel.querySelector("#dsh-ego-login-btn");
	const loginNote = panel.querySelector("#dsh-ego-login-note");
	const captchaEl = panel.querySelector("#dsh-ego-captcha");
	const captchaKindEl = panel.querySelector("#dsh-ego-captcha-kind");
	const FLUSH_ROUTE$1 = "/api/ego/flush";
	const dismissedGuides = {
		login: false,
		captcha: false
	};
	const bindGuideDismiss = (which, el) => {
		const btn = el && el.querySelector("[data-dismiss=\"" + which + "\"]");
		if (!btn) return;
		btn.addEventListener("click", () => {
			dismissedGuides[which] = true;
			el.classList.remove("show");
		});
	};
	bindGuideDismiss("login", loginEl);
	bindGuideDismiss("captcha", captchaEl);
	const setTitle = (text) => {
		const label = titleEl.querySelector("span:last-child");
		if (label) label.textContent = text;
	};
	const renderRelayDisabled = () => {
		if (disposed) return;
		setTitle(wt("title"));
		body.innerHTML = "<div class=\"dsh-ego-empty\">" + escapeHtml(wt("relayDisabledTitle")) + "<br><span style=\"font-size:11px;\">" + escapeHtml(wt("relayDisabledBody")) + "</span></div>";
		liveCount = 0;
		fab.classList.remove("dsh-ego-live", "dsh-ego-busy");
	};
	const teardownRelay = () => {
		try {
			if (sse) sse.close();
		} catch (e) {}
		sse = null;
		doConnected = false;
		stopVideo();
		stopWatch(false);
		captureBackend = "cdp";
		streamGeneration = 0;
		streamState = "idle";
		streamMessage = "";
		pageMeta.clear();
		frameCache.clear();
		lastList = [];
	};
	let disposed = false;
	let liveCount = 0;
	let historyOpen = false;
	let lastList = [];
	const setHistory = (open) => {
		historyOpen = open;
		historyEl.classList.toggle("open", open);
		panel.classList.toggle("open-drawer", open);
		historyBtn.classList.toggle("off", !open);
		historyBtn.title = open ? wt("historyHide") : wt("historyShow");
		if (open) renderHistory(lastList);
	};
	const renderHistory = (spaces) => {
		historyList.innerHTML = "";
		const list = Array.isArray(spaces) ? [...spaces].sort((a, b) => (a.lastActive ?? 0) - (b.lastActive ?? 0)) : [];
		if (list.length === 0) {
			historyList.innerHTML = `<div class="dsh-ego-hnone">${wt("noHistory")}</div>`;
			return;
		}
		for (const s of list) {
			const item = document.createElement("div");
			item.className = "dsh-ego-hitem";
			const thumbSrc = frameCache.get(s.targetId);
			const thumb = thumbSrc ? `<img class="dsh-ego-hthumb" src="${thumbSrc}" alt="">` : `<div class="dsh-ego-hthumb"></div>`;
			const active = s.targetId === currentActiveId;
			item.innerHTML = `${thumb}
							<div class="dsh-ego-hinfo">
								<div class="dsh-ego-htitle">${escapeHtml(s.title || s.url || wt("newTab"))}</div>
								<div class="dsh-ego-hurl">${escapeHtml(s.url || "(about:blank)")}</div>
								${active ? "<div class=\"dsh-ego-hactive\">● " + wt("current") + "</div>" : ""}
							</div>`;
			item.addEventListener("click", () => openPreview(s));
			historyList.appendChild(item);
		}
	};
	let pinned = null;
	let currentActiveId = null;
	let agentActiveId = null;
	let selectedTabId = null;
	let zoomState = {
		scale: 1,
		tx: 0,
		ty: 0
	};
	const frameCache = /* @__PURE__ */ new Map();
	let liveImg = null;
	let liveImgTargetId = null;
	let pendingLiveFrame = null;
	let liveFlushRaf = null;
	const pageMeta = /* @__PURE__ */ new Map();
	const watchClientId = "floating-" + Math.random().toString(36).slice(2);
	let watchStarted = false, watchTargetId = null, watchRenewTimer = null, watchStopTimer = null, watchRequest = null;
	let captureBackend = "cdp", streamGeneration = 0, streamState = "idle", streamMessage = "", streamMime = "video/mp4; codecs=\"avc1.42E01E\"", videoCleanup = null;
	const effectiveVisible = () => !panel.hidden;
	const stopVideo = () => {
		if (videoCleanup) try {
			videoCleanup();
		} catch {}
		videoCleanup = null;
	};
	const applyCaptureStatus = (status) => {
		if (!status || typeof status !== "object") return;
		if (Number.isFinite(status.generation) && status.generation < streamGeneration) return;
		if (status.generation === streamGeneration && streamState === "streaming" && status.state === "starting") return;
		const nextBackend = status.backend || captureBackend;
		const nextGeneration = status.generation ?? streamGeneration;
		const nextState = status.state || streamState;
		const nextMime = status.mime || streamMime;
		const changed = captureBackend !== nextBackend || streamGeneration !== nextGeneration || streamState !== nextState || streamMime !== nextMime;
		captureBackend = nextBackend;
		streamGeneration = nextGeneration;
		streamState = nextState;
		status.message || status.code;
		streamMime = nextMime;
		if (changed) {
			stopVideo();
			const current = lastList.find((s) => s.targetId === (selectedTabId || currentActiveId));
			if (current) renderLiveMain(current, selectedTabId !== null);
		}
	};
	const requestWatch = (route, body$1) => {
		if (watchRequest) return null;
		watchRequest = postJson(route, body$1).finally(() => {
			watchRequest = null;
		});
		return watchRequest;
	};
	const syncWatch = (targetId) => {
		if (disposed || !effectiveVisible() || !targetId) return;
		if (watchStopTimer) {
			window.clearTimeout(watchStopTimer);
			watchStopTimer = null;
		}
		if (watchStarted && watchTargetId === targetId) return;
		const request = requestWatch(watchStarted ? WATCH_SWITCH_ROUTE : WATCH_START_ROUTE, {
			clientId: watchClientId,
			targetId
		});
		if (!request) {
			watchRequest.finally(() => syncWatch(targetId));
			return;
		}
		request.then((status) => {
			watchStarted = status && status.ok !== false;
			watchTargetId = status?.targetId || targetId;
			if (watchTargetId !== targetId) {
				selectedTabId = null;
				currentActiveId = watchTargetId;
			}
			applyCaptureStatus(status);
			if (!effectiveVisible()) stopWatch(true);
		}).catch(() => {});
		if (!watchRenewTimer) watchRenewTimer = window.setInterval(() => {
			if (effectiveVisible() && watchTargetId) {
				const renewal = requestWatch(WATCH_START_ROUTE, {
					clientId: watchClientId,
					targetId: watchTargetId
				});
				if (renewal) renewal.then(applyCaptureStatus).catch(() => {});
			}
		}, 5e3);
	};
	const stopWatch = (immediate) => {
		if (watchRenewTimer) {
			window.clearInterval(watchRenewTimer);
			watchRenewTimer = null;
		}
		const stop = () => {
			watchStopTimer = null;
			watchStarted = false;
			watchTargetId = null;
			postJson(WATCH_STOP_ROUTE, { clientId: watchClientId }).catch(() => {});
		};
		if (immediate) stop();
		else {
			if (watchStopTimer) window.clearTimeout(watchStopTimer);
			watchStopTimer = window.setTimeout(stop, 1500);
		}
	};
	const INPUT_ROUTE$1 = "/api/ego/input";
	let inputBusy = false;
	/**
	* Send a pointer/wheel intention to the agent browser. Coordinates
	* are already in browser CSS pixels; the worker turns them into CDP
	* Input.dispatchMouseEvent on the page the panel is showing.
	* `type`: mouseMoved | mousePressed | mouseReleased | mouseWheel.
	*/
	const sendInput = (targetId, type, params) => {
		if (!!!targetId || type !== "mouseReleased" && type !== "keyUp" && !effectiveVisible()) return;
		if (inputBusy && type === "mouseMoved") return;
		if (type === "mouseMoved") {
			inputBusy = true;
			window.setTimeout(() => {
				inputBusy = false;
			}, 24);
		}
		fetch(INPUT_ROUTE$1, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				targetId,
				type,
				...params
			})
		}).then((res) => {
			if (res.status === 409) {
				liveImgTargetId = null;
				refresh();
			}
		}).catch(() => {});
	};
	const keyboardProxy = createKeyboardProxy((targetId, type, params) => sendInput(targetId, type, params));
	/**
	* Map an event's client coords to the agent page's CSS pixels.
	*
	* The shown <img> is the screencast frame laid out with
	* object-fit:contain, so the page fills a centered letterboxed box
	* inside the element. We find that box from the image's natural
	* (frame) size vs its rendered box, then scale into the page's CSS
	* viewport (vw/vh), which the worker attaches to each frame.
	*/
	const browserXY = (e) => {
		if (liveImgTargetId == null) return null;
		const m = pageMeta.get(liveImgTargetId);
		const vw = m?.vw, vh = m?.vh;
		if (!Number.isFinite(vw) || !Number.isFinite(vh)) return null;
		const img = liveImg;
		if (!img) return null;
		const rect = img.getBoundingClientRect();
		const natW = img.naturalWidth || img.videoWidth || rect.width;
		const natH = img.naturalHeight || img.videoHeight || rect.height;
		if (!natW || !natH) return null;
		const scale = Math.min(rect.width / natW, rect.height / natH);
		const contentW = natW * scale;
		const contentH = natH * scale;
		const ox = (rect.width - contentW) / 2;
		const oy = (rect.height - contentH) / 2;
		const rx = e.clientX - rect.left - ox;
		const ry = e.clientY - rect.top - oy;
		return {
			x: rx / contentW * vw,
			y: ry / contentH * vh
		};
	};
	const makeZoomImage = (urlEl, tagName = "img") => {
		const img = document.createElement(tagName);
		img.className = "dsh-ego-liveimg";
		if (tagName === "img") img.draggable = false;
		else {
			img.muted = true;
			img.autoplay = true;
			img.playsInline = true;
		}
		img.title = "滚轮缩放 · 按住拖动平移 · 缩小到最小或双击复位";
		const realText = urlEl ? urlEl.textContent : "";
		let hintTimer = null;
		const clearHint = () => {
			if (hintTimer) {
				window.clearTimeout(hintTimer);
				hintTimer = null;
			}
		};
		const showHint = (txt) => {
			if (!urlEl) return;
			urlEl.textContent = txt;
			urlEl.classList.add("dsh-ego-hint");
			clearHint();
			hintTimer = window.setTimeout(() => {
				urlEl.textContent = realText;
				urlEl.classList.remove("dsh-ego-hint");
				hintTimer = null;
			}, 2e3);
		};
		const apply$1 = () => {
			img.style.transformOrigin = "0 0";
			img.style.transform = `translate(${zoomState.tx}px, ${zoomState.ty}px) scale(${zoomState.scale})`;
		};
		let viewPanning = false;
		let browserDrag = false;
		let sx = 0, sy = 0, stx = 0, sty = 0;
		let lastDragPos = null;
		let dragTargetId = null;
		let downButtons = 0;
		const resetView = () => {
			zoomState = {
				scale: 1,
				tx: 0,
				ty: 0
			};
			apply$1();
			showHint(wt("hintReset"));
		};
		img.title = wt("hintReset");
		img.addEventListener("wheel", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (e.ctrlKey || e.metaKey) {
				const rect = img.getBoundingClientRect();
				const mx = e.clientX - rect.left, my = e.clientY - rect.top;
				const next = Math.min(8, Math.max(1, zoomState.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
				if (next <= 1) {
					resetView();
					return;
				}
				zoomState.tx = mx - (mx - zoomState.tx) * (next / zoomState.scale);
				zoomState.ty = my - (my - zoomState.ty) * (next / zoomState.scale);
				zoomState.scale = next;
				apply$1();
				showHint(wt("hintPan"));
				return;
			}
			const p = browserXY(e);
			if (p && liveImgTargetId) sendInput(liveImgTargetId, "mouseWheel", {
				x: p.x,
				y: p.y,
				deltaX: e.deltaX || 0,
				deltaY: e.deltaY || (e.deltaMode === 1 ? 40 : e.deltaY || 100)
			});
		}, { passive: false });
		img.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			img.setPointerCapture(e.pointerId);
			sx = e.clientX;
			sy = e.clientY;
			stx = zoomState.tx;
			sty = zoomState.ty;
			if (e.ctrlKey || e.metaKey) {
				viewPanning = true;
				img.style.cursor = "grabbing";
				showHint(wt("hintScroll"));
				return;
			}
			browserDrag = true;
			dragTargetId = liveImgTargetId;
			keyboardProxy.focusAt(e, dragTargetId);
			lastDragPos = null;
			downButtons = 1;
			const p = browserXY(e);
			if (p) {
				lastDragPos = p;
				sendInput(dragTargetId, "mousePressed", {
					x: p.x,
					y: p.y,
					button: "left",
					buttons: 1,
					clickCount: 1
				});
			}
		});
		img.addEventListener("pointermove", (e) => {
			if (viewPanning) {
				zoomState.tx = stx + (e.clientX - sx);
				zoomState.ty = sty + (e.clientY - sy);
				apply$1();
				return;
			}
			if (!browserDrag) {
				const p$1 = browserXY(e);
				if (p$1) sendInput(liveImgTargetId, "mouseMoved", {
					x: p$1.x,
					y: p$1.y,
					buttons: 0
				});
				return;
			}
			const p = browserXY(e);
			if (p) {
				sendInput(dragTargetId, "mouseMoved", {
					x: p.x,
					y: p.y,
					buttons: downButtons
				});
				lastDragPos = p;
			}
		});
		const stopDrag = (e) => {
			if (viewPanning) {
				viewPanning = false;
				img.style.cursor = e.ctrlKey ? "grab" : "grab";
			}
			if (browserDrag) {
				browserDrag = false;
				if (lastDragPos && dragTargetId) sendInput(dragTargetId, "mouseReleased", {
					x: lastDragPos.x,
					y: lastDragPos.y,
					button: "left",
					buttons: 0,
					clickCount: 1
				});
				dragTargetId = null;
			}
			img.style.cursor = "grab";
		};
		img.addEventListener("pointerup", stopDrag);
		img.addEventListener("pointercancel", stopDrag);
		img.addEventListener("pointerleave", (e) => {
			if (browserDrag || viewPanning) stopDrag(e);
		});
		img.addEventListener("dblclick", (e) => {
			e.preventDefault();
			resetView();
		});
		img.style.cursor = "grab";
		apply$1();
		return img;
	};
	const renderTabs = (spaces) => {
		tabsEl.innerHTML = "";
		const list = Array.isArray(spaces) ? spaces : [];
		if (list.length === 0) {
			if (selectedTabId) selectedTabId = null;
			return;
		}
		for (const s of list) {
			const tab = document.createElement("div");
			tab.className = "dsh-ego-tab";
			tab.title = s.url || "";
			tab.__tid = s.targetId;
			const dot = document.createElement("span");
			dot.className = "dsh-ego-tabdot";
			const txt = document.createElement("span");
			txt.className = "dsh-ego-tabtxt";
			txt.textContent = s.title || s.url || wt("newTab");
			tab.appendChild(dot);
			tab.appendChild(txt);
			const closeBtn$1 = document.createElement("span");
			closeBtn$1.className = "dsh-ego-tabclose";
			closeBtn$1.title = wt("closeTab");
			closeBtn$1.textContent = "×";
			closeBtn$1.addEventListener("click", (e) => {
				e.stopPropagation();
				(async () => {
					try {
						await fetch(EGO_CLOSE_ROUTE, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ targetId: s.targetId })
						});
					} catch {}
					if (selectedTabId === s.targetId) {
						selectedTabId = null;
						pinned = null;
					}
				})().then(() => refresh());
			});
			tab.appendChild(closeBtn$1);
			if (s.targetId === selectedTabId || selectedTabId === null && s.targetId === currentActiveId) tab.classList.add("active");
			tab.addEventListener("click", () => {
				if (selectedTabId === s.targetId) {
					selectedTabId = null;
					pinned = null;
					renderSpaces(lastList);
					return;
				}
				selectedTabId = s.targetId;
				pinned = null;
				renderLiveMain(s, true);
				syncWatch(s.targetId);
				[...tabsEl.querySelectorAll(".dsh-ego-tab")].forEach((t) => t.classList.toggle("active", t.__tid === s.targetId));
			});
			tabsEl.appendChild(tab);
		}
	};
	const renderSingleView = (s) => {
		body.innerHTML = "";
		const view = document.createElement("div");
		view.className = "dsh-ego-liveview";
		const badge = document.createElement("div");
		badge.className = "dsh-ego-livebadge";
		badge.innerHTML = pinned ? `<span class="dsh-ego-state-dot pin"></span> ${wt("pinned")}` : `<span class="dsh-ego-state-dot${fab.classList.contains("dsh-ego-busy") ? " busy" : ""}"></span> ${wt("realtime")}`;
		view.appendChild(badge);
		if (pinned) {
			const back = document.createElement("button");
			back.className = "dsh-ego-back";
			back.type = "button";
			back.textContent = wt("backToLive");
			back.addEventListener("click", () => {
				pinned = null;
				renderSpaces(lastList);
			});
			badge.appendChild(back);
		}
		const t = document.createElement("div");
		t.className = "dsh-ego-livetitle";
		t.textContent = s.title || s.url || wt("newTab");
		const u = document.createElement("div");
		u.className = "dsh-ego-liveurl";
		u.textContent = s.url || "";
		const cached = frameCache.get(s.targetId);
		if (captureBackend === "ffmpeg" || cached) {
			const img = makeZoomImage(u, captureBackend === "ffmpeg" ? "video" : "img");
			if (captureBackend === "ffmpeg" && streamState === "streaming") {
				stopVideo();
				videoCleanup = createMsePlayer(img, streamGeneration, streamMime, (message) => {});
			} else img.src = cached;
			img.alt = "live";
			attachLiveImg(s.targetId, img);
			view.appendChild(img);
		} else {
			const n = document.createElement("div");
			n.className = "dsh-ego-liveurl";
			n.textContent = wt("noScreenshot");
			view.appendChild(n);
		}
		view.appendChild(t);
		view.appendChild(u);
		body.appendChild(view);
	};
	const openPreview = (s) => {
		if (disposed) return;
		pinned = s;
		renderSingleView(s);
	};
	const renderSpaces = (spaces) => {
		if (disposed) return;
		lastList = Array.isArray(spaces) ? spaces : [];
		for (const s of lastList) {
			const prev = pageMeta.get(s.targetId) || { targetId: s.targetId };
			pageMeta.set(s.targetId, {
				url: s.url,
				title: s.title,
				targetId: s.targetId,
				...Number.isFinite(s.viewportW) ? { vw: s.viewportW } : prev.vw !== void 0 ? { vw: prev.vw } : {},
				...Number.isFinite(s.viewportH) ? { vh: s.viewportH } : prev.vh !== void 0 ? { vh: prev.vh } : {}
			});
		}
		const liveIds = new Set(lastList.map((s) => s.targetId));
		for (const id of [...pageMeta.keys()]) if (!liveIds.has(id)) pageMeta.delete(id);
		for (const id of [...frameCache.keys()]) if (!liveIds.has(id)) frameCache.delete(id);
		const sorted = [...lastList].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
		const activeMarked = lastList.find((s) => s.active === true) || sorted[0] || null;
		if (activeMarked) {
			agentActiveId = activeMarked.targetId;
			currentActiveId = activeMarked.targetId;
		}
		maybeShowLoginGuide();
		maybeShowCaptchaGuide();
		renderTabs(lastList);
		if (historyOpen) renderHistory(lastList);
		if (pinned) return;
		if (lastList.length === 0) {
			if (frameRelayDisabled) {
				renderRelayDisabled();
				return;
			}
			setTitle("Agent 浏览器");
			body.innerHTML = `<div class="dsh-ego-empty">${wt("noActivePages")}<br><span style="font-size:11px;">${wt("noActiveHint")}</span></div>`;
			fab.classList.remove("dsh-ego-live", "dsh-ego-busy");
			return;
		}
		lastList.length;
		fab.classList.add("dsh-ego-live");
		const busy = lastList.some((s) => Date.now() - (s.lastActive || 0) <= ACTIVE_WINDOW_MS);
		if (busy !== lastSawActive) {
			fab.classList.toggle("dsh-ego-busy", busy);
			lastSawActive = busy;
		} else fab.classList.remove("dsh-ego-busy");
		const sel = selectedTabId !== null ? lastList.find((x) => x.targetId === selectedTabId) : null;
		const current = sel || activeMarked;
		currentActiveId = current.targetId;
		syncWatch(current.targetId);
		setTitle(sel ? wt("title") : wt("titleLive"));
		renderLiveMain(current, sel);
	};
	const attachLiveImg = (targetId, img) => {
		liveImg = img;
		liveImgTargetId = targetId;
		const cached = frameCache.get(targetId);
		if (cached) img.src = cached;
	};
	const renderLiveMain = (current, isPinned) => {
		body.innerHTML = "";
		const view = document.createElement("div");
		view.className = "dsh-ego-liveview";
		const badge = document.createElement("div");
		badge.className = "dsh-ego-livebadge";
		badge.innerHTML = isPinned ? `<span class="dsh-ego-state-dot pin"></span> ${wt("pinned")}` : `<span class="dsh-ego-state-dot${fab.classList.contains("dsh-ego-busy") ? " busy" : ""}"></span> ${wt("realtime")}`;
		view.appendChild(badge);
		const t = document.createElement("div");
		t.className = "dsh-ego-livetitle";
		t.textContent = current.title || current.url || wt("newTab");
		const u = document.createElement("div");
		u.className = "dsh-ego-liveurl";
		u.textContent = current.url || "";
		const openHere = document.createElement("button");
		openHere.type = "button";
		openHere.className = "dsh-ego-back";
		openHere.title = wt("openExternal");
		openHere.textContent = wt("openExternal");
		openHere.addEventListener("click", () => {
			const url = current.url;
			if (url && !url.startsWith("about:") && !url.startsWith("chrome://")) window.open(url, "_blank", "noopener");
			else openHere.textContent = wt("noUrl");
		});
		badge.appendChild(openHere);
		const raiseBtn = document.createElement("button");
		raiseBtn.type = "button";
		raiseBtn.className = "dsh-ego-back";
		raiseBtn.title = wt("raiseWindowHint");
		raiseBtn.textContent = wt("raiseWindow");
		raiseBtn.addEventListener("click", () => {
			fetch("/api/ego/raise", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}"
			}).then((r) => r.json().catch(() => null)).catch(() => null);
		});
		badge.appendChild(raiseBtn);
		const cached = frameCache.get(current.targetId);
		if (captureBackend === "ffmpeg" || cached) {
			const img = makeZoomImage(u, captureBackend === "ffmpeg" ? "video" : "img");
			if (captureBackend === "ffmpeg" && streamState === "streaming") {
				stopVideo();
				videoCleanup = createMsePlayer(img, streamGeneration, streamMime, (message) => {});
			} else img.src = cached;
			img.alt = "live";
			attachLiveImg(current.targetId, img);
			view.appendChild(img);
		} else {
			const n = document.createElement("div");
			n.className = "dsh-ego-liveurl";
			n.textContent = wt("noScreenshot");
			view.appendChild(n);
		}
		view.appendChild(t);
		view.appendChild(u);
		body.appendChild(view);
	};
	let lastSawActive = false;
	const refresh = () => {
		if (frameRelayDisabled) {
			renderRelayDisabled();
			return;
		}
		(async () => {
			try {
				const res = await fetch(SPACES_ROUTE, { cache: "no-store" });
				if (disposed || !res.ok) {
					renderEmpty();
					return;
				}
				const data = await res.json();
				if (!data || data.ok !== true) {
					renderEmpty();
					return;
				}
				applyCaptureStatus(data.capture);
				renderSpaces(data.spaces);
			} catch {
				renderEmpty();
			}
		})();
	};
	const renderEmpty = () => {
		if (body.children.length === 0) renderSpaces([]);
	};
	let sse = null;
	let lastFrameAt = 0;
	const FRAME_FOLLOW_MIN_MS$1 = 350;
	let followTimer = null;
	const applyFrame = (targetId, dataUrl, vw, vh) => {
		if (disposed) return;
		frameCache.set(targetId, dataUrl);
		const MAX_CACHED_FRAMES = 12;
		if (frameCache.size > MAX_CACHED_FRAMES) for (const [id] of frameCache) {
			if (id === targetId || id === liveImgTargetId) continue;
			frameCache.delete(id);
			if (frameCache.size <= MAX_CACHED_FRAMES) break;
		}
		if (Number.isFinite(vw) && Number.isFinite(vh)) {
			const cur = pageMeta.get(targetId) || { targetId };
			pageMeta.set(targetId, {
				...cur,
				vw,
				vh
			});
		}
		if (liveImg && liveImgTargetId === targetId) {
			pendingLiveFrame = dataUrl;
			if (!liveFlushRaf && !disposed) liveFlushRaf = window.requestAnimationFrame(() => {
				liveFlushRaf = null;
				if (disposed || !liveImg || pendingLiveFrame == null) return;
				try {
					liveImg.src = pendingLiveFrame;
				} catch {}
				pendingLiveFrame = null;
			});
			return;
		}
		if (!pinned && selectedTabId === null && targetId === agentActiveId) {
			const now = Date.now();
			if (now - lastFrameAt >= FRAME_FOLLOW_MIN_MS$1) {
				lastFrameAt = now;
				if (followTimer) window.clearTimeout(followTimer);
				followTimer = window.setTimeout(() => {
					if (disposed || pinned || selectedTabId !== null) return;
					if (liveImg && liveImgTargetId === targetId) return;
					const meta = pageMeta.get(targetId);
					if (!meta) return;
					currentActiveId = targetId;
					renderLiveMain({
						...meta,
						targetId
					}, false);
				}, 0);
			}
		}
	};
	let reconnectFallbackTimer = null;
	const openStream = () => {
		if (disposed || frameRelayDisabled) {
			if (frameRelayDisabled) renderRelayDisabled();
			return;
		}
		fetch(WATCH_STATUS_ROUTE, { cache: "no-store" }).then((res) => res.ok ? res.json() : null).then((status) => {
			if (disposed) return;
			if (frameRelayOff(status)) {
				teardownRelay();
				renderRelayDisabled();
				return;
			}
			applyCaptureStatus(status);
			connectStream();
		}).catch(() => {
			if (!disposed && !frameRelayDisabled) connectStream();
		});
	};
	const connectStream = () => {
		if (disposed || frameRelayDisabled || sse) return;
		doConnected = false;
		sse = new EventSource("/api/ego/stream");
		sse.onopen = () => {
			doConnected = true;
		};
		sse.addEventListener("frame", (ev) => {
			try {
				const m = JSON.parse(ev.data);
				if (!m || !m.targetId || !m.data) return;
				if (Number.isFinite(m.vw) && Number.isFinite(m.vh)) {
					const cur = pageMeta.get(m.targetId) || { targetId: m.targetId };
					pageMeta.set(m.targetId, {
						...cur,
						vw: m.vw,
						vh: m.vh
					});
				}
				applyFrame(m.targetId, `data:image/jpeg;base64,${m.data}`, m.vw, m.vh);
			} catch {}
		});
		sse.addEventListener("spaces", (ev) => {
			if (disposed) return;
			try {
				const list = JSON.parse(ev.data);
				if (Array.isArray(list)) renderSpaces(list);
			} catch {}
		});
		sse.addEventListener("capture-status", (ev) => {
			try {
				applyCaptureStatus(JSON.parse(ev.data));
			} catch {}
		});
		sse.onerror = () => {
			doConnected = false;
			if (reconnectFallbackTimer) return;
			reconnectFallbackTimer = window.setTimeout(() => {
				reconnectFallbackTimer = null;
				if (disposed) return;
				refresh();
			}, 1500);
		};
	};
	let doConnected = false;
	const DRAG_KEY = "dsh.ego.watch.pos";
	const DRAG_PANEL_KEY = "dsh.ego.watch.panelPos";
	const FAB_W = 48, FAB_H = 48;
	const PANEL_W = 408, PANEL_GAP = 8;
	const loadPos = (key) => {
		try {
			const s = JSON.parse(localStorage.getItem(key) || "null");
			if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) return s;
		} catch {}
		return null;
	};
	let pos = loadPos(DRAG_KEY) || {
		x: window.innerWidth - 18 - FAB_W,
		y: window.innerHeight - 104 - FAB_H
	};
	let panelPos = loadPos(DRAG_PANEL_KEY);
	const clampFab = () => {
		const vw = window.innerWidth, vh = window.innerHeight;
		pos.x = Math.max(4, Math.min(vw - FAB_W - 4, pos.x));
		pos.y = Math.max(4, Math.min(vh - FAB_H - 4, pos.y));
	};
	const placeFab = () => {
		clampFab();
		fab.style.left = pos.x + "px";
		fab.style.top = pos.y + "px";
	};
	const placePanel = () => {
		panel.style.left = panelPos.x + "px";
		panel.style.top = panelPos.y + "px";
	};
	/** Position the panel against the ball: just above it (below when near
	*  the top edge), clamped inside the viewport. */
	const snapPanelToFab = () => {
		const vw = window.innerWidth, vh = window.innerHeight;
		const pw = panel.classList.contains("open-drawer") ? 640 : PANEL_W;
		const ph = panel.offsetHeight > 0 ? panel.offsetHeight : Math.min(Math.round(vh * .7), 520);
		let px = pos.x + FAB_W - pw;
		let py = pos.y - ph - PANEL_GAP;
		if (py < 8) py = pos.y + FAB_H + PANEL_GAP;
		px = Math.max(8, Math.min(vw - pw - 8, px));
		py = Math.max(8, Math.min(vh - ph - 8, py));
		panelPos = {
			x: Math.round(px),
			y: Math.round(py)
		};
		placePanel();
	};
	placeFab();
	if (panelPos) placePanel();
	let suppressFabClick = false;
	/**
	* Make `el` drag the FAB or the panel (`which` = 'fab' | 'panel').
	* Movement under ~5px is treated as a click, so the FAB still toggles.
	* Interactive children (buttons/icons) never start a drag.
	*/
	const makeDraggable = (el, which) => {
		const state = () => which === "fab" ? pos : panelPos;
		let sx = 0, sy = 0, bx = 0, by = 0, active = false, dragged = false;
		const down = (e) => {
			if (e.button !== 0) return;
			if (e.target && e.target.closest) {
				const hit = e.target.closest("button, a, input, [role=\"button\"]");
				if (hit && hit !== el) return;
			}
			active = true;
			dragged = false;
			sx = e.clientX;
			sy = e.clientY;
			const s = state();
			bx = s.x;
			by = s.y;
			try {
				el.setPointerCapture(e.pointerId);
			} catch {}
			el.classList.add("dsh-ego-dragging");
			e.preventDefault();
		};
		const move = (e) => {
			if (!active) return;
			const dx = e.clientX - sx, dy = e.clientY - sy;
			if (!dragged && Math.abs(dx) + Math.abs(dy) > 5) dragged = true;
			if (dragged) {
				const s = state();
				s.x = bx + dx;
				s.y = by + dy;
				which === "fab" ? placeFab() : placePanel();
			}
		};
		const up = (e) => {
			if (!active) return;
			active = false;
			el.classList.remove("dsh-ego-dragging");
			try {
				el.releasePointerCapture(e.pointerId);
			} catch {}
			if (dragged) {
				if (which === "fab") suppressFabClick = true;
				try {
					localStorage.setItem(which === "fab" ? DRAG_KEY : DRAG_PANEL_KEY, JSON.stringify(state()));
				} catch {}
			}
		};
		el.addEventListener("pointerdown", down);
		el.addEventListener("pointermove", move);
		el.addEventListener("pointerup", up);
		el.addEventListener("pointercancel", up);
	};
	makeDraggable(fab, "fab");
	makeDraggable(panel.querySelector("#dsh-ego-head"), "panel");
	const setOpen = (open) => {
		if (open) {
			panel.hidden = false;
			panel.classList.remove("dsh-ego-panel-hide");
			snapPanelToFab();
			panel.offsetHeight;
			panel.classList.add("dsh-ego-panel-open");
			fab.classList.add("on");
			refresh();
			openStream();
			if (currentActiveId) syncWatch(selectedTabId || currentActiveId);
		} else {
			panel.classList.remove("dsh-ego-panel-open");
			clearTimeout(panel._dshHideT);
			panel._dshHideT = setTimeout(() => {
				panel.classList.add("dsh-ego-panel-hide");
				panel.hidden = true;
				fab.classList.remove("on");
			}, 280);
			try {
				if (sse) sse.close();
			} catch {}
			sse = null;
			stopWatch(false);
			stopVideo();
		}
		try {
			localStorage.setItem(OPEN_KEY, open ? "1" : "0");
		} catch {}
	};
	fab.addEventListener("click", () => {
		if (suppressFabClick) {
			suppressFabClick = false;
			return;
		}
		setOpen(panel.hidden);
	});
	closeBtn.addEventListener("click", () => setOpen(false));
	refreshBtn.addEventListener("click", () => {
		refreshBtn.classList.add("spinning");
		window.setTimeout(() => refreshBtn.classList.remove("spinning"), 800);
		refresh();
	});
	historyBtn.addEventListener("click", () => setHistory(!historyOpen));
	const maybeShowLoginGuide = () => {
		if (disposed || dismissedGuides.login) return;
		const show = lastList.some((s) => s.url && !s.url.startsWith("about:")) && !captchaEl.classList.contains("show");
		loginEl.classList.toggle("show", show);
		loginNote.textContent = "";
	};
	const maybeShowCaptchaGuide = () => {
		if (disposed || dismissedGuides.captcha) return;
		const hit = lastList.find((s) => s.humanCheck && s.humanCheck.detected);
		const show = !!hit;
		captchaEl.classList.toggle("show", show);
		if (show && captchaKindEl) captchaKindEl.textContent = hit.humanCheck.kind || "captcha";
	};
	loginBtn.addEventListener("click", () => {
		(async () => {
			loginBtn.classList.add("saving");
			loginBtn.textContent = wt("loginSaving");
			try {
				const j = await (await fetch(FLUSH_ROUTE$1, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}"
				})).json();
				if (j && j.ok) loginNote.textContent = wt("loginSaved", { n: j.total ?? "" });
				else loginNote.textContent = j?.error ? wt("loginNotConnected") : wt("loginFailed");
			} catch {
				loginNote.textContent = wt("loginFailed");
			} finally {
				loginBtn.classList.remove("saving");
				loginBtn.textContent = wt("loginBtn");
			}
		})();
	});
	document.body.appendChild(fab);
	document.body.appendChild(panel);
	try {
		localStorage.removeItem(OPEN_KEY);
	} catch {}
	panel.hidden = true;
	fab.classList.remove("on");
	refresh();
	const onVisibility = () => {
		if (document.visibilityState !== "hidden" && !panel.hidden) {
			if (!sse) openStream();
			syncWatch(selectedTabId || currentActiveId);
		}
	};
	document.addEventListener("visibilitychange", onVisibility);
	const offRelayWatch = frameRelaySubscribe((disabled) => {
		if (disposed) return;
		if (disabled) {
			teardownRelay();
			renderRelayDisabled();
			return;
		}
		openStream();
		refresh();
	});
	return () => {
		disposed = true;
		offRelayWatch();
		if (liveFlushRaf != null) try {
			window.cancelAnimationFrame(liveFlushRaf);
		} catch {}
		if (followTimer) window.clearTimeout(followTimer);
		if (reconnectFallbackTimer) window.clearTimeout(reconnectFallbackTimer);
		document.removeEventListener("visibilitychange", onVisibility);
		if (watchRenewTimer) window.clearInterval(watchRenewTimer);
		if (watchStopTimer) window.clearTimeout(watchStopTimer);
		stopWatch(true);
		stopVideo();
		keyboardProxy.dispose();
		try {
			if (sse) sse.close();
		} catch {}
		fab.remove();
		panel.remove();
		style.remove();
	};
}
var INPUT_ROUTE = "/api/ego/input";
var FLUSH_ROUTE = "/api/ego/flush";
var FRAME_FOLLOW_MIN_MS = 350;
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
}
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
.dsh-ego-side-liveimg {
  width: 100%; border-radius: 9px; display: block;
  max-height: 50vh; object-fit: contain;
  border: 1px solid rgba(128,128,128,.2); background: #000;
  user-select: none; -webkit-user-select: none; touch-action: none;
  will-change: transform; cursor: grab;
}
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
`;
function LivePreviewController(ctx) {
	this.ctx = ctx;
	this.store = createSnapshotStore(this._initialState());
	this.frameCache = /* @__PURE__ */ new Map();
	this.pageMeta = /* @__PURE__ */ new Map();
	this.lastList = [];
	this.pinned = null;
	this.currentActiveId = null;
	this.agentActiveId = null;
	this.selectedTabId = null;
	this.zoomState = {
		scale: 1,
		tx: 0,
		ty: 0
	};
	this.liveCount = 0;
	this.disposed = false;
	this.visible = false;
	this.clientId = "sidebar-" + Math.random().toString(36).slice(2);
	this.watchStarted = false;
	this.watchTargetId = null;
	this.watchRenewTimer = null;
	this.watchStopTimer = null;
	this.watchRequest = null;
	this.backend = "cdp";
	this.streamGeneration = 0;
	this.streamState = "idle";
	this.streamMessage = "";
	this.streamMime = "video/mp4; codecs=\"avc1.42E01E\"";
	this.liveVideo = null;
	this.videoCleanup = null;
	this.documentVisible = document.visibilityState !== "hidden";
	this.onDocumentVisibility = this._handleDocumentVisibility.bind(this);
	this.sse = null;
	this.reconnectFallbackTimer = null;
	this.lastSawActive = false;
	this.lastFrameAt = 0;
	this.followTimer = null;
	this.pendingLiveFrame = null;
	this.liveFlushRaf = null;
	this.liveImg = null;
	this.liveImgTargetId = null;
	this.wiringStale = false;
	this._lastUnwiredAt = 0;
	this._wiredRecomputeQueued = false;
	this.historyOpen = false;
	this._zoomHint = null;
	this._zoomHintTimer = null;
	this._pointerState = null;
	var self = this;
	this.keyboardProxy = createKeyboardProxy(function(targetId, type, params) {
		self.sendInput(targetId, type, params);
	});
	this.dismissedGuides = {
		login: false,
		captcha: false
	};
}
LivePreviewController.prototype._initialState = function() {
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
		backend: "cdp",
		streamState: "idle",
		streamMessage: "",
		streamGeneration: 0,
		streamMime: "video/mp4; codecs=\"avc1.42E01E\"",
		relayDisabled: false
	};
};
LivePreviewController.prototype.subscribe = function(cb) {
	return this.store.subscribe(cb);
};
LivePreviewController.prototype.getSnapshot = function() {
	return this.store.getSnapshot();
};
LivePreviewController.prototype._recompute = function() {
	var hasPage = this.lastList.some(function(s) {
		return s.url && !s.url.startsWith("about:");
	});
	var captchaHit = this.lastList.find(function(s) {
		return s.humanCheck && s.humanCheck.detected;
	});
	var self = this;
	var currentSpace = null;
	var currentTargetId = null;
	if (this.pinned) {
		currentSpace = this.pinned;
		currentTargetId = this.pinned.targetId;
	} else if (this.selectedTabId !== null) {
		currentSpace = this.lastList.find(function(s) {
			return s.targetId === self.selectedTabId;
		}) || null;
		currentTargetId = this.selectedTabId;
		if (currentSpace && !currentSpace.thumbnail) {
			var cached = this.frameCache.get(currentTargetId);
			if (cached) currentSpace = Object.assign({}, currentSpace, { thumbnail: cached });
		}
	} else {
		var activeMarked = this.lastList.find(function(s) {
			return s.active === true;
		});
		if (!activeMarked && this.lastList.length > 0) activeMarked = this.lastList.slice().sort(function(a, b) {
			return (b.lastActive || 0) - (a.lastActive || 0);
		})[0];
		if (activeMarked) {
			currentSpace = Object.assign({}, activeMarked);
			currentTargetId = activeMarked.targetId;
			if (!currentSpace.thumbnail) {
				var cached2 = this.frameCache.get(currentTargetId);
				if (cached2) currentSpace.thumbnail = cached2;
			}
		}
	}
	this.currentActiveId = currentTargetId;
	this.wiringStale = currentTargetId != null && this.liveImgTargetId !== currentTargetId;
	var showLogin = hasPage && !captchaHit && !this.dismissedGuides.login;
	var captchaKind = captchaHit && !this.dismissedGuides.captcha ? captchaHit.humanCheck.kind || "captcha" : null;
	this.store.update(function(s) {
		s.spaces = self.lastList;
		s.pinned = self.pinned;
		s.selectedTabId = self.selectedTabId;
		s.currentTargetId = currentTargetId;
		s.currentSpace = currentSpace;
		s.liveCount = self.liveCount;
		s.busy = self.lastSawActive;
		s.showLoginGuide = showLogin;
		s.captchaKind = captchaKind;
		s.historyOpen = self.historyOpen;
		s.zoomHint = self._zoomHint;
		s.wiringStale = self.wiringStale;
		s.backend = self.backend;
		s.streamState = self.streamState;
		s.streamMessage = self.streamMessage;
		s.streamGeneration = self.streamGeneration;
		s.streamMime = self.streamMime;
		s.relayDisabled = frameRelayDisabled;
	});
	this._syncWatch(currentTargetId);
};
LivePreviewController.prototype.start = function() {
	document.addEventListener("visibilitychange", this.onDocumentVisibility);
	var self = this;
	this.offRelayWatch = frameRelaySubscribe(function(disabled) {
		self._onRelayChange(disabled);
	});
	this._recompute();
	if (this.visible) {
		this.refresh();
		this.openStream();
	}
};
LivePreviewController.prototype._onRelayChange = function(disabled) {
	if (this.disposed) return;
	if (disabled) {
		this.closeStream();
		this._destroyVideo();
		this._stopWatch(false);
		this.lastList = [];
		this.pageMeta.clear();
		this.frameCache.clear();
		this.streamState = "idle";
		this.streamMessage = "";
	}
	this._recompute();
	if (!disabled && this.visible) {
		this.refresh();
		this.openStream();
		this._syncWatch(this.currentActiveId);
	}
};
LivePreviewController.prototype.dispose = function() {
	this.keyboardProxy.dispose();
	this.disposed = true;
	if (this.offRelayWatch) {
		try {
			this.offRelayWatch();
		} catch (e) {}
		this.offRelayWatch = null;
	}
	if (this.liveFlushRaf != null) try {
		window.cancelAnimationFrame(this.liveFlushRaf);
	} catch (e) {}
	if (this.followTimer) window.clearTimeout(this.followTimer);
	if (this.reconnectFallbackTimer) window.clearTimeout(this.reconnectFallbackTimer);
	if (this._zoomHintTimer) window.clearTimeout(this._zoomHintTimer);
	document.removeEventListener("visibilitychange", this.onDocumentVisibility);
	if (this.watchRenewTimer) window.clearInterval(this.watchRenewTimer);
	if (this.watchStopTimer) window.clearTimeout(this.watchStopTimer);
	this._stopWatch(true);
	this._destroyVideo();
	this.closeStream();
};
LivePreviewController.prototype._handleDocumentVisibility = function() {
	this.documentVisible = document.visibilityState !== "hidden";
	if (this.documentVisible && this.visible) {
		this.refresh();
		if (!this.sse) this.openStream();
		this._syncWatch(this.currentActiveId);
	}
};
LivePreviewController.prototype.setVisible = function(v) {
	this.visible;
	this.visible = v;
	if (v) {
		this.refresh();
		this.openStream();
		this._syncWatch(this.currentActiveId);
	} else {
		this.closeStream();
		this._stopWatch(false);
		this._destroyVideo();
	}
};
LivePreviewController.prototype._requestWatch = function(route, body) {
	if (this.watchRequest) return null;
	var self = this;
	this.watchRequest = postJson(route, body).finally(function() {
		self.watchRequest = null;
	});
	return this.watchRequest;
};
LivePreviewController.prototype._applyCaptureStatus = function(status) {
	if (!status || typeof status !== "object") return;
	if (Number.isFinite(status.generation) && status.generation < this.streamGeneration) return;
	if (status.generation === this.streamGeneration && this.streamState === "streaming" && status.state === "starting") return;
	var nextBackend = status.backend || this.backend;
	var nextGeneration = status.generation ?? this.streamGeneration;
	var nextState = status.state || this.streamState;
	var generationChanged = this.streamGeneration !== nextGeneration;
	this.backend = nextBackend;
	this.streamState = nextState;
	this.streamMessage = status.message || status.code || "";
	this.streamGeneration = nextGeneration;
	this.streamMime = status.mime || this.streamMime;
	if (generationChanged || this.backend !== "ffmpeg") this._destroyVideo();
	this._recompute();
};
LivePreviewController.prototype._syncWatch = function(targetId) {
	if (this.disposed || !this.visible || !targetId) return;
	var self = this;
	if (this.watchStopTimer) {
		window.clearTimeout(this.watchStopTimer);
		this.watchStopTimer = null;
	}
	var route = this.watchStarted ? WATCH_SWITCH_ROUTE : WATCH_START_ROUTE;
	if (this.watchStarted && this.watchTargetId === targetId) return;
	var body = {
		clientId: this.clientId,
		targetId
	};
	var request = this._requestWatch(route, body);
	if (!request) {
		this.watchRequest.finally(function() {
			self._syncWatch(targetId);
		});
		return;
	}
	request.then(function(status) {
		self.watchStarted = status && status.ok !== false;
		self.watchTargetId = status && status.targetId || targetId;
		if (self.watchTargetId !== targetId) {
			self.selectedTabId = null;
			self.currentActiveId = self.watchTargetId;
		}
		self._applyCaptureStatus(status);
		if (!self.visible) self._stopWatch(true);
	}).catch(function() {});
	if (!this.watchRenewTimer) this.watchRenewTimer = window.setInterval(function() {
		if (self.visible && self.watchTargetId) {
			var renewal = self._requestWatch(WATCH_START_ROUTE, {
				clientId: self.clientId,
				targetId: self.watchTargetId
			});
			if (renewal) renewal.then(function(status) {
				self._applyCaptureStatus(status);
			}).catch(function() {});
		}
	}, 5e3);
};
LivePreviewController.prototype._stopWatch = function(immediate) {
	var self = this;
	if (this.watchRenewTimer) {
		window.clearInterval(this.watchRenewTimer);
		this.watchRenewTimer = null;
	}
	var stop = function() {
		self.watchStopTimer = null;
		self.watchStarted = false;
		self.watchTargetId = null;
		postJson(WATCH_STOP_ROUTE, { clientId: self.clientId }).catch(function() {});
	};
	if (immediate) stop();
	else {
		if (this.watchStopTimer) window.clearTimeout(this.watchStopTimer);
		this.watchStopTimer = window.setTimeout(stop, 1500);
	}
};
LivePreviewController.prototype._destroyVideo = function() {
	if (this.videoCleanup) try {
		this.videoCleanup();
	} catch (e) {}
	this.videoCleanup = null;
	this.liveVideo = null;
};
LivePreviewController.prototype.setLiveVideo = function(video, targetId) {
	this._destroyVideo();
	this.liveVideo = video;
	this.liveImg = video;
	this.liveImgTargetId = targetId;
	if (!video || this.backend !== "ffmpeg" || this.streamState !== "streaming") return;
	var self = this;
	this.videoCleanup = createMsePlayer(video, this.streamGeneration, this.streamMime, function(message) {
		self.streamState = "failed";
		self.streamMessage = message;
		self._recompute();
	});
};
LivePreviewController.prototype.setLiveImg = function(img, targetId) {
	this.liveImg = img;
	this.liveImgTargetId = targetId;
	if (img && targetId != null) {
		var cached = this.frameCache.get(targetId);
		if (cached) try {
			img.src = cached;
		} catch (e) {}
	}
};
LivePreviewController.prototype.refresh = function() {
	var self = this;
	if (frameRelayDisabled) {
		self.lastList = [];
		self.pageMeta.clear();
		self.frameCache.clear();
		self._recompute();
		return;
	}
	(async function() {
		try {
			var res = await fetch(SPACES_ROUTE, { cache: "no-store" });
			if (self.disposed || !res.ok) {
				self._renderEmpty();
				return;
			}
			var data = await res.json();
			if (!data || data.ok !== true) {
				self._renderEmpty();
				return;
			}
			self._applyCaptureStatus(data.capture);
			self._processSpaces(data.spaces);
		} catch (e) {
			self._renderEmpty();
		}
	})();
};
LivePreviewController.prototype._renderEmpty = function() {
	if (this.lastList.length === 0) this._processSpaces([]);
};
LivePreviewController.prototype._processSpaces = function(spaces) {
	if (this.disposed) return;
	this.lastList = Array.isArray(spaces) ? spaces : [];
	for (var i = 0; i < this.lastList.length; i++) {
		var s = this.lastList[i];
		var prev = this.pageMeta.get(s.targetId) || { targetId: s.targetId };
		var meta = {
			url: s.url,
			title: s.title,
			targetId: s.targetId
		};
		if (Number.isFinite(s.viewportW)) meta.vw = s.viewportW;
		else if (prev.vw !== void 0) meta.vw = prev.vw;
		if (Number.isFinite(s.viewportH)) meta.vh = s.viewportH;
		else if (prev.vh !== void 0) meta.vh = prev.vh;
		this.pageMeta.set(s.targetId, meta);
	}
	var liveIds = new Set(this.lastList.map(function(s$1) {
		return s$1.targetId;
	}));
	var pm = this.pageMeta;
	pm.forEach(function(_, id) {
		if (!liveIds.has(id)) pm.delete(id);
	});
	var fc = this.frameCache;
	fc.forEach(function(_, id) {
		if (!liveIds.has(id)) fc.delete(id);
	});
	var activeMarked = this.lastList.find(function(s$1) {
		return s$1.active === true;
	});
	if (activeMarked) this.agentActiveId = activeMarked.targetId;
	this.liveCount = this.lastList.length;
	var busy = this.lastList.some(function(s$1) {
		return Date.now() - (s$1.lastActive || 0) <= ACTIVE_WINDOW_MS;
	});
	if (busy !== this.lastSawActive) this.lastSawActive = busy;
	this._recompute();
};
LivePreviewController.prototype.openStream = function() {
	if (this.disposed || !this.visible || frameRelayDisabled) return;
	var self = this;
	fetch(WATCH_STATUS_ROUTE, { cache: "no-store" }).then(function(res) {
		return res.ok ? res.json() : null;
	}).then(function(status) {
		if (self.disposed || !self.visible || frameRelayDisabled) return;
		if (frameRelayOff(status)) {
			self.closeStream();
			self._destroyVideo();
			self._recompute();
			return;
		}
		self._applyCaptureStatus(status);
		self._connectStream();
	}).catch(function() {
		if (!self.disposed && self.visible && !frameRelayDisabled) self._connectStream();
	});
};
LivePreviewController.prototype._connectStream = function() {
	if (this.disposed || frameRelayDisabled || this.sse) return;
	var self = this;
	this.closeStream();
	try {
		this.sse = new EventSource("/api/ego/stream");
	} catch (e) {
		return;
	}
	this.sse.addEventListener("frame", function(ev) {
		try {
			var m = JSON.parse(ev.data);
			if (!m || !m.targetId || !m.data) return;
			if (Number.isFinite(m.vw) && Number.isFinite(m.vh)) {
				var cur = self.pageMeta.get(m.targetId) || { targetId: m.targetId };
				self.pageMeta.set(m.targetId, Object.assign({}, cur, {
					vw: m.vw,
					vh: m.vh
				}));
			}
			self.applyFrame(m.targetId, "data:image/jpeg;base64," + m.data, m.vw, m.vh);
		} catch (e) {}
	});
	this.sse.addEventListener("spaces", function(ev) {
		if (self.disposed) return;
		try {
			var list = JSON.parse(ev.data);
			if (Array.isArray(list)) self._processSpaces(list);
		} catch (e) {}
	});
	this.sse.addEventListener("capture-status", function(ev) {
		try {
			self._applyCaptureStatus(JSON.parse(ev.data));
		} catch (e) {}
	});
	this.sse.onerror = function() {
		if (self.reconnectFallbackTimer) return;
		self.reconnectFallbackTimer = window.setTimeout(function() {
			self.reconnectFallbackTimer = null;
			if (self.disposed || !self.visible) return;
			self.refresh();
		}, 1500);
	};
};
LivePreviewController.prototype.closeStream = function() {
	try {
		if (this.sse) this.sse.close();
	} catch (e) {}
	this.sse = null;
};
LivePreviewController.prototype.applyFrame = function(targetId, dataUrl, vw, vh) {
	if (this.disposed) return;
	this.frameCache.delete(targetId);
	this.frameCache.set(targetId, dataUrl);
	var MAX_CACHED_FRAMES = 12;
	if (this.frameCache.size > MAX_CACHED_FRAMES) {
		var self = this;
		this.frameCache.forEach(function(_, id) {
			if (self.frameCache.size <= MAX_CACHED_FRAMES) return;
			if (id === targetId || id === self.liveImgTargetId) return;
			self.frameCache.delete(id);
		});
	}
	if (Number.isFinite(vw) && Number.isFinite(vh)) {
		var cur = this.pageMeta.get(targetId) || { targetId };
		this.pageMeta.set(targetId, Object.assign({}, cur, {
			vw,
			vh
		}));
	}
	if (this.liveImg && this.liveImgTargetId === targetId) {
		var self2 = this;
		this.pendingLiveFrame = dataUrl;
		if (!this.liveFlushRaf && !this.disposed) this.liveFlushRaf = window.requestAnimationFrame(function() {
			self2.liveFlushRaf = null;
			if (self2.disposed || !self2.liveImg || self2.pendingLiveFrame == null) return;
			try {
				self2.liveImg.src = self2.pendingLiveFrame;
			} catch (e) {}
			self2.pendingLiveFrame = null;
		});
		return;
	}
	if (!this.pinned && this.selectedTabId === null && targetId === this.agentActiveId) {
		var now = Date.now();
		if (now - this.lastFrameAt >= FRAME_FOLLOW_MIN_MS) {
			this.lastFrameAt = now;
			if (this.followTimer) window.clearTimeout(this.followTimer);
			var self3 = this;
			this.followTimer = window.setTimeout(function() {
				if (self3.disposed || self3.pinned || self3.selectedTabId !== null) return;
				if (self3.liveImg && self3.liveImgTargetId === targetId) return;
				if (!self3.pageMeta.get(targetId)) return;
				self3.currentActiveId = targetId;
				self3._recompute();
			}, 0);
		}
	}
};
LivePreviewController.prototype.sendInput = function(targetId, type, params) {
	if (!!!targetId || this.disposed || type !== "mouseReleased" && type !== "keyUp" && !this.visible) return;
	var self = this;
	fetch(INPUT_ROUTE, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(Object.assign({
			targetId,
			type
		}, params))
	}).then(function(res) {
		if (res.status === 409) {
			self.liveImgTargetId = null;
			self._pointerState = null;
			self.refresh();
		}
	}).catch(function() {});
};
LivePreviewController.prototype.browserXY = function(e) {
	if (this.liveImgTargetId == null || !this.liveImg) return null;
	var m = this.pageMeta.get(this.liveImgTargetId);
	var vw = m && m.vw, vh = m && m.vh;
	if (!Number.isFinite(vw) || !Number.isFinite(vh)) return null;
	var img = this.liveImg;
	var rect = img.getBoundingClientRect();
	var natW = img.naturalWidth || img.videoWidth || rect.width;
	var natH = img.naturalHeight || img.videoHeight || rect.height;
	if (!natW || !natH) return null;
	var scale = Math.min(rect.width / natW, rect.height / natH);
	var contentW = natW * scale;
	var contentH = natH * scale;
	var ox = (rect.width - contentW) / 2;
	var oy = (rect.height - contentH) / 2;
	var rx = e.clientX - rect.left - ox;
	var ry = e.clientY - rect.top - oy;
	return {
		x: rx / contentW * vw,
		y: ry / contentH * vh
	};
};
LivePreviewController.prototype.pinTo = function(space) {
	if (this.disposed) return;
	this.pinned = space;
	this.selectedTabId = null;
	this._recompute();
};
LivePreviewController.prototype.unpin = function() {
	this.pinned = null;
	this._recompute();
};
LivePreviewController.prototype.selectTab = function(targetId) {
	if (this.selectedTabId === targetId) {
		this.selectedTabId = null;
		this.pinned = null;
	} else {
		this.selectedTabId = targetId;
		this.pinned = null;
	}
	this._recompute();
	this._syncWatch(this.selectedTabId || this.currentActiveId);
};
LivePreviewController.prototype.closeTab = function(targetId) {
	var self = this;
	(async function() {
		try {
			await fetch(EGO_CLOSE_ROUTE, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ targetId })
			});
		} catch (e) {}
		if (self.selectedTabId === targetId) {
			self.selectedTabId = null;
			self.pinned = null;
		}
		self.refresh();
	})();
};
LivePreviewController.prototype.toggleHistory = function() {
	this.historyOpen = !this.historyOpen;
	this._recompute();
};
LivePreviewController.prototype.dismissGuide = function(which) {
	this.dismissedGuides[which] = true;
	this._recompute();
};
LivePreviewController.prototype.flushLogin = function() {
	return (async function() {
		return (await fetch(FLUSH_ROUTE, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}"
		})).json();
	})();
};
LivePreviewController.prototype._showHint = function(txt) {
	this._zoomHint = txt;
	this._recompute();
	if (this._zoomHintTimer) window.clearTimeout(this._zoomHintTimer);
	var self = this;
	this._zoomHintTimer = window.setTimeout(function() {
		self._zoomHint = null;
		self._recompute();
	}, 2e3);
};
LivePreviewController.prototype.noteWired = function() {
	if (!this.wiringStale) return;
	this.wiringStale = false;
	if (this._wiredRecomputeQueued) return;
	this._wiredRecomputeQueued = true;
	var self = this;
	Promise.resolve().then(function() {
		self._wiredRecomputeQueued = false;
		if (!self.disposed) self._recompute();
	});
};
LivePreviewController.prototype._signalUnwired = function() {
	var now = Date.now();
	if (now - this._lastUnwiredAt < 5e3) return;
	this._lastUnwiredAt = now;
	try {
		console.warn("[ego-browser] live view not wired (liveImgTargetId=" + this.liveImgTargetId + ", current=" + this.currentActiveId + ") — input dropped");
	} catch (e) {}
	this._showHint(wt("hintNotCaptured"));
};
LivePreviewController.prototype._applyZoom = function() {
	if (!this.liveImg) return;
	this.liveImg.style.transformOrigin = "0 0";
	this.liveImg.style.transform = "translate(" + this.zoomState.tx + "px," + this.zoomState.ty + "px) scale(" + this.zoomState.scale + ")";
};
LivePreviewController.prototype.resetZoom = function() {
	this.zoomState = {
		scale: 1,
		tx: 0,
		ty: 0
	};
	this._applyZoom();
	this._showHint(wt("hintReset"));
};
LivePreviewController.prototype.handleWheel = function(e) {
	e.preventDefault();
	e.stopPropagation();
	if (e.ctrlKey || e.metaKey) {
		if (!this.liveImg) return;
		var rect = this.liveImg.getBoundingClientRect();
		var mx = e.clientX - rect.left, my = e.clientY - rect.top;
		var next = Math.min(8, Math.max(1, this.zoomState.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
		if (next <= 1) {
			this.resetZoom();
			return;
		}
		this.zoomState.tx = mx - (mx - this.zoomState.tx) * (next / this.zoomState.scale);
		this.zoomState.ty = my - (my - this.zoomState.ty) * (next / this.zoomState.scale);
		this.zoomState.scale = next;
		this._applyZoom();
		this._showHint(wt("hintPan"));
		return;
	}
	var p = this.browserXY(e);
	if (p && this.liveImgTargetId) this.sendInput(this.liveImgTargetId, "mouseWheel", {
		x: p.x,
		y: p.y,
		deltaX: e.deltaX || 0,
		deltaY: e.deltaY || (e.deltaMode === 1 ? 40 : e.deltaY || 100)
	});
	else this._signalUnwired();
};
LivePreviewController.prototype.handlePointerDown = function(e) {
	if (e.button !== 0) return;
	this._pointerState = {
		viewPanning: false,
		browserDrag: false,
		sx: e.clientX,
		sy: e.clientY,
		stx: this.zoomState.tx,
		sty: this.zoomState.ty,
		lastDragPos: null,
		downButtons: 0,
		targetId: this.liveImgTargetId
	};
	try {
		e.currentTarget.setPointerCapture(e.pointerId);
	} catch (err) {}
	if (e.ctrlKey || e.metaKey) {
		this._pointerState.viewPanning = true;
		e.currentTarget.style.cursor = "grabbing";
		this._showHint(wt("hintScroll"));
		return;
	}
	this._pointerState.browserDrag = true;
	this.keyboardProxy.focusAt(e, this._pointerState.targetId);
	this._pointerState.downButtons = 1;
	var p = this.browserXY(e);
	if (p) {
		this._pointerState.lastDragPos = p;
		this.sendInput(this._pointerState.targetId, "mousePressed", {
			x: p.x,
			y: p.y,
			button: "left",
			buttons: 1,
			clickCount: 1
		});
	} else this._signalUnwired();
};
LivePreviewController.prototype.handlePointerMove = function(e) {
	if (!this._pointerState) {
		var p = this.browserXY(e);
		if (p) this.sendInput(this.liveImgTargetId, "mouseMoved", {
			x: p.x,
			y: p.y,
			buttons: 0
		});
		return;
	}
	if (this._pointerState.viewPanning) {
		this.zoomState.tx = this._pointerState.stx + (e.clientX - this._pointerState.sx);
		this.zoomState.ty = this._pointerState.sty + (e.clientY - this._pointerState.sy);
		this._applyZoom();
		return;
	}
	if (this._pointerState.browserDrag) {
		var p2 = this.browserXY(e);
		if (p2) {
			this.sendInput(this._pointerState.targetId, "mouseMoved", {
				x: p2.x,
				y: p2.y,
				buttons: this._pointerState.downButtons
			});
			this._pointerState.lastDragPos = p2;
		}
	}
};
LivePreviewController.prototype.handlePointerUp = function(e) {
	if (!this._pointerState) return;
	if (this._pointerState.viewPanning) {
		if (e.currentTarget) e.currentTarget.style.cursor = "grab";
	}
	if (this._pointerState.browserDrag) {
		if (this._pointerState.lastDragPos && this._pointerState.targetId) this.sendInput(this._pointerState.targetId, "mouseReleased", {
			x: this._pointerState.lastDragPos.x,
			y: this._pointerState.lastDragPos.y,
			button: "left",
			buttons: 0,
			clickCount: 1
		});
	}
	if (e.currentTarget) e.currentTarget.style.cursor = "grab";
	this._pointerState = null;
};
LivePreviewController.prototype.handleDoubleClick = function(e) {
	e.preventDefault();
	this.resetZoom();
};
function EgoBrowserTab(props) {
	var visible = props.visible;
	var ctx = props.ctx;
	var controllerRef = React.useRef(null);
	if (controllerRef.current === null) controllerRef.current = new LivePreviewController(ctx);
	var controller = controllerRef.current;
	var useSnapshotRef = React.useRef(null);
	if (useSnapshotRef.current === null) useSnapshotRef.current = bindSnapshotSelector(controller.store);
	var state = useSnapshotRef.current(function(s) {
		return s;
	});
	var imgRef = React.useRef(null);
	var videoRef = React.useRef(null);
	var bindLiveImg = function(el) {
		imgRef.current = el;
		if (el && state.currentTargetId != null && (controller.liveImg !== el || controller.liveImgTargetId !== state.currentTargetId)) {
			controller.setLiveImg(el, state.currentTargetId);
			controller.noteWired();
		}
	};
	var bindLiveVideo = function(el) {
		videoRef.current = el;
		if (el && state.currentTargetId != null && (controller.liveImg !== el || controller.liveImgTargetId !== state.currentTargetId)) {
			controller.setLiveVideo(el, state.currentTargetId);
			controller.noteWired();
		}
	};
	React.useEffect(function() {
		controller.start();
		return function() {
			controller.dispose();
		};
	}, [controller]);
	React.useEffect(function() {
		controller.setVisible(visible);
	}, [visible, controller]);
	React.useEffect(function() {
		if (imgRef.current && state.currentTargetId != null) controller.setLiveImg(imgRef.current, state.currentTargetId);
		if (videoRef.current && state.currentTargetId != null) controller.setLiveVideo(videoRef.current, state.currentTargetId);
	}, [
		state.currentTargetId,
		state.backend,
		state.streamGeneration,
		state.streamState,
		controller
	]);
	React.useEffect(function() {
		var img = imgRef.current || videoRef.current;
		if (!img) return;
		var handler = function(e) {
			controller.handleWheel(e);
		};
		img.addEventListener("wheel", handler, { passive: false });
		return function() {
			img.removeEventListener("wheel", handler);
		};
	}, [
		controller,
		state.currentTargetId,
		state.backend,
		state.streamGeneration
	]);
	var h$1 = React.createElement;
	var header = h$1("div", { className: "dsh-ego-side-head" }, h$1("span", { className: "dsh-ego-side-title" }, h$1("span", { dangerouslySetInnerHTML: { __html: ICON_GLOBE } }), h$1("span", { style: { marginLeft: "5px" } }, state.busy ? wt("titleLive") : wt("title"))), h$1("button", {
		className: "dsh-ego-side-iconbtn" + (state.busy ? " spinning" : ""),
		title: wt("refresh"),
		onClick: function() {
			controller.refresh();
		}
	}, h$1("span", { dangerouslySetInnerHTML: { __html: ICON_REFRESH } })), h$1("button", {
		className: "dsh-ego-side-iconbtn" + (state.historyOpen ? "" : " off"),
		title: state.historyOpen ? wt("historyHide") : wt("historyShow"),
		onClick: function() {
			controller.toggleHistory();
		}
	}, h$1("span", { dangerouslySetInnerHTML: { __html: ICON_CLOCK } })));
	if (state.historyOpen) {
		var sorted = state.spaces.slice().sort(function(a, b) {
			return (a.lastActive || 0) - (b.lastActive || 0);
		});
		return h$1("div", { className: "dsh-ego-side-root" }, header, h$1("div", { className: "dsh-ego-side-history" }, h$1("div", { className: "dsh-ego-side-historyhead" }, h$1("span", { dangerouslySetInnerHTML: { __html: ICON_CLOCK } }), " " + wt("history")), h$1("div", { className: "dsh-ego-side-historylist" }, sorted.length === 0 ? h$1("div", { className: "dsh-ego-side-hnone" }, wt("noHistory")) : sorted.map(function(s) {
			return h$1("div", {
				key: s.targetId,
				className: "dsh-ego-side-hitem" + (s.targetId === state.currentTargetId ? " active" : ""),
				onClick: function() {
					controller.pinTo(s);
					controller.toggleHistory();
				}
			}, s.thumbnail ? h$1("img", {
				className: "dsh-ego-side-hthumb",
				src: s.thumbnail,
				alt: ""
			}) : h$1("div", { className: "dsh-ego-side-hthumb" }), h$1("div", { className: "dsh-ego-side-hinfo" }, h$1("div", { className: "dsh-ego-side-htitle" }, s.title || s.url || wt("newTab")), h$1("div", { className: "dsh-ego-side-hurl" }, s.url || "(about:blank)"), s.targetId === state.currentTargetId ? h$1("div", { className: "dsh-ego-side-hactive" }, "● " + wt("current")) : null));
		}))));
	}
	var guides = [];
	if (state.showLoginGuide) guides.push(h$1(EgoLoginGuide, {
		key: "login",
		controller
	}));
	if (state.captchaKind) guides.push(h$1(EgoCaptchaGuide, {
		key: "captcha",
		kind: state.captchaKind,
		controller
	}));
	var tabsEl = state.spaces.length > 0 ? h$1("div", { className: "dsh-ego-side-tabs" }, state.spaces.map(function(s) {
		var isActive = s.targetId === state.selectedTabId || state.selectedTabId === null && s.targetId === state.currentTargetId;
		return h$1("div", {
			key: s.targetId,
			className: "dsh-ego-side-tab" + (isActive ? " active" : ""),
			title: s.url || "",
			onClick: function() {
				controller.selectTab(s.targetId);
			}
		}, h$1("span", { className: "dsh-ego-side-tabdot" }), h$1("span", { className: "dsh-ego-side-tabtxt" }, s.title || s.url || wt("newTab")), h$1("span", {
			className: "dsh-ego-side-tabclose",
			title: wt("closeTab"),
			onClick: function(e) {
				e.stopPropagation();
				controller.closeTab(s.targetId);
			}
		}, "×"));
	})) : null;
	var body;
	var currentSpace = state.currentSpace;
	if (!currentSpace) body = h$1("div", { className: "dsh-ego-side-body" }, h$1("div", { className: "dsh-ego-side-empty" }, h$1("div", null, state.relayDisabled ? wt("relayDisabledTitle") : wt("noActivePages")), h$1("div", { style: { fontSize: "11px" } }, state.relayDisabled ? wt("relayDisabledBody") : wt("noActiveHint"))));
	else {
		var liveImg = state.backend === "ffmpeg" ? h$1("video", {
			ref: bindLiveVideo,
			key: "livevideo-" + state.streamGeneration,
			className: "dsh-ego-side-liveimg",
			muted: true,
			autoPlay: true,
			playsInline: true,
			onPointerDown: function(e) {
				controller.handlePointerDown(e);
			},
			onPointerMove: function(e) {
				controller.handlePointerMove(e);
			},
			onPointerUp: function(e) {
				controller.handlePointerUp(e);
			},
			onPointerCancel: function(e) {
				controller.handlePointerUp(e);
			},
			onDoubleClick: function(e) {
				controller.handleDoubleClick(e);
			}
		}) : currentSpace.thumbnail ? h$1("img", {
			ref: bindLiveImg,
			key: "liveimg",
			className: "dsh-ego-side-liveimg",
			src: currentSpace.thumbnail,
			alt: "live",
			draggable: false,
			onPointerDown: function(e) {
				controller.handlePointerDown(e);
			},
			onPointerMove: function(e) {
				controller.handlePointerMove(e);
			},
			onPointerUp: function(e) {
				controller.handlePointerUp(e);
			},
			onPointerCancel: function(e) {
				controller.handlePointerUp(e);
			},
			onDoubleClick: function(e) {
				controller.handleDoubleClick(e);
			}
		}) : h$1("div", { className: "dsh-ego-side-liveurl" }, state.streamMessage || wt("noScreenshot"));
		body = h$1("div", { className: "dsh-ego-side-body" }, h$1("div", { className: "dsh-ego-side-liveview" }, h$1("div", { className: "dsh-ego-side-livebadge" }, h$1("span", { className: "dsh-ego-side-state-dot" + (state.pinned ? " pin" : state.busy ? " busy" : "") }), h$1("span", { style: { flex: 1 } }, (state.backend === "ffmpeg" ? "FFmpeg · H.264" : "CDP") + " · " + (state.streamState === "failed" ? state.streamMessage || wt("failed") : state.streamState) + (state.currentTargetId ? state.wiringStale ? " · " + wt("stale") : " · " + wt("captured") : "")), state.pinned ? h$1("button", {
			className: "dsh-ego-side-back",
			type: "button",
			onClick: function() {
				controller.unpin();
			}
		}, wt("backToLive")) : null, h$1("button", {
			className: "dsh-ego-side-back",
			type: "button",
			title: wt("openExternal"),
			onClick: function() {
				var url = currentSpace.url;
				if (url && !url.startsWith("about:") && !url.startsWith("chrome://")) window.open(url, "_blank", "noopener");
			}
		}, wt("openExternal")), h$1("button", {
			className: "dsh-ego-side-back",
			type: "button",
			title: wt("raiseWindowHint"),
			onClick: function() {
				fetch("/api/ego/raise", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}"
				}).then(function(r) {
					return r.json().catch(function() {
						return null;
					});
				}).catch(function() {
					return null;
				});
			}
		}, wt("raiseWindow"))), liveImg, h$1("div", { className: "dsh-ego-side-livetitle" }, currentSpace.title || currentSpace.url || wt("newTab")), h$1("div", { className: "dsh-ego-side-liveurl" + (state.zoomHint ? " dsh-ego-side-hint" : "") }, state.zoomHint || currentSpace.url || "")));
	}
	return h$1("div", { className: "dsh-ego-side-root" }, header, guides, tabsEl, body);
}
function EgoLoginGuide(props) {
	var controller = props.controller;
	var h$1 = React.createElement;
	var noteState = React.useState("");
	var note = noteState[0], setNote = noteState[1];
	var savingState = React.useState(false);
	var saving = savingState[0], setSaving = savingState[1];
	return h$1("div", { className: "dsh-ego-side-login" }, h$1("span", { className: "dsh-ego-side-login-txt" }, wt("loginTitle")), h$1("button", {
		className: "dsh-ego-side-login-btn" + (saving ? " saving" : ""),
		type: "button",
		disabled: saving,
		onClick: function() {
			setSaving(true);
			setNote("");
			controller.flushLogin().then(function(j) {
				if (j && j.ok) setNote(wt("loginSaved", { n: j.total || "" }));
				else setNote(j && j.error ? wt("loginNotConnected") : wt("loginFailed"));
			}).catch(function() {
				setNote(wt("loginFailed"));
			}).finally(function() {
				setSaving(false);
			});
		}
	}, saving ? wt("loginSaving") : wt("loginBtn")), note ? h$1("span", { className: "dsh-ego-side-login-note" }, note) : null, h$1("button", {
		className: "dsh-ego-side-iconbtn",
		type: "button",
		title: wt("loginDismiss"),
		onClick: function() {
			controller.dismissGuide("login");
		}
	}, "×"));
}
function EgoCaptchaGuide(props) {
	var controller = props.controller;
	var kind = props.kind;
	var h$1 = React.createElement;
	return h$1("div", { className: "dsh-ego-side-captcha" }, h$1("span", { className: "dsh-ego-side-captcha-txt" }, h$1("b", null, wt("captchaTitle")), " — " + wt("captchaHint")), h$1("span", { className: "dsh-ego-side-captcha-kind" }, kind), h$1("button", {
		className: "dsh-ego-side-iconbtn",
		type: "button",
		title: wt("captchaDismiss"),
		onClick: function() {
			controller.dismissGuide("captcha");
		}
	}, "×"));
}
function mountSidebarTab(ctx, betterSidebar) {
	if (!betterSidebar) return function() {};
	var styleEl = document.createElement("style");
	styleEl.textContent = TAB_CSS;
	document.head.appendChild(styleEl);
	var disposeTab = betterSidebar.registerTab({
		id: "ego-browser:watch",
		title: function() {
			return wt("title");
		},
		order: 70,
		single: true,
		component: EgoBrowserTab
	});
	var probeDisposed = false;
	var baseline = null;
	var autoOpened = {};
	var openWatchTab = function(sessionId) {
		var key = sessionId || "";
		if (autoOpened[key] === true) return;
		autoOpened[key] = true;
		try {
			betterSidebar.openTab({ type: "ego-browser:watch" }, sessionId ? { sessionId } : void 0);
		} catch (e) {}
	};
	(async function() {
		if (probeDisposed) return;
		try {
			var res = await fetch(SPACES_ROUTE, { cache: "no-store" });
			if (!res.ok) return;
			var data = await res.json();
			if (data && data.frameRelay === false) {
				frameRelaySet(true);
				closeProbeSse();
			}
			if (data && typeof data.toolCallCount === "number") baseline = data.toolCallCount;
		} catch (e) {}
	})();
	var probeSse = null;
	var openProbeSse = function() {
		if (probeDisposed || probeSse || frameRelayDisabled) return;
		try {
			probeSse = new EventSource("/api/ego/stream");
		} catch (e) {
			probeSse = null;
			return;
		}
		probeSse.addEventListener("tool-call", onProbeToolCall);
	};
	var closeProbeSse = function() {
		try {
			if (probeSse) probeSse.close();
		} catch (e) {}
		probeSse = null;
	};
	var onProbeToolCall = function(ev) {
		if (probeDisposed) return;
		try {
			var m = JSON.parse(ev.data);
			if (!m || typeof m.count !== "number") return;
			var sid = typeof m.sessionId === "string" && m.sessionId !== "" ? m.sessionId : void 0;
			if (baseline === null) {
				baseline = m.count;
				if (m.count > 0) openWatchTab(sid);
				return;
			}
			if (m.count > baseline) openWatchTab(sid);
		} catch (e) {}
	};
	openProbeSse();
	var offProbeRelay = frameRelaySubscribe(function(disabled) {
		if (disabled) closeProbeSse();
		else openProbeSse();
	});
	return function() {
		probeDisposed = true;
		if (offProbeRelay) try {
			offProbeRelay();
		} catch (e) {}
		closeProbeSse();
		disposeTab();
		styleEl.remove();
	};
}
function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		"\"": "&quot;",
		"'": "&#39;"
	})[c]);
}
const name = "ego-browser";

//#endregion
exports.apply = apply;
exports.inject = inject;
exports.name = name;
return module.exports; } });
//# sourceMappingURL=client.js.map