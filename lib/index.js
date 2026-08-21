import { defineTool } from "@deepseek-ai/dsh-tools";
import { constants, createReadStream, createWriteStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import z from "schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, copyFile, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { spawn } from "node:child_process";

//#region src/cast-server.ts
const WORKER_BIN = fileURLToPath(new URL("../bin/ego-cast-worker.mjs", import.meta.url));
const EGO_SPACES_ROUTE = "/api/ego/spaces";
const EGO_STREAM_ROUTE = "/api/ego/stream";
const EGO_HEALTH_ROUTE = "/api/ego/health";
const EGO_CLOSE_ROUTE = "/api/ego/close";
const EGO_FLUSH_ROUTE = "/api/ego/flush";
const EGO_INPUT_ROUTE = "/api/ego/input";
const EGO_WATCH_START_ROUTE = "/api/ego/watch/start";
const EGO_WATCH_SWITCH_ROUTE = "/api/ego/watch/switch";
const EGO_WATCH_STOP_ROUTE = "/api/ego/watch/stop";
const EGO_WATCH_STATUS_ROUTE = "/api/ego/watch/status";
const EGO_VIDEO_ROUTE = "/api/ego/video";
const EGO_VIDEO_STATUS_ROUTE = "/api/ego/video/status";
let toolCallCount = 0;
const sseClients = /* @__PURE__ */ new Set();
function markEgoToolCall() {
	toolCallCount += 1;
	const frame = `event: tool-call\ndata: ${JSON.stringify({ count: toolCallCount })}\n\n`;
	for (const res of sseClients) try {
		res.write(frame);
	} catch {
		sseClients.delete(res);
	}
}
function castStatePath() {
	const e = process.env;
	const isWin = process.platform === "win32";
	const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || "" : "/root");
	const stateHome = e.EGO_LINUX_STATE_DIR || (isWin ? e.LOCALAPPDATA || `${home}\\AppData\\Local` : e.XDG_STATE_HOME || `${home}/.local/state`);
	return stateHome.endsWith("ego-lite-linux") ? `${stateHome}/ego-cast.json` : `${stateHome}/ego-lite-linux/ego-cast.json`;
}
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(payload),
		"cache-control": "no-store"
	});
	res.end(payload);
}
/** Proxy a worker loopback endpoint. Returns null when the worker is unreachable. */
async function proxyFrom(port, path) {
	try {
		const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(4e3) });
		if (!r.ok) return null;
		return await r.json();
	} catch {
		return null;
	}
}
/** Proxy a POST with a JSON body to the worker. Returns status and body, or null when unreachable. */
async function proxyPost(port, path, body, timeoutMs = 4e3) {
	try {
		const r = await fetch(`http://127.0.0.1:${port}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs)
		});
		return {
			status: r.status,
			body: await r.json().catch(() => ({
				ok: false,
				error: `worker returned ${r.status}`
			}))
		};
	} catch {
		return null;
	}
}
/**
* Bridge the worker's SSE stream to the DSH watch panel.
*
* The host's webServer calls this as a plain HTTP handler and then returns, so
* we write the `text/event-stream` headers, start consuming the worker's
* /api/stream body, and forward every SSE line verbatim onto `res` from a
* background loop. The connection stays open until the worker stream ends or
* the client disconnects. If the worker is unreachable we still emit a valid
* empty SSE stream (the panel stays quiet instead of erroring).
*
* Each `res` is also registered in the module-level `sseClients` set so
* markEgoToolCall() can inject `tool-call` events directly into the live
* stream (the sidebar auto-open signal), without the client polling.
*/
function proxyWorkerStream(port, res, path) {
	let cancelled = false;
	let ended = false;
	const endOnce = () => {
		if (ended) return;
		ended = true;
		sseClients.delete(res);
		try {
			res.end();
		} catch {}
	};
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
		"x-accel-buffering": "no"
	});
	res.write(":ok\n\n");
	sseClients.add(res);
	const up = request({
		host: "127.0.0.1",
		port,
		path,
		method: "GET",
		headers: { accept: "text/event-stream" }
	}, (upRes) => {
		upRes.on("data", (chunk) => {
			if (cancelled || ended) return;
			try {
				if (!res.write(chunk)) {
					upRes.pause();
					res.once("drain", () => {
						if (!cancelled && !ended) upRes.resume();
					});
				}
			} catch {
				cancelled = true;
				endOnce();
			}
		});
		upRes.on("end", endOnce);
		upRes.on("error", endOnce);
	});
	up.on("error", endOnce);
	up.setTimeout(5e3, () => {
		try {
			up.destroy();
		} catch {}
		endOnce();
	});
	up.end();
	const onClose = () => {
		cancelled = true;
		sseClients.delete(res);
		try {
			up.destroy();
		} catch {}
	};
	res.on("close", onClose);
	return () => {
		cancelled = true;
		sseClients.delete(res);
		try {
			up.destroy();
		} catch {}
	};
}
function proxyWorkerVideo(port, req, res) {
	const generation = new URL(req.url || EGO_VIDEO_ROUTE, "http://dsh.internal").searchParams.get("generation");
	const path = `/api/video/stream${generation ? `?generation=${encodeURIComponent(generation)}` : ""}`;
	let upstream;
	let ended = false;
	const end = () => {
		if (ended) return;
		ended = true;
		try {
			res.end();
		} catch {}
	};
	upstream = request({
		host: "127.0.0.1",
		port,
		path,
		method: "GET",
		headers: { accept: "video/mp4" }
	}, (upRes) => {
		res.writeHead(upRes.statusCode || 502, {
			"content-type": upRes.headers["content-type"] || "application/octet-stream",
			"cache-control": "no-store",
			...upRes.headers["x-ego-generation"] ? { "x-ego-generation": upRes.headers["x-ego-generation"] } : {},
			...upRes.headers["x-ego-backend"] ? { "x-ego-backend": upRes.headers["x-ego-backend"] } : {}
		});
		upRes.on("data", (chunk) => {
			if (ended) return;
			try {
				if (!res.write(chunk)) {
					upRes.pause();
					res.once("drain", () => {
						if (!ended) upRes.resume();
					});
				}
			} catch {
				upstream.destroy();
				end();
			}
		});
		upRes.on("end", end);
		upRes.on("error", end);
	});
	upstream.on("error", () => {
		if (!res.headersSent) sendJson(res, 502, {
			ok: false,
			error: "video worker unavailable"
		});
		else end();
	});
	upstream.setTimeout(5e3, () => {
		try {
			upstream.destroy();
		} catch {}
		if (!res.headersSent) sendJson(res, 504, {
			ok: false,
			error: "video worker timeout"
		});
		else end();
	});
	upstream.end();
	res.on("close", () => {
		ended = true;
		try {
			upstream.destroy();
		} catch {}
	});
}
async function readJsonBody$1(req, maxBytes = 8192) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of req) {
		bytes += chunk.length;
		if (bytes > maxBytes) throw new Error("body too large");
		chunks.push(Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
/** Read the worker's { port, pid } from ego-cast.json, if any. */
async function knownWorkerState() {
	try {
		const { readFile: readFile$1 } = await import("node:fs/promises");
		const state = JSON.parse(await readFile$1(castStatePath(), "utf8"));
		return {
			port: typeof state.port === "number" ? state.port : null,
			pid: typeof state.pid === "number" ? state.pid : null
		};
	} catch {
		return {
			port: null,
			pid: null
		};
	}
}
/** Is a process with this pid alive? (false for our own / empty / signals fail) */
function isProcessAlive$1(pid) {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const e = err;
		return e && e.code === "EPERM";
	}
}
function captureConfig(cfg, ffmpegManager) {
	const ffmpegStatus = ffmpegManager?.status();
	const unavailable = cfg.captureBackend === "ffmpeg" && !ffmpegStatus?.canSelectFfmpeg;
	return {
		captureBackend: unavailable ? "cdp" : cfg.captureBackend,
		ffmpegFallbackReason: unavailable ? ffmpegStatus?.reason || "FFmpeg is unavailable" : "",
		streamProfile: cfg.streamProfile,
		cdpFps: cfg.cdpFps,
		cdpQuality: cfg.cdpQuality,
		cdpMaxWidth: cfg.cdpMaxWidth,
		cdpBackstopIntervalMs: cfg.cdpBackstopIntervalMs,
		ffmpegFps: cfg.ffmpegFps,
		ffmpegMaxWidth: cfg.ffmpegMaxWidth,
		ffmpegBitrateKbps: cfg.ffmpegBitrateKbps,
		ffmpegEncoder: cfg.ffmpegEncoder,
		ffmpegPath: cfg.ffmpegPath,
		ffmpegResolvedPath: ffmpegStatus?.canSelectFfmpeg ? ffmpegStatus.path || "" : ""
	};
}
/**
* Ensure a single ego-cast worker is running (idempotent). Launches it via
* ctx.subprocess. Re-spawns whenever the previous worker is found dead (its
* pid no longer alive or its /api/health does not answer), so a crashed
* worker is brought back without a host restart. Spawn is rate-limited to
* avoid hot-looping while a headless container has no browser yet.
*/
function makeEnsureWorker(ctx, cfg, ffmpegManager) {
	let lastAttempt = 0;
	async function launchedWorkerPort() {
		const state = await knownWorkerState();
		if (state.pid === null || !isProcessAlive$1(state.pid)) return null;
		return await proxyFrom(state.port, "/api/health") ? state.port : null;
	}
	return async function ensureWorker() {
		const running = await launchedWorkerPort();
		if (running !== null) return running;
		const now = Date.now();
		if (now - lastAttempt > 8e3) {
			lastAttempt = now;
			try {
				await ffmpegManager?.check({
					configuredPath: cfg.ffmpegPath,
					requestedEncoder: cfg.ffmpegEncoder
				}).catch(() => null);
				const initCfg = JSON.stringify(captureConfig(cfg, ffmpegManager));
				ctx.subprocess.spawn({
					argv: [
						process.execPath,
						WORKER_BIN,
						initCfg
					],
					stdio: {
						stdin: { data: "" },
						stdout: { maxBytes: 8192 },
						stderr: { maxBytes: 4096 }
					},
					graceMs: 12e3
				}).done.catch(() => null);
				const deadline = Date.now() + 8e3;
				while (Date.now() < deadline) {
					const ready = await launchedWorkerPort();
					if (ready !== null) return ready;
					await new Promise((resolve$1) => setTimeout(resolve$1, 100));
				}
				return null;
			} catch {
				return null;
			}
		}
		return null;
	};
}
/**
* Push the current cast config to a running worker via POST /api/config.
* Best-effort: if the worker is unreachable or the POST fails, the config
* will take effect on the next worker spawn (argv seed). Called whenever the
* settings layer reports a change.
*/
function makePushConfig(ensureWorker, ffmpegManager) {
	let lastPush = "";
	return async function pushConfig(cfg) {
		await ffmpegManager?.check({
			configuredPath: cfg.ffmpegPath,
			requestedEncoder: cfg.ffmpegEncoder
		}).catch(() => null);
		const port = await ensureWorker();
		if (port === null) return;
		const payload = JSON.stringify(captureConfig(cfg, ffmpegManager));
		if (payload === lastPush) return;
		lastPush = payload;
		try {
			const result = await proxyPost(port, "/api/config", JSON.parse(payload));
			if (!result || result.status >= 400) throw new Error("worker config update failed");
		} catch {}
	};
}
/**
* Register the watch-panel routes. Call inside plugin apply() with the real
* ctx; dispose is returned for ctx.effect cleanup.
*
* `bridge` is the settings bridge — its `onChange` is used to react to
* live settings saves and push the new config to a running worker.
*/
function initCastServer(ctx, cfg, bridge, ffmpegManager) {
	const ensureWorker = makeEnsureWorker(ctx, cfg, ffmpegManager);
	const pushConfig = makePushConfig(ensureWorker, ffmpegManager);
	const server = ctx.webServer;
	if (!server || typeof server.register !== "function") return;
	if (typeof bridge?.onChange === "function") {
		const off = bridge.onChange(() => {
			pushConfig(cfg);
		});
		if (typeof off === "function") ctx.effect?.(() => () => {
			try {
				off();
			} catch {}
		});
	}
	const disposeSpaces = server.register({
		kind: "exact",
		path: EGO_SPACES_ROUTE,
		handler: async (_req, resRaw) => {
			const res = resRaw;
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 200, {
				ok: false,
				spaces: [],
				toolCallCount,
				reason: "no live agent browser"
			});
			const data = await proxyFrom(port, "/api/spaces");
			if (!data) return sendJson(res, 200, {
				ok: false,
				spaces: [],
				toolCallCount,
				reason: "worker not ready"
			});
			return sendJson(res, 200, {
				...data,
				toolCallCount
			});
		}
	});
	const disposeStream = server.register({
		kind: "exact",
		path: EGO_STREAM_ROUTE,
		handler: async (_req, resRaw) => {
			const res = resRaw;
			const port = await ensureWorker();
			if (port === null) {
				proxyWorkerStream(-1, res, "/api/stream");
				return;
			}
			proxyWorkerStream(port, res, "/api/stream");
		}
	});
	const disposeInput = server.register({
		kind: "exact",
		path: EGO_INPUT_ROUTE,
		handler: async (reqRaw, resRaw) => {
			const req = reqRaw;
			const res = resRaw;
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 400, {
				ok: false,
				error: "no live agent browser"
			});
			const result = await proxyPost(port, "/api/input", await readJsonBody$1(req).catch(() => ({})));
			if (!result) return sendJson(res, 502, {
				ok: false,
				error: "input worker unavailable"
			});
			return sendJson(res, result.status, result.body);
		}
	});
	const disposeClose = server.register({
		kind: "exact",
		path: EGO_CLOSE_ROUTE,
		handler: async (reqRaw, resRaw) => {
			const req = reqRaw;
			const res = resRaw;
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 400, {
				ok: false,
				error: "no live agent browser"
			});
			const body = await readJsonBody$1(req).catch(() => ({}));
			const targetId = typeof body.targetId === "string" ? body.targetId : "";
			if (!targetId) return sendJson(res, 400, {
				ok: false,
				error: "targetId required"
			});
			const result = await proxyPost(port, "/api/close", { targetId });
			if (!result) return sendJson(res, 502, {
				ok: false,
				error: "close worker unavailable"
			});
			return sendJson(res, result.status, result.body);
		}
	});
	const disposeFlush = server.register({
		kind: "exact",
		path: EGO_FLUSH_ROUTE,
		handler: async (_req, resRaw) => {
			const res = resRaw;
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 400, {
				ok: false,
				error: "no live agent browser"
			});
			const result = await proxyPost(port, "/api/flush", {});
			if (!result) return sendJson(res, 502, {
				ok: false,
				error: "flush worker unavailable"
			});
			return sendJson(res, result.status, result.body);
		}
	});
	const disposeHealth = server.register({
		kind: "exact",
		path: EGO_HEALTH_ROUTE,
		handler: async (_req, resRaw) => {
			const res = resRaw;
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 200, { ok: false });
			return sendJson(res, 200, await proxyFrom(port, "/api/health") || { ok: false });
		}
	});
	const watchRoutes = [
		[EGO_WATCH_START_ROUTE, "/api/watch/start"],
		[EGO_WATCH_SWITCH_ROUTE, "/api/watch/switch"],
		[EGO_WATCH_STOP_ROUTE, "/api/watch/stop"]
	].map(([path, workerPath]) => server.register({
		kind: "exact",
		path,
		handler: async (reqRaw, resRaw) => {
			const req = reqRaw;
			const res = resRaw;
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 409, {
				ok: false,
				error: "worker not ready"
			});
			const timeoutMs = workerPath === "/api/watch/start" || workerPath === "/api/watch/switch" ? 3e4 : 4e3;
			const result = await proxyPost(port, workerPath, await readJsonBody$1(req).catch(() => ({})), timeoutMs);
			return result ? sendJson(res, result.status, result.body) : sendJson(res, 502, {
				ok: false,
				error: "worker request failed"
			});
		}
	}));
	const disposeWatchStatus = server.register({
		kind: "exact",
		path: EGO_WATCH_STATUS_ROUTE,
		handler: async (_req, resRaw) => {
			const res = resRaw;
			const port = await ensureWorker();
			return sendJson(res, 200, (port === null ? null : await proxyFrom(port, "/api/watch/status")) || {
				ok: false,
				state: "idle",
				reason: "worker not ready"
			});
		}
	});
	const disposeVideoStatus = server.register({
		kind: "exact",
		path: EGO_VIDEO_STATUS_ROUTE,
		handler: async (_req, resRaw) => {
			const res = resRaw;
			const port = await ensureWorker();
			return sendJson(res, 200, (port === null ? null : await proxyFrom(port, "/api/video/status")) || {
				ok: false,
				state: "idle",
				reason: "worker not ready"
			});
		}
	});
	const disposeVideo = server.register({
		kind: "exact",
		path: EGO_VIDEO_ROUTE,
		handler: async (reqRaw, resRaw) => {
			const req = reqRaw;
			const res = resRaw;
			const port = await ensureWorker();
			if (port === null) return sendJson(res, 502, {
				ok: false,
				error: "worker not ready"
			});
			proxyWorkerVideo(port, req, res);
		}
	});
	ctx.effect?.(() => () => {
		try {
			disposeSpaces();
		} catch {}
		try {
			disposeStream();
		} catch {}
		try {
			disposeInput();
		} catch {}
		try {
			disposeClose();
		} catch {}
		try {
			disposeFlush();
		} catch {}
		try {
			disposeHealth();
		} catch {}
		for (const dispose of watchRoutes) try {
			dispose();
		} catch {}
		try {
			disposeWatchStatus();
		} catch {}
		try {
			disposeVideoStatus();
		} catch {}
		try {
			disposeVideo();
		} catch {}
	});
}

//#endregion
//#region src/help.ts
/**
* src/help.ts — tool index copy (EGO_HELP_INDEX).
*
* Pure data module: the `topic` lookup table for the ego_help tool. When you
* add/change a tool, remember to sync an entry here or ego_help won't find it.
*/
const EGO_HELP_INDEX = {
	overview: "ego-browser 结构化浏览器工具。导航/交互/观察/表单/网络/等待/键鼠皆有专项工具，另提供 ego_help(本索引)、ego_doctor(体检)、ego_cli/ego_script(自由脚本逃生舱)。分类见: tools / navigate / observe / input / keyboard-mouse / form / wait / network / login / script / doctor。用 `topic` 查询，或直接给工具名。",
	tools: "工具清单: ego_status, ego_space_open, ego_space_close, ego_snapshot, ego_navigate, ego_click(+double), ego_fill, ego_js, ego_cdp, ego_screenshot(+selector), ego_page_info, ego_wait, ego_wait_for_selector, ego_wait_for_url, ego_wait_for_response, ego_key(+text/type), ego_hover, ego_read_element, ego_select, ego_drag, ego_scroll, ego_upload, ego_check, ego_dialog, ego_download, ego_http, ego_captcha, ego_auth_flush, ego_help, ego_doctor, ego_cli, ego_script。",
	navigate: "ego_navigate: 打开URL或切tab(同任务复用当前tab)。ego_wait_for_url: 等跳转(登录/分页)。",
	observe: "ego_snapshot: 整页语义树(带[ref]/loc供点击); ego_page_info: url/标题/视口/滚动/对话框/人机验证; ego_read_element: 读单元素文本/HTML/值/属性/可见性/计数; ego_screenshot(+selector): 整页或元素截图。",
	input: "ego_click(selector/坐标, double双击); ego_fill(填框); ego_key(press组合键 或 text连续键入); ego_check(勾选/取消); ego_select(下拉); ego_upload(文件上传); ego_dialog(接受/取消JS对话框)。",
	"keyboard-mouse": "ego_key: 键盘(press/text); ego_hover: 悬停; ego_drag: 拖拽(元素或坐标); ego_scroll: 滚轮/滚到元素; ego_click: 点击/双击。",
	form: "ego_fill 填输入框; ego_select 下拉; ego_check checkbox/radio; ego_upload 文件; ego_key 回车/Tab导航; ego_dialog 处理提交弹窗。",
	wait: "ego_wait(固定毫秒); ego_wait_for_selector(等元素出现/消失); ego_wait_for_url(等跳转); ego_wait_for_response(等网络响应并可读body)。",
	network: "ego_http: 发HTTP请求(默认浏览器上下文 fetch.browser, mode=server走Node fetch.server); ego_wait_for_response: 等并读接口响应。",
	download: "ego_download: 等下载事件并落到指定路径(triggerSelector/triggerScript + 可选 savePath)。",
	captcha: "ego_captcha: 检测页面人机验证(CAPTCHA)并返回{detected,kind}; 检测到请让用户去 ego 浏览器完成; ego_page_info 也附带 humanCheck。",
	login: "ego_auth_flush: 把登录cookie落盘到ego profile; 观察窗登录引导条+『已登录,保存』按钮触发同一动作。",
	script: "ego_cli / ego_script: 原样运行任意 ego-browser nodejs heredoc脚本(page/browser/taskSpaces/site/fetch/cdp预载)。ego_script额外返回 duration/timedOut。",
	doctor: "ego_doctor: 体检环境(浏览器候选、vendored runtime、状态目录、CDP端口、任务空间)。"
};

//#endregion
//#region src/captcha.ts
/**
* src/captcha.ts — human-verification (CAPTCHA) detection probe.
*
* Standalone data module: HUMAN_CHECK_PROBE is a string that gets serialized
* into a `page.evaluate` call to identify reCAPTCHA / hCaptcha / Turnstile /
* Cloudflare / generic captcha. When changing probe heuristics, note that
* bin/ego-cast-worker.mjs (now src/worker/ego-cast-worker.ts) has a similar
* probe (HUMAN_PROBE_JS) — the two must stay in sync.
*/
const HUMAN_CHECK_PROBE = `(() => {
  const sel = [
    'iframe[src*="recaptcha"]', '.g-recaptcha', '[data-sitekey]',
    '.h-captcha', 'iframe[src*="hcaptcha"]',
    '.cf-turnstile', 'iframe[src*="turnstile"]',
    'iframe[src*="cloudflare"]', '#challenge-form', '.challenge-form',
    '#captcha', '.captcha'
  ].join(',');
  const el = document.querySelector(sel);
  if (el) {
    const html = (el.outerHTML || '') + (el.closest('body') && el.closest('body').innerHTML ? '' : '');
    const s = String(html);
    if (/recaptcha|g-recaptcha/i.test(s)) return { detected: true, kind: 'recaptcha' };
    if (/hcaptcha|h-captcha/i.test(s)) return { detected: true, kind: 'hcaptcha' };
    if (/turnstile|cf-turnstile/i.test(s)) return { detected: true, kind: 'turnstile' };
    if (/cloudflare|challenge-form/i.test(s)) return { detected: true, kind: 'cloudflare' };
    return { detected: true, kind: 'captcha' };
  }
  const txt = (document.body ? document.body.innerText || '' : '').slice(0, 120000);
  const lower = txt.toLowerCase();
  if (/verify you are human|your activity looks unusual|captcha|i.?m not a robot|人机验证|安全验证|我是人类|验证码|滑块验证|拖动滑块|点击.*验证/.test(lower)) {
    return { detected: true, kind: 'captcha' };
  }
  return { detected: false, kind: null };
})()`;

//#endregion
//#region src/config.ts
const backend = z.union([
	"auto",
	"cdp",
	"ffmpeg"
]);
const profile = z.union([
	"low",
	"balanced",
	"high"
]);
const encoder = z.union([
	"auto",
	"software",
	"h264_mf",
	"h264_nvenc",
	"h264_qsv",
	"h264_amf",
	"h264_videotoolbox",
	"h264_vaapi"
]);
const Config$1 = z.object({
	chromePath: z.string().description("Path to Chrome/Chromium. Empty = auto-detect."),
	captureBackend: backend.description("Capture backend: auto, cdp, or ffmpeg."),
	streamProfile: profile.description("Capture quality profile."),
	cdpFps: z.number().min(5).max(30).step(1).description("CDP preview FPS."),
	cdpQuality: z.number().min(1).max(100).step(1).description("CDP JPEG quality."),
	cdpMaxWidth: z.number().min(320).max(1920).step(40).description("CDP frame max width."),
	cdpBackstopIntervalMs: z.number().min(1e3).max(1e4).step(100).description("CDP recovery screenshot interval."),
	ffmpegFps: z.number().min(5).max(30).step(1).description("FFmpeg video FPS."),
	ffmpegMaxWidth: z.number().min(320).max(1920).step(40).description("FFmpeg video max width."),
	ffmpegBitrateKbps: z.number().min(500).max(2e4).step(250).description("FFmpeg target video bitrate in kbps."),
	ffmpegEncoder: encoder.description("FFmpeg H.264 encoder."),
	ffmpegPath: z.string().description("Custom FFmpeg path. Empty = detect PATH or managed install."),
	githubMirror: z.string().description("HTTPS base replacing https://github.com for managed downloads."),
	egoCliArgs: z.string().description("Extra args appended to `ego-browser nodejs` argv. Takes effect on the next ego_* call."),
	chromeArgs: z.string().description("Extra args appended to the Chrome launch argv. Takes effect on the next browser cold start (the browser is a singleton)."),
	castFpsCap: z.number().min(0).max(60).step(1),
	screencastQuality: z.number().min(1).max(100).step(1),
	screencastMaxWidth: z.number().min(320).max(1920).step(40),
	backstopIntervalMs: z.number().min(200).max(1e4).step(100)
});
/**
* Flags the user must NOT put in `egoCliArgs`: these ego-browser subcommands
* exit before the heredoc runs (--status/--stop/--help/...) or steal the
* browser window (--open), so appending them would break every ego_* tool.
* `--headless` is managed by EGO_LINUX_HEADLESS; `--sdk-path` is allowed.
*/
const EGO_CLI_BLOCKED = new Set([
	"--status",
	"--stop",
	"--open",
	"--spaces",
	"--spaces-daemon",
	"--prune-spaces",
	"--import-chrome-profile",
	"--install-desktop-entry",
	"--help",
	"-h"
]);
/**
* Flags the user must NOT put in `chromeArgs`: these are managed by the
* launcher / EGO_LINUX_PROXY and overriding them would break CDP control,
* profile isolation, or the proxy bypass list. `--proxy-server` should go
* through EGO_LINUX_PROXY (which also sets the bypass list).
*/
const CHROME_BLOCKED = new Set([
	"--user-data-dir",
	"--remote-debugging-port",
	"--remote-allow-origins",
	"--headless",
	"--no-startup-window",
	"--proxy-server",
	"--proxy-bypass-list"
]);
/**
* Shell-like tokenizer for user-supplied arg strings. Handles single/double
* quotes and backslash escapes; bare whitespace separates tokens. Returns []
* for empty/whitespace-only input. Used for both `egoCliArgs` and `chromeArgs`
* (mirrored in runtime/ego-linux/src/chrome.mjs for the Chrome side, since the
* runtime must not import from src/).
*/
function tokenizeArgs(input) {
	if (typeof input !== "string") return [];
	const out = [];
	let cur = "";
	let i = 0;
	let quote = null;
	while (i < input.length) {
		const c = input[i];
		if (quote) {
			if (c === "\\") {
				const next = input[i + 1];
				if (next !== void 0) {
					cur += next;
					i += 2;
					continue;
				}
			} else if (c === quote) {
				quote = null;
				i += 1;
				continue;
			}
			cur += c;
			i += 1;
			continue;
		}
		if (c === "\"" || c === "'") {
			quote = c;
			i += 1;
			continue;
		}
		if (c === "\\") {
			const next = input[i + 1];
			if (next !== void 0) {
				cur += next;
				i += 2;
				continue;
			}
			i += 1;
			continue;
		}
		if (c === " " || c === "	" || c === "\n" || c === "\r") {
			if (cur !== "") {
				out.push(cur);
				cur = "";
			}
			i += 1;
			continue;
		}
		cur += c;
		i += 1;
	}
	if (cur !== "") out.push(cur);
	return out;
}
/**
* Split a raw arg string into tokens, dropping any token (and, for `--flag
* value` pairs, its value) that appears in `blocked`. A "blocked" token with a
* `=` attached (e.g. `--headless=new`) is also dropped. Returns the surviving
* tokens. Exposed for tests and for the runtime to mirror.
*/
function filterArgs(raw, blocked) {
	const tokens = tokenizeArgs(raw);
	const kept = [];
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		const key = tok.includes("=") ? tok.slice(0, tok.indexOf("=")) : tok;
		if (blocked.has(key)) {
			if (!tok.includes("=") && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) i += 1;
			continue;
		}
		kept.push(tok);
	}
	return kept;
}
const finiteIn = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
function oneOf(value, values, fallback) {
	return typeof value === "string" && values.includes(value) ? value : fallback;
}
function resolveConfig(config = {}) {
	const legacyFps = finiteIn(config.castFpsCap, 0, 60) ? config.castFpsCap === 0 ? 20 : Math.max(5, Math.min(30, config.castFpsCap)) : 20;
	const selectedProfile = oneOf(config.streamProfile, [
		"low",
		"balanced",
		"high"
	], "balanced");
	const profileDefaults = selectedProfile === "low" ? {
		fps: 15,
		width: 960,
		bitrateKbps: 2e3
	} : selectedProfile === "high" ? {
		fps: 30,
		width: 1600,
		bitrateKbps: 8e3
	} : {
		fps: 20,
		width: 1280,
		bitrateKbps: 4e3
	};
	return {
		chromePath: typeof config.chromePath === "string" ? config.chromePath : "",
		captureBackend: oneOf(config.captureBackend, [
			"auto",
			"cdp",
			"ffmpeg"
		], "auto"),
		streamProfile: selectedProfile,
		cdpFps: finiteIn(config.cdpFps, 5, 30) ? config.cdpFps : legacyFps,
		cdpQuality: finiteIn(config.cdpQuality, 1, 100) ? config.cdpQuality : finiteIn(config.screencastQuality, 1, 100) ? config.screencastQuality : 55,
		cdpMaxWidth: finiteIn(config.cdpMaxWidth, 320, 1920) ? config.cdpMaxWidth : finiteIn(config.screencastMaxWidth, 320, 1920) ? config.screencastMaxWidth : 960,
		cdpBackstopIntervalMs: finiteIn(config.cdpBackstopIntervalMs, 1e3, 1e4) ? config.cdpBackstopIntervalMs : finiteIn(config.backstopIntervalMs, 200, 1e4) ? Math.max(1e3, config.backstopIntervalMs) : 3e3,
		ffmpegFps: finiteIn(config.ffmpegFps, 5, 30) ? config.ffmpegFps : profileDefaults.fps,
		ffmpegMaxWidth: finiteIn(config.ffmpegMaxWidth, 320, 1920) ? config.ffmpegMaxWidth : profileDefaults.width,
		ffmpegBitrateKbps: finiteIn(config.ffmpegBitrateKbps, 500, 2e4) ? config.ffmpegBitrateKbps : profileDefaults.bitrateKbps,
		ffmpegEncoder: oneOf(config.ffmpegEncoder, [
			"auto",
			"software",
			"h264_mf",
			"h264_nvenc",
			"h264_qsv",
			"h264_amf",
			"h264_videotoolbox",
			"h264_vaapi"
		], "auto"),
		ffmpegPath: typeof config.ffmpegPath === "string" ? config.ffmpegPath : "",
		githubMirror: typeof config.githubMirror === "string" ? config.githubMirror : "",
		egoCliArgs: typeof config.egoCliArgs === "string" ? config.egoCliArgs : "",
		chromeArgs: typeof config.chromeArgs === "string" ? config.chromeArgs : ""
	};
}

//#endregion
//#region src/settings.ts
/** Settings namespace under which ego-browser config persists. */
const SETTINGS_NAMESPACE = settingsNamespace("ego-browser");
const SHARED_SCOPE_KEY = Symbol.for("@dsh-external/ego-browser.settings-scope");
function getSharedScope() {
	const existing = globalThis[SHARED_SCOPE_KEY];
	if (existing) return existing;
	const fresh = {
		scope: null,
		refs: 0
	};
	globalThis[SHARED_SCOPE_KEY] = fresh;
	return fresh;
}
/**
* Mirror of the dsh-settings internal `isUnloading` guard. The cordis const
* enum for fiber state is erased at compile time, so the literal states are
* matched numerically: 4 = DISPOSED, 5 = UNLOADING.
*/
function isUnloading(ctx) {
	const state = ctx.fiber?.state;
	return state === 4 || state === 5;
}
/**
* Install the `ego-browser` settings namespace and return the bridge.
*
* The settings service is reached through `ctx.inject(['settings'], ...)` so a
* composition without a settings provider still loads the plugin (entry-source
* fallback, no persistence). Multi-fiber dedupe is handled by catching the
* `"already registered"` rejection — host composition may mount several
* concurrent fibers of this plugin, and only the first registration owns the
* namespace.
*/
function installEgoBrowserSettings(ctx, entry) {
	const listeners = /* @__PURE__ */ new Set();
	let source = () => entry;
	const notify = () => {
		for (const listener of [...listeners]) listener();
	};
	ctx.inject?.(["settings"], (sctx) => {
		const sharedScope = getSharedScope();
		let scope = sharedScope.scope;
		if (!scope) try {
			scope = sctx.settings.register(SETTINGS_NAMESPACE, Config$1, { base: entry });
			sharedScope.scope = scope;
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes("already registered")) throw error;
			ctx.logger?.("ego-browser")?.warn("settings namespace already registered outside the shared bridge");
			return;
		}
		sharedScope.refs += 1;
		source = () => scope.get();
		const offScopeWatch = scope.watch(() => {
			if (isUnloading(ctx)) return;
			notify();
		});
		sctx.effect?.(() => () => {
			offScopeWatch?.();
			sharedScope.refs = Math.max(0, sharedScope.refs - 1);
			if (sharedScope.refs === 0 && sharedScope.scope === scope) sharedScope.scope = null;
			if (isUnloading(ctx)) return;
			source = () => entry;
			notify();
		});
		notify();
	});
	return {
		source: () => source(),
		onChange: (cb) => {
			listeners.add(cb);
			return () => {
				listeners.delete(cb);
			};
		}
	};
}

//#endregion
//#region src/ffmpeg-manifest.ts
const BTBN_TAG = "autobuild-2026-08-17-13-05";
const BTBN_BASE = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${BTBN_TAG}`;
const STATIC_BASE = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1";
const FFMPEG_MANIFEST = Object.freeze({
	"win32-x64": Object.freeze({
		provider: "btbn",
		buildId: BTBN_TAG,
		archiveType: "tar",
		size: 170641412,
		url: `${BTBN_BASE}/ffmpeg-N-126188-g426841da9d-win64-gpl.zip`,
		sha256: "423d30b197e52e20e0702278a30bc63e006cc383c968935874c4c13dda9eb299",
		executableName: "ffmpeg.exe",
		archiveExecutable: /(?:^|\/)bin\/ffmpeg\.exe$/i
	}),
	"win32-arm64": Object.freeze({
		provider: "btbn",
		buildId: BTBN_TAG,
		archiveType: "tar",
		size: 116275753,
		url: `${BTBN_BASE}/ffmpeg-N-126188-g426841da9d-winarm64-gpl.zip`,
		sha256: "451d181c0774f19dc7c30711911f3aad4f4ee4feb1cecb7b5efc1b895e093c67",
		executableName: "ffmpeg.exe",
		archiveExecutable: /(?:^|\/)bin\/ffmpeg\.exe$/i
	}),
	"linux-x64": Object.freeze({
		provider: "btbn",
		buildId: BTBN_TAG,
		archiveType: "tar",
		size: 127977972,
		url: `${BTBN_BASE}/ffmpeg-N-126188-g426841da9d-linux64-gpl.tar.xz`,
		sha256: "646080fba1f295446fdf35fbdd4bad6ab934a30f9fcb86f3e96ad50eaff06c82",
		executableName: "ffmpeg",
		archiveExecutable: /(?:^|\/)bin\/ffmpeg$/
	}),
	"linux-arm64": Object.freeze({
		provider: "btbn",
		buildId: BTBN_TAG,
		archiveType: "tar",
		size: 109615592,
		url: `${BTBN_BASE}/ffmpeg-N-126188-g426841da9d-linuxarm64-gpl.tar.xz`,
		sha256: "7cda2218fe0107e449631eb6b850146a4522ebf4ed13733010d0aada9858b119",
		executableName: "ffmpeg",
		archiveExecutable: /(?:^|\/)bin\/ffmpeg$/
	}),
	"darwin-x64": Object.freeze({
		provider: "evermeet",
		buildId: "ffmpeg-static-b6.1.1",
		archiveType: "gzip",
		size: 25296431,
		url: `${STATIC_BASE}/ffmpeg-darwin-x64.gz`,
		sha256: "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106",
		executableName: "ffmpeg"
	}),
	"darwin-arm64": Object.freeze({
		provider: "osxexperts",
		buildId: "ffmpeg-static-b6.1.1",
		archiveType: "gzip",
		size: 19246198,
		url: `${STATIC_BASE}/ffmpeg-darwin-arm64.gz`,
		sha256: "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa",
		executableName: "ffmpeg"
	})
});
function platformManifest(platform = process.platform, arch = process.arch) {
	return FFMPEG_MANIFEST[`${platform}-${arch}`] ?? null;
}
function rewriteGithubUrl(url, mirror = "") {
	if (!mirror || !url.startsWith("https://github.com/")) return url;
	let parsed;
	try {
		parsed = new URL(mirror);
	} catch {
		throw codedError$2("ffmpeg-mirror-invalid", "GitHub mirror must be a valid HTTPS URL");
	}
	if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw codedError$2("ffmpeg-mirror-invalid", "GitHub mirror must be an HTTPS base URL without credentials, query, or fragment");
	return `${parsed.toString().replace(/\/+$/, "")}${url.slice(18)}`;
}
function codedError$2(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

//#endregion
//#region src/gateway.ts
/** HTTP route prefix owning every ego-browser API request. */
const API_PREFIX = "/ego/api";
/** Config keys the `set` endpoint accepts (allow-list; unknown keys are dropped). */
const ALLOWED_KEYS = new Set([
	"chromePath",
	"captureBackend",
	"streamProfile",
	"cdpFps",
	"cdpQuality",
	"cdpMaxWidth",
	"cdpBackstopIntervalMs",
	"ffmpegFps",
	"ffmpegMaxWidth",
	"ffmpegBitrateKbps",
	"ffmpegEncoder",
	"ffmpegPath",
	"githubMirror"
]);
/**
* Register the `/ego/api` HTTP route on the host's web server.
*
* The route reads/writes the `ego-browser` settings namespace in-process
* through the bridge + `ctx.settings`. The settings service is optional:
* when absent, `get` degrades to the entry source and `set` returns a
* clear error.
*/
function registerEgoBrowserGateway(ctx, bridge, ffmpegManager) {
	let settings;
	ctx.inject?.(["settings"], (sctx) => {
		settings = sctx.settings;
		return () => {
			settings = void 0;
		};
	});
	ctx.effect?.(() => {
		if (!ctx.webServer || typeof ctx.webServer.register !== "function") return;
		return ctx.webServer.register({
			kind: "prefix",
			path: API_PREFIX,
			handler: async (reqRaw, resRaw) => {
				const req = reqRaw;
				const res = resRaw;
				if (req.method !== "POST") {
					writeJson(res, 405, envelopeError("method-not-allowed", "POST only"));
					return;
				}
				const origin = req.headers.origin;
				if (origin) {
					let originHost;
					try {
						originHost = new URL(origin).host;
					} catch {
						writeJson(res, 400, envelopeError("invalid-origin", "invalid Origin header"));
						return;
					}
					if (!req.headers.host || originHost !== req.headers.host) {
						writeJson(res, 403, envelopeError("origin-not-allowed", "same-origin requests only"));
						return;
					}
				}
				if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
					writeJson(res, 415, envelopeError("content-type-not-supported", "application/json required"));
					return;
				}
				const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
				const method = pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(`${API_PREFIX}/`.length) : void 0;
				if (method === void 0 || method.includes("/")) {
					writeJson(res, 404, envelopeError("not-found", "unknown ego-browser API method"));
					return;
				}
				try {
					const body = await readJsonBody(req);
					if (method === "get") {
						const config = resolveConfig(bridge.source());
						writeJson(res, 200, envelopeOk({
							config,
							ffmpegStatus: ffmpegManager ? await ffmpegManager.check({
								configuredPath: config.ffmpegPath,
								requestedEncoder: config.ffmpegEncoder
							}) : null
						}));
					} else if (method === "set") writeJson(res, 200, envelopeOk(await handleSet(body, settings, bridge, ffmpegManager)));
					else if (method === "ffmpeg-status") writeJson(res, 200, envelopeOk({ ffmpegStatus: ffmpegManager?.status() || null }));
					else if (method === "ffmpeg-check") {
						const config = resolveConfig(bridge.source());
						writeJson(res, 200, envelopeOk({ ffmpegStatus: await ffmpegManager?.check({
							configuredPath: config.ffmpegPath,
							requestedEncoder: config.ffmpegEncoder
						}) || null }));
					} else if (method === "ffmpeg-install") {
						const config = resolveConfig(bridge.source());
						const githubMirror = typeof body.githubMirror === "string" ? body.githubMirror : config.githubMirror;
						const ffmpegStatus = ffmpegManager?.startInstall({
							githubMirror,
							configuredPath: config.ffmpegPath,
							requestedEncoder: config.ffmpegEncoder
						});
						writeJson(res, 200, envelopeOk({ ffmpegStatus: ffmpegStatus || null }));
					} else writeJson(res, 404, envelopeError("not-found", `unknown ego-browser API method "${method}"`));
				} catch (error) {
					const e = error;
					const message = e instanceof Error ? e.message : String(error);
					writeJson(res, e?.code === "ffmpeg-unavailable" ? 409 : e?.code === "ffmpeg-mirror-invalid" ? 400 : 500, envelopeError(e?.code || "internal", message));
				}
			}
		});
	}, "ego-browser: /ego/api routes");
}
/**
* Handle the `set` method: validate the patch, write the user layer, return
* the new resolved config.
*/
async function handleSet(body, settings, bridge, ffmpegManager) {
	const patch = extractPatch(body);
	if (Object.keys(patch).length === 0) return {
		config: resolveConfig(bridge.source()),
		ffmpegStatus: ffmpegManager?.status() || null
	};
	if (settings === void 0 || !settings.update) throw new Error("ego-browser: settings service is unavailable — configuration cannot be written");
	const next = resolveConfig({
		...resolveConfig(bridge.source()),
		...patch
	});
	if (patch.githubMirror) rewriteGithubUrl("https://github.com/example/repo/releases/download/tag/file", patch.githubMirror);
	if ((patch.captureBackend === "ffmpeg" || (Object.hasOwn(patch, "ffmpegPath") || Object.hasOwn(patch, "ffmpegEncoder")) && next.captureBackend === "ffmpeg") && ffmpegManager) {
		const status = await ffmpegManager.check({
			configuredPath: next.ffmpegPath,
			requestedEncoder: next.ffmpegEncoder
		});
		if (!status.canSelectFfmpeg) {
			const error = new Error(status.reason || "FFmpeg is not installed or does not satisfy capture requirements");
			error.code = "ffmpeg-unavailable";
			throw error;
		}
	}
	await settings.update(SETTINGS_NAMESPACE, patch);
	const ffmpegStatus = Object.hasOwn(patch, "ffmpegPath") && ffmpegManager ? await ffmpegManager.check({
		configuredPath: next.ffmpegPath,
		requestedEncoder: next.ffmpegEncoder
	}) : ffmpegManager?.status() || null;
	return {
		config: resolveConfig(bridge.source()),
		ffmpegStatus
	};
}
/**
* Extract and validate the patch from the request body.
*
* JSON wire boundary: null = "delete" (filtered), undefined never crosses
* JSON. Unknown keys are dropped (the settings service is non-strict and
* would otherwise store them). String keys (chromePath) are accepted.
*/
function extractPatch(body) {
	if (!isObject(body)) return {};
	const raw = Reflect.get(body, "patch");
	if (!isObject(raw)) return {};
	const normalized = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!ALLOWED_KEYS.has(key)) continue;
		if (value === null || value === void 0) continue;
		if (typeof value === "string") normalized[key] = value;
		else if (typeof value === "number" && Number.isFinite(value)) normalized[key] = value;
	}
	return normalized;
}
/** Read and parse a JSON body from a node:http request. */
async function readJsonBody(req, maxBytes = 16384) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > maxBytes) throw new Error("request body too large");
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text === "") return {};
	return JSON.parse(text);
}
/** Write a JSON response envelope. */
function writeJson(res, status, body) {
	const json = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json" });
	res.end(json);
}
/** Build a success envelope. */
function envelopeOk(value) {
	return {
		ok: true,
		value
	};
}
/** Build an error envelope. */
function envelopeError(code, message) {
	return {
		ok: false,
		error: {
			code,
			message
		}
	};
}
/** Narrow unknown to a non-null object. */
function isObject(value) {
	return typeof value === "object" && value !== null;
}

//#endregion
//#region src/ffmpeg-probe.ts
function runFfmpegProbe(path, argv, { spawn: spawn$1 = spawn, timeoutMs = 3e3 } = {}) {
	return new Promise((resolve$1) => {
		let child;
		let output = "";
		let settled = false;
		const finish = (ok) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve$1({
				ok,
				output
			});
		};
		try {
			child = spawn$1(path, argv, {
				shell: false,
				windowsHide: true,
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				]
			});
		} catch {
			resolve$1({
				ok: false,
				output
			});
			return;
		}
		child.stdout?.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.once("error", () => finish(false));
		child.once("exit", (code) => finish(code === 0));
		const timer = setTimeout(() => {
			try {
				child.kill("SIGTERM");
			} catch {}
			finish(false);
		}, timeoutMs);
	});
}
async function probeFfmpeg(path, { platform = process.platform, env = process.env, spawn: spawn$1 = spawn, requestedEncoder = "auto" } = {}) {
	const versionResult = await runFfmpegProbe(path, ["-version"], { spawn: spawn$1 });
	if (!versionResult.ok) throw codedError$1("ffmpeg-not-executable", `FFmpeg is not executable: ${path}`);
	const version = versionResult.output.split(/\r?\n/, 1)[0] || "FFmpeg";
	if (platform === "win32") {
		const support = await runFfmpegProbe(path, [
			"-hide_banner",
			"-h",
			"filter=gfxcapture"
		], { spawn: spawn$1 });
		if (!support.ok || !/Filter gfxcapture\b/.test(support.output)) throw codedError$1("ffmpeg-gfxcapture-unavailable", "FFmpeg does not support Windows gfxcapture");
	} else if (platform === "darwin") {
		const devices = await runFfmpegProbe(path, ["-hide_banner", "-devices"], { spawn: spawn$1 });
		if (!devices.ok || !/avfoundation/i.test(devices.output)) throw codedError$1("ffmpeg-capture-input-unavailable", "FFmpeg does not support avfoundation capture");
	} else if (platform === "linux") {
		if (env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY) throw codedError$1("ffmpeg-platform-unsupported", "Wayland capture is not supported");
		const devices = await runFfmpegProbe(path, ["-hide_banner", "-devices"], { spawn: spawn$1 });
		if (!devices.ok || !/x11grab/i.test(devices.output)) throw codedError$1("ffmpeg-capture-input-unavailable", "FFmpeg does not support x11grab capture");
	}
	const encoders = requestedEncoder === "auto" ? platform === "win32" ? [
		"h264_mf",
		"h264_nvenc",
		"h264_qsv",
		"h264_amf",
		"libx264"
	] : platform === "darwin" ? ["h264_videotoolbox", "libx264"] : [
		"h264_nvenc",
		"h264_vaapi",
		"h264_qsv",
		"libx264"
	] : [requestedEncoder === "software" ? "libx264" : requestedEncoder];
	for (const encoder$1 of encoders) if ((await runFfmpegProbe(path, [
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		"color=size=64x64:rate=1",
		"-frames:v",
		"1",
		"-c:v",
		encoder$1,
		"-f",
		"null",
		"-"
	], {
		spawn: spawn$1,
		timeoutMs: 5e3
	})).ok) return {
		version,
		encoder: encoder$1
	};
	throw codedError$1("ffmpeg-encoder-unavailable", "FFmpeg has no usable H.264 encoder");
}
function codedError$1(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

//#endregion
//#region src/ffmpeg-installation.ts
function defaultFfmpegCacheRoot(home = homedir()) {
	return join(home, ".dsh", "cache", "ego-browser", "ffmpeg");
}
const SHARED_MANAGERS_KEY = Symbol.for("@dsh-external/ego-browser.ffmpeg-installation-managers");
function getSharedManagers() {
	const existing = globalThis[SHARED_MANAGERS_KEY];
	if (existing) return existing;
	const fresh = /* @__PURE__ */ new Map();
	globalThis[SHARED_MANAGERS_KEY] = fresh;
	return fresh;
}
function getSharedFfmpegInstallationManager(options = {}) {
	const platform = options.platform || process.platform;
	const arch = options.arch || process.arch;
	const cacheRoot = options.cacheRoot || defaultFfmpegCacheRoot();
	const key = `${platform}:${arch}:${cacheRoot}`;
	const managers = getSharedManagers();
	if (!managers.has(key)) managers.set(key, new FfmpegInstallationManager({
		...options,
		platform,
		arch,
		cacheRoot
	}));
	return managers.get(key);
}
var FfmpegInstallationManager = class {
	getConfig;
	platform;
	arch;
	env;
	cacheRoot;
	fetch;
	spawn;
	manifest;
	installPromise;
	checkPromise;
	checkKey;
	statusValue;
	constructor({ getConfig = () => ({}), platform = process.platform, arch = process.arch, env = process.env, cacheRoot = defaultFfmpegCacheRoot(), fetchImpl = globalThis.fetch, spawn: spawn$1 = spawn } = {}) {
		this.getConfig = getConfig;
		this.platform = platform;
		this.arch = arch;
		this.env = env;
		this.cacheRoot = cacheRoot;
		this.fetch = fetchImpl;
		this.spawn = spawn$1;
		this.manifest = platformManifest(platform, arch);
		this.installPromise = null;
		this.checkPromise = null;
		this.checkKey = null;
		this.statusValue = this.#baseStatus();
	}
	#baseStatus() {
		const unsupported = this.platform === "linux" && (this.env.XDG_SESSION_TYPE === "wayland" || this.env.WAYLAND_DISPLAY);
		return {
			state: unsupported ? "unsupported" : "missing",
			source: null,
			path: null,
			version: null,
			encoder: null,
			progress: null,
			canDownload: !unsupported && !!this.manifest,
			canSelectFfmpeg: false,
			updateAvailable: false,
			reason: unsupported ? "Wayland capture is not supported" : null,
			candidates: [],
			platform: this.platform,
			arch: this.arch,
			buildId: this.manifest?.buildId || null
		};
	}
	status() {
		return structuredClone(this.statusValue);
	}
	managedPath() {
		if (!this.manifest) return null;
		return join(this.cacheRoot, `${this.platform}-${this.arch}`, this.manifest.buildId, this.manifest.executableName);
	}
	async check({ configuredPath, requestedEncoder = "auto" } = {}) {
		if (this.installPromise) return this.status();
		const key = JSON.stringify([configuredPath ?? "", requestedEncoder]);
		if (this.checkPromise) {
			if (this.checkKey === key) return this.checkPromise;
			await this.checkPromise.catch(() => {});
		}
		if (this.statusValue.state === "unsupported") return this.status();
		this.checkKey = key;
		const promise = this.#check(configuredPath, requestedEncoder).finally(() => {
			if (this.checkPromise === promise) {
				this.checkPromise = null;
				this.checkKey = null;
			}
		});
		this.checkPromise = promise;
		return this.checkPromise;
	}
	async #check(configuredPath, requestedEncoder = "auto") {
		this.#set({
			state: "checking",
			reason: null,
			progress: null,
			canSelectFfmpeg: false
		});
		const custom = configuredPath ?? this.getConfig().ffmpegPath ?? "";
		const candidates = [];
		if (custom) candidates.push({
			source: "custom",
			path: custom
		});
		candidates.push({
			source: "system",
			path: "ffmpeg"
		});
		const managed = this.managedPath();
		if (managed) candidates.push({
			source: "managed",
			path: managed
		});
		const results = [];
		for (const candidate of candidates) try {
			const probe = await probeFfmpeg(candidate.path, {
				platform: this.platform,
				env: this.env,
				spawn: this.spawn,
				requestedEncoder
			});
			results.push({
				...candidate,
				usable: true,
				version: probe.version,
				encoder: probe.encoder
			});
			this.#set({
				state: "ready",
				source: candidate.source,
				path: candidate.path,
				version: probe.version,
				encoder: probe.encoder,
				canSelectFfmpeg: true,
				canDownload: !!this.manifest,
				reason: null,
				candidates: results,
				updateAvailable: candidate.source === "managed" && !normalize(candidate.path).includes(normalize(this.manifest?.buildId || ""))
			});
			return this.status();
		} catch (error) {
			const e = error;
			results.push({
				...candidate,
				usable: false,
				code: e.code || "ffmpeg-unavailable",
				reason: e.message
			});
		}
		this.#set({
			...this.#baseStatus(),
			state: "missing",
			candidates: results,
			reason: results[0]?.reason || "No compatible FFmpeg installation was found"
		});
		return this.status();
	}
	async resolvedPath() {
		const status = this.statusValue.state === "ready" ? this.status() : await this.check();
		return status.canSelectFfmpeg ? status.path : null;
	}
	install({ githubMirror, configuredPath, requestedEncoder = "auto" } = {}) {
		if (this.installPromise) return this.installPromise;
		if (!this.manifest) return Promise.reject(codedError("ffmpeg-platform-unsupported", `No managed FFmpeg build for ${this.platform}-${this.arch}`));
		this.installPromise = this.#install(githubMirror ?? this.getConfig().githubMirror ?? "", configuredPath ?? this.getConfig().ffmpegPath ?? "", requestedEncoder).finally(() => {
			this.installPromise = null;
		});
		return this.installPromise;
	}
	startInstall(options = {}) {
		this.install(options).catch(() => {});
		return this.status();
	}
	async #install(githubMirror, configuredPath, requestedEncoder) {
		const manifest = this.manifest;
		const platformRoot = join(this.cacheRoot, `${this.platform}-${this.arch}`);
		const tempRoot = join(platformRoot, `.install-${randomUUID()}`);
		const archivePath = join(tempRoot, `archive.${manifest.archiveType === "gzip" ? "gz" : "pkg"}`);
		const extractedPath = join(tempRoot, manifest.executableName);
		const finalRoot = join(platformRoot, manifest.buildId);
		const finalPath = join(finalRoot, manifest.executableName);
		let releaseLock = null;
		let backup = null;
		let published = false;
		try {
			await mkdir(platformRoot, { recursive: true });
			releaseLock = await acquireInstallLock(platformRoot);
			await cleanupInterruptedInstalls(platformRoot);
			if (manifest.archiveType === "tar") await ensureTarAvailable(this.spawn);
			await mkdir(tempRoot, { recursive: true });
			const url = rewriteGithubUrl(manifest.url, githubMirror);
			this.#set({
				state: "downloading",
				reason: null,
				progress: {
					receivedBytes: 0,
					totalBytes: manifest.size,
					percent: 0
				},
				canSelectFfmpeg: false
			});
			const digest = await downloadFile(url, archivePath, {
				fetchImpl: this.fetch,
				expectedSize: manifest.size,
				onProgress: (progress) => this.#set({
					state: "downloading",
					progress
				})
			});
			this.#set({
				state: "verifying",
				progress: null
			});
			if (digest !== manifest.sha256) throw codedError("ffmpeg-checksum-mismatch", "Downloaded FFmpeg archive failed SHA-256 verification");
			this.#set({ state: "extracting" });
			if (manifest.archiveType === "gzip") await pipeline(createReadStream(archivePath), createGunzip(), createWriteStream(extractedPath, { mode: 493 }));
			else await extractWithTar(archivePath, tempRoot, extractedPath, manifest.archiveExecutable, this.spawn);
			if (this.platform !== "win32") await chmod(extractedPath, 493);
			if (this.platform === "darwin") await prepareMacExecutable(extractedPath, this.arch, this.spawn);
			this.#set({ state: "probing" });
			const probe = await probeFfmpeg(extractedPath, {
				platform: this.platform,
				env: this.env,
				spawn: this.spawn,
				requestedEncoder
			});
			const executableSha256 = await hashFile(extractedPath);
			await writeFile(join(tempRoot, "install.json"), JSON.stringify({
				provider: manifest.provider,
				buildId: manifest.buildId,
				archiveSha256: manifest.sha256,
				executableSha256,
				installedAt: (/* @__PURE__ */ new Date()).toISOString(),
				version: probe.version,
				encoder: probe.encoder
			}, null, 2));
			await rm(archivePath, { force: true });
			backup = `${finalRoot}.old-${randomUUID()}`;
			let hadExisting = false;
			try {
				await rename(finalRoot, backup);
				hadExisting = true;
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			await mkdir(dirname(finalRoot), { recursive: true });
			await rename(tempRoot, finalRoot);
			published = true;
			await access(finalPath, this.platform === "win32" ? constants.F_OK : constants.X_OK);
			if (hadExisting) await rm(backup, {
				recursive: true,
				force: true
			});
			backup = null;
			return await this.#check(configuredPath, requestedEncoder);
		} catch (error) {
			if (published) await rm(finalRoot, {
				recursive: true,
				force: true
			}).catch(() => {});
			if (backup) await rename(backup, finalRoot).catch(() => {});
			await rm(tempRoot, {
				recursive: true,
				force: true
			}).catch(() => {});
			const e = error;
			this.#set({
				state: "failed",
				reason: e.message,
				progress: null,
				canSelectFfmpeg: false,
				canDownload: true
			});
			throw error;
		} finally {
			await releaseLock?.();
		}
	}
	#set(patch) {
		this.statusValue = {
			...this.statusValue,
			...patch
		};
	}
};
async function acquireInstallLock(platformRoot) {
	const lockPath = join(platformRoot, ".install.lock");
	const token = randomUUID();
	for (let attempt = 0; attempt < 2; attempt += 1) try {
		const handle = await open(lockPath, "wx");
		await handle.writeFile(JSON.stringify({
			token,
			pid: process.pid,
			createdAt: (/* @__PURE__ */ new Date()).toISOString()
		}));
		return async () => {
			await handle.close().catch(() => {});
			if ((await readFile(lockPath, "utf8").then((text) => JSON.parse(text)).catch(() => null))?.token === token) await rm(lockPath, { force: true }).catch(() => {});
		};
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		const owner = await readFile(lockPath, "utf8").then((text) => JSON.parse(text)).catch(() => null);
		if (!owner?.pid || !isProcessAlive(owner.pid)) {
			await rm(lockPath, { force: true });
			continue;
		}
		throw codedError("ffmpeg-install-busy", "Another FFmpeg installation is already running");
	}
	throw codedError("ffmpeg-install-busy", "Another FFmpeg installation is already running");
}
function isProcessAlive(pid) {
	try {
		process.kill(Number(pid), 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}
async function cleanupInterruptedInstalls(platformRoot) {
	const entries = await readdir(platformRoot, { withFileTypes: true }).catch((error) => {
		return error.code === "ENOENT" ? [] : Promise.reject(error);
	});
	await Promise.all(entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(".install-")).map((entry) => rm(join(platformRoot, entry.name), {
		recursive: true,
		force: true
	})));
}
async function downloadFile(url, target, { fetchImpl = globalThis.fetch, expectedSize = null, onProgress = () => {}, maxBytes = 250 * 1024 * 1024 } = {}) {
	let current = url;
	let response;
	for (let redirects = 0; redirects <= 5; redirects += 1) {
		assertSafeDownloadUrl(current);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 15e3);
		try {
			response = await fetchImpl(current, {
				redirect: "manual",
				signal: controller.signal
			});
		} finally {
			clearTimeout(timer);
		}
		if (![
			301,
			302,
			303,
			307,
			308
		].includes(response.status)) break;
		const location = response.headers.get("location");
		if (!location) throw codedError("ffmpeg-download-failed", "FFmpeg download redirect omitted Location");
		current = new URL(location, current).toString();
		await response.body?.cancel().catch(() => {});
		if (!current.startsWith("https://")) throw codedError("ffmpeg-download-failed", "FFmpeg download refused a non-HTTPS redirect");
		if (redirects === 5) throw codedError("ffmpeg-download-failed", "Too many FFmpeg download redirects");
	}
	if (!response?.ok || !response.body) throw codedError("ffmpeg-download-failed", `FFmpeg download failed with HTTP ${response?.status || 0}`);
	const declared = Number(response.headers.get("content-length")) || expectedSize || null;
	const hash = createHash("sha256");
	const file = await open(target, "w");
	let received = 0;
	const reader = response.body.getReader();
	try {
		while (true) {
			const { done, value } = await readChunk(reader, 3e4);
			if (done) break;
			const buffer = Buffer.from(value);
			received += buffer.length;
			if (received > maxBytes) throw codedError("ffmpeg-download-failed", "FFmpeg archive exceeds the allowed size");
			hash.update(buffer);
			await file.write(buffer);
			onProgress({
				receivedBytes: received,
				totalBytes: declared,
				percent: declared ? Math.min(100, Math.round(received * 100 / declared)) : null
			});
		}
	} finally {
		await reader.cancel().catch(() => {});
		await file.close();
	}
	return hash.digest("hex");
}
async function ensureTarAvailable(spawn$1) {
	try {
		await runCommand("tar", ["--version"], spawn$1, 5e3);
	} catch {
		throw codedError("ffmpeg-extractor-unavailable", "The managed FFmpeg archive requires the system tar extractor");
	}
}
function assertSafeDownloadUrl(value) {
	const url = new URL(value);
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (url.protocol !== "https:" || host === "localhost" || host.endsWith(".localhost") || isPrivateIp(host)) throw codedError("ffmpeg-download-failed", "FFmpeg downloads require a public HTTPS destination");
}
function isPrivateIp(host) {
	const family = isIP(host);
	if (family === 4) {
		const [a, b] = host.split(".").map(Number);
		return a === 10 || a === 127 || a === 0 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
	}
	if (family === 6) return host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd");
	return false;
}
async function extractWithTar(archivePath, tempRoot, destination, matcher, spawn$1) {
	const matches = (await runCommand("tar", ["-tf", archivePath], spawn$1, 15e3)).stdout.split(/\r?\n/).filter(Boolean).filter((entry$1) => safeArchiveEntry(entry$1) && matcher.test(entry$1));
	if (matches.length !== 1) throw codedError("ffmpeg-executable-missing", `Expected one FFmpeg executable in archive, found ${matches.length}`);
	const entry = matches[0];
	await runCommand("tar", [
		"-xf",
		archivePath,
		"-C",
		tempRoot,
		entry
	], spawn$1, 6e4);
	const extracted = resolve(tempRoot, normalize(entry));
	if (!extracted.startsWith(resolve(tempRoot) + sep)) throw codedError("ffmpeg-archive-unsafe", "FFmpeg archive path escaped the install directory");
	await copyFile(extracted, destination);
}
function safeArchiveEntry(entry) {
	const value = entry.replaceAll("\\", "/");
	return value !== "" && !value.startsWith("/") && !/^[A-Za-z]:/.test(value) && !value.split("/").includes("..");
}
async function prepareMacExecutable(path, arch, spawn$1) {
	await runCommand("xattr", [
		"-d",
		"com.apple.quarantine",
		path
	], spawn$1, 5e3).catch(() => {});
	if (arch === "arm64") await runCommand("codesign", [
		"--force",
		"--sign",
		"-",
		path
	], spawn$1, 15e3).catch(() => {});
}
async function hashFile(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}
function readChunk(reader, timeoutMs) {
	return new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => reject(codedError("ffmpeg-download-timeout", "FFmpeg download stalled")), timeoutMs);
		reader.read().then((value) => {
			clearTimeout(timer);
			resolvePromise(value);
		}, (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}
function runCommand(command, argv, spawn$1, timeoutMs) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn$1(command, argv, {
			shell: false,
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (callback, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			callback(value);
		};
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", (error) => finish(reject, error));
		child.once("exit", (code) => code === 0 ? finish(resolvePromise, {
			stdout,
			stderr
		}) : finish(reject, codedError("ffmpeg-archive-invalid", stderr || `${command} exited with ${code}`)));
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {}
			finish(reject, codedError("ffmpeg-archive-invalid", `${command} timed out`));
		}, timeoutMs);
	});
}
function codedError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

//#endregion
//#region src/util.ts
/**
* src/util.ts — shared small helpers (sentinel / type coercion / JSON helpers).
*
* Factored out of index.ts for reuse by other modules. No ctx/cfg dependency,
* no side effects.
*/
const SENTINEL = "@@DSH_RESULT@@";
const j = (v) => JSON.stringify(v);
const str = (v, fallback) => typeof v === "string" && v !== "" ? v : fallback;
const num = (v, fallback) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
const bool = (v, fallback) => typeof v === "boolean" ? v : fallback;
/** Inline helper making arbitrary helper results JSON-safe for the payload. */
const SAFE_FN = "function safe(v){try{return JSON.parse(JSON.stringify(v))}catch{return String(v)}}\n";
/** Read an entire subprocess reader's buffered output. */
function readAll(reader) {
	if (!reader) return "";
	return reader.readFrom(0).text;
}

//#endregion
//#region src/index.ts
const name = "ego-browser";
const inject = [
	"tools",
	"subprocess",
	"webServer"
];
const Config = Config$1;
const DEFAULT_EGO_BIN = fileURLToPath(new URL("../runtime/ego-linux/bin/ego-browser.mjs", import.meta.url));
const DEFAULT_SPACE = "dsh-agent";
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_GRACE_MS = 15e3;
const TOOL_TIMEOUT_MS = 12e4;
/** Build the script that runs the probe and emits a sentinel payload. */
function humanCheckScript(space) {
	return `${useSpace(space)}${ensureRealTab()}let __hc = null\ntry { __hc = await page.evaluate(${j(HUMAN_CHECK_PROBE)}) } catch { __hc = null }\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, humanCheck: __hc }))\n`;
}
function createActiveSpaceTracker(defaultSpace = DEFAULT_SPACE) {
	let activeSpace = defaultSpace;
	let activeName = typeof defaultSpace === "string" ? defaultSpace : null;
	return {
		current: () => activeSpace,
		opened: (args, result) => {
			activeName = result?.name ?? str(args?.name, defaultSpace) ?? null;
			activeSpace = result?.id ?? activeName ?? defaultSpace;
		},
		selected: (space) => {
			if (space !== void 0 && space !== "") {
				activeSpace = space;
				activeName = typeof space === "string" ? space : null;
			}
		},
		closed: (space, done) => {
			if (done && (String(space) === String(activeSpace) || activeName !== null && String(space) === String(activeName))) {
				activeSpace = defaultSpace;
				activeName = typeof defaultSpace === "string" ? defaultSpace : null;
			}
		}
	};
}
/**
* The ego-lite host is a single persistent browser shared by every tool call;
* concurrent tool executions would race on the same task space / tabs. All
* ego_* executions are therefore serialized through one in-process lock. This
* guards against concurrent tool calls within this plugin instance; separate
* harness sessions sharing the same browser remain unsupported (host-level).
*/
let egoLockChain = Promise.resolve();
function withEgoLock(fn) {
	const run = egoLockChain.then(() => fn(), () => fn());
	egoLockChain = run.then(() => void 0, () => void 0);
	return run;
}
/**
* Build the env handed to `ego-browser nodejs` spawns.
*
* The vendored ego-linux CLI reads EGO_LINUX_CHROME (bare Chrome binary/wrapper
* path) and EGO_LINUX_HEADLESS (=1 to run headless) from the process env. When a
* host does not set them — the common case on root / Docker / CI boxes — Chrome
* silently fails to start, and consumers see a 20s `DevTools port` timeout.
*
* This function makes the plugin self-sufficient WITHOUT touching the host or
* other plugins:
*
*  - It is a pure function: only reads the current process env, never mutates
*    it, never writes files, and returns a fresh env to pass to the one spawn.
*  - It INCREMENTALLY FILLS GAPS: it uses `??` on every value, so an env var the
*    user already set is always respected and never overridden ("user wins").
*  - It only compensates for missing pieces, so behavior on a correctly set-up
*    host is byte-for-byte identical to before.
*  - It is idempotent: the same env yields the same result every call.
*  - An opt-out switch EGO_BROWSER_AUTO_ADAPT (set to "0"/"false"/"no") restores
*    the original "inherit host env verbatim" behavior.
*/
const BUNDLED_WRAPPER = fileURLToPath(new URL("../bin/ego-chrome-wrapper.sh", import.meta.url));
const IS_WIN = process.platform === "win32";
const AUTO_ADAPT_OFF = /^(0|false|no)$/i.test(process.env.EGO_BROWSER_AUTO_ADAPT ?? "");
const COMMON_CHROME_BINS = [
	"google-chrome-stable",
	"google-chrome",
	"chromium",
	"chromium-browser",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/opt/google/chrome/google-chrome"
];
/** Windows registry-free probe of the usual install dirs (no subprocess). */
function windowsChromeCandidates() {
	const pf = process.env.ProgramFiles;
	const pfx86 = process.env["ProgramFiles(x86)"];
	const local = process.env.LOCALAPPDATA;
	local || `${process.env.USERPROFILE || process.env.HOME || ""}`;
	const b = (p) => p ? p.replace(/\\+$/, "") : p;
	return [
		b(pf) + "\\Google\\Chrome\\Application\\chrome.exe",
		b(pfx86) + "\\Google\\Chrome\\Application\\chrome.exe",
		b(local) + "\\Google\\Chrome\\Application\\chrome.exe",
		b(pf) + "\\Microsoft\\Edge\\Application\\msedge.exe",
		b(pfx86) + "\\Microsoft\\Edge\\Application\\msedge.exe",
		b(local) + "\\Microsoft\\Edge\\Application\\msedge.exe",
		b(pfx86) + "\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
		b(local) + "\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
	].filter(Boolean);
}
/** Find a usable Chrome binary by scanning PATH + common fixed locations. */
function findChromeBinary() {
	if (process.env.EGO_LINUX_CHROME) return process.env.EGO_LINUX_CHROME;
	if (IS_WIN) {
		for (const p of windowsChromeCandidates()) try {
			if (existsSync(p)) return p;
		} catch {}
		const exts = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean).map((e) => e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`);
		const dirs = (process.env.PATH ?? "").split(";").map((d) => d.replace(/^"|"$/g, "")).filter(Boolean);
		for (const dir of dirs) for (const name$1 of [
			"chrome",
			"msedge",
			"brave"
		]) for (const ext of exts) try {
			const p = `${dir}\\${name$1}${ext}`;
			if (existsSync(p)) return p;
		} catch {}
		return;
	}
	for (const name$1 of COMMON_CHROME_BINS) if (name$1.includes("/")) try {
		if (existsSync(name$1)) return name$1;
	} catch {}
	else for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const p = `${dir}/${name$1}`;
		try {
			if (existsSync(p)) return p;
		} catch {}
	}
}
/** Root detection only makes sense on POSIX; Windows doesn't gate on sandbox. */
function isPosixRoot(platform = process.platform) {
	const uid = process.getuid?.();
	return typeof uid === "number" && uid === 0 && platform !== "win32";
}
/** No display server → headless is required (Linux/macOS headless servers). */
function isHeadlessDetected(platform = process.platform, env = process.env) {
	if (platform === "win32") return false;
	return env.DISPLAY === void 0 || env.DISPLAY === "";
}
/**
* Build the env handed to `ego-browser nodejs` spawns. See the block comment
* above ("environment self-adaptation") for the design contract.
*
* Platform/env are injectable for testing; production calls use process defaults.
*/
function resolveEgoEnv(cfg, { platform = process.platform, baseEnv = process.env } = {}) {
	if (AUTO_ADAPT_OFF) return baseEnv;
	const env = { ...baseEnv };
	const chrome = findChromeBinary();
	const configChrome = cfg?.chromePath;
	if (env.EGO_LINUX_CHROME === void 0 && configChrome) env.EGO_LINUX_CHROME = configChrome;
	if (env.EGO_LINUX_CHROME === void 0 && isPosixRoot(platform) && chrome) env.EGO_LINUX_CHROME = BUNDLED_WRAPPER;
	if (env.EGO_LINUX_CHROME === void 0 && platform === "win32" && chrome) env.EGO_LINUX_CHROME = chrome;
	if (env.EGO_LINUX_HEADLESS === void 0 && isHeadlessDetected(platform, env)) env.EGO_LINUX_HEADLESS = "1";
	const configChromeArgs = cfg?.chromeArgs;
	if (env.EGO_LINUX_EXTRA_ARGS === void 0 && typeof configChromeArgs === "string" && configChromeArgs.trim() !== "") env.EGO_LINUX_EXTRA_ARGS = configChromeArgs;
	return env;
}
function describeStderr(stderr) {
	const tail = stderr.trim();
	return tail === "" ? "" : `\n--- ego-browser stderr (tail) ---\n${tail.slice(-2e3)}`;
}
function describeSpawnFailure(err) {
	const msg = err instanceof Error ? err.message : String(err);
	if (/ENOENT|spawn .* ENOENT|not found|could not load|cannot find module/i.test(msg)) return "ego-browser CLI could not be started. For the vendored runtime, make sure a Chrome/Chromium is reachable (PATH, or set EGO_LINUX_CHROME; root users need a --no-sandbox wrapper, see AGENTS.md). To use an official host instead, set egoBin to your `ego-browser` command. " + msg;
	return `failed to start ego-browser: ${msg}`;
}
/**
* Error signatures that indicate a TRANSIENT browser cold-start / channel
* not-yet-ready problem rather than a real defect. The ego-lite host is a
* single persistent Chromium that cold-starts on the first tool call of a
* session; a probe that arrives while the DevTools/CDP channel is still
* coming up can fail with one of these. Such failures are safe to retry
* briefly (the browser keeps warming up in the background). Anything else
* must pass through immediately — never mask a genuine error.
*/
const COLD_START_SIGNS = [
	/CDP channel is not open/i,
	/DevTools.*(port|timeout|active)/i,
	/could not connect to/i,
	/browser (was |is )?not (reachable|running|ready)/i,
	/target.*(closed|not found|detached|crashed)/i,
	/ECONNREFUSED/i
];
function isColdStartError(message) {
	return COLD_START_SIGNS.some((re) => re.test(message));
}
/**
* Run `fn` (a per-call `ego-browser` spawn) up to `tries` times with a short
* backoff, retrying ONLY when the failure matches a transient cold-start
* signature. Real errors return on their first occurrence so they are never
* masked. Each retry re-spawns a fresh process, which is exactly what lets a
* warmed-up browser connect on a later attempt.
*/
async function withWarmupRetry(fn, { tries = 3, baseDelayMs = 600 } = {}) {
	let last;
	for (let i = 0; i < tries; i++) {
		const result = await fn();
		if (result.ok || !isColdStartError(result.error ?? "")) return result;
		last = result;
		if (i < tries - 1) await new Promise((resolve$1) => setTimeout(resolve$1, baseDelayMs * (i + 1)));
	}
	return last;
}
/** Find the last line carrying the sentinel and JSON-parse its payload. */
function parseSentinel(stdout) {
	const lines = stdout.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const idx = lines[i].indexOf(SENTINEL);
		if (idx === -1) continue;
		const payload = lines[i].slice(idx + SENTINEL.length).trim();
		try {
			return JSON.parse(payload);
		} catch {
			return;
		}
	}
}
async function runEgoScript(subprocess, script, exec, cfg, graceOverrideMs) {
	let handle;
	try {
		const extraCliArgs = filterArgs(cfg.egoCliArgs ?? "", EGO_CLI_BLOCKED);
		handle = subprocess.spawn({
			argv: [
				process.execPath,
				cfg.egoBin,
				"nodejs",
				...extraCliArgs
			],
			cwd: process.cwd(),
			env: resolveEgoEnv(cfg),
			stdio: {
				stdin: { data: script },
				stdout: {
					maxBytes: cfg.maxOutputBytes,
					spill: { maxBytes: cfg.maxOutputBytes }
				},
				stderr: {
					maxBytes: 512e3,
					spill: { maxBytes: 2e6 }
				}
			},
			graceMs: Number.isFinite(graceOverrideMs) && graceOverrideMs > 0 ? graceOverrideMs : cfg.graceMs,
			...exec.signal !== void 0 ? { signal: exec.signal } : {}
		});
	} catch (err) {
		return {
			ok: false,
			error: describeSpawnFailure(err),
			stdout: "",
			stderr: ""
		};
	}
	let outcome;
	try {
		outcome = await handle.done;
	} catch (err) {
		return {
			ok: false,
			error: describeSpawnFailure(err),
			stdout: "",
			stderr: ""
		};
	}
	const stdout = readAll(handle.collected.stdout);
	const stderr = readAll(handle.collected.stderr);
	if (exec.signal !== void 0 && exec.signal.aborted) return {
		ok: false,
		error: "ego-browser tool aborted (harness timeout or cancellation)",
		stdout,
		stderr
	};
	if (outcome.exitCode !== 0) return {
		ok: false,
		error: /Cannot find module|MODULE_NOT_FOUND/i.test(stderr) ? describeSpawnFailure(/* @__PURE__ */ new Error(`node could not load ${cfg.egoBin}`)) : `ego-browser exited with ${outcome.exitCode !== null ? `code ${outcome.exitCode}` : `signal ${String(outcome.signal)}`}${describeStderr(stderr)}`,
		stdout,
		stderr
	};
	const value = parseSentinel(stdout);
	if (value === void 0) return {
		ok: false,
		error: `ego-browser finished but no ${SENTINEL} JSON payload was found on stdout${describeStderr(stderr)}`,
		stdout,
		stderr
	};
	return {
		ok: true,
		value,
		stdout,
		stderr
	};
}
/** JS snippet that pins an action tool to one task space. */
const useSpace = (name$1) => `const task = await taskSpaces.useOrCreate(${j(name$1)})\n`;
/**
* JS snippet that makes the harness act on a real page tab.
*
* The Linux host (PR #234 ego-linux) does not reliably persist "current tab"
* across CLI invocations: a fresh process sometimes resolves page actions
* against a blank/stale tab. Selecting the first non-blank tab in the space
* before acting makes cross-process tool calls deterministic.
*/
const ensureRealTab = () => "const __tabs = await browser.listTabs()\nconst __real = __tabs.find(t => !t.url.startsWith('about:') && !t.url.startsWith('chrome://')) ?? __tabs[0]\nif (__real) await browser.switchTab(__real.targetId)\n";
function renderText(_args, value) {
	const v = value;
	if (v !== null && typeof v === "object" && v.ok === true && typeof v.text === "string") return [{
		type: "text",
		text: v.text
	}];
	return [{
		type: "text",
		text: JSON.stringify(value, null, 2)
	}];
}
const commonOutputSchema = {
	type: "object",
	additionalProperties: true,
	properties: { ok: {
		type: "boolean",
		required: true
	} }
};
function defineEgoTool(ctx, cfg, opts) {
	return defineTool({
		name: opts.name,
		description: opts.description,
		parameters: opts.parameters,
		output: {
			schema: commonOutputSchema,
			render: renderText
		},
		timeoutMs: TOOL_TIMEOUT_MS,
		execute: async (args, exec) => withEgoLock(async () => {
			markEgoToolCall();
			const script = opts.buildScript(args);
			const result = await withWarmupRetry(() => runEgoScript(ctx.subprocess, script, exec, cfg));
			if (!result.ok) throw new Error(result.error);
			if (typeof opts.afterExecute === "function") opts.afterExecute(args, result.value);
			return result.value;
		}),
		presentCall: () => ({
			card: "generic",
			title: opts.name,
			kind: "other",
			rawInput: null
		})
	});
}
function apply(ctx, config = {}) {
	const bridge = installEgoBrowserSettings(ctx, Object.fromEntries([
		"chromePath",
		"captureBackend",
		"streamProfile",
		"cdpFps",
		"cdpQuality",
		"cdpMaxWidth",
		"cdpBackstopIntervalMs",
		"ffmpegFps",
		"ffmpegMaxWidth",
		"ffmpegBitrateKbps",
		"ffmpegEncoder",
		"ffmpegPath",
		"githubMirror",
		"egoCliArgs",
		"chromeArgs",
		"castFpsCap",
		"screencastQuality",
		"screencastMaxWidth",
		"backstopIntervalMs"
	].filter((key) => config[key] !== void 0).map((key) => [key, config[key]])));
	const ffmpegManager = getSharedFfmpegInstallationManager();
	const initialFfmpegConfig = resolveConfig(bridge.source());
	ffmpegManager.check({
		configuredPath: initialFfmpegConfig.ffmpegPath,
		requestedEncoder: initialFfmpegConfig.ffmpegEncoder
	}).catch(() => {});
	const spaceTracker = createActiveSpaceTracker(config.defaultSpace ?? DEFAULT_SPACE);
	const cfg = {
		egoBin: typeof config.egoBin === "string" && config.egoBin !== "" ? config.egoBin : DEFAULT_EGO_BIN,
		configuredDefaultSpace: config.defaultSpace ?? DEFAULT_SPACE,
		spaceTracker,
		get defaultSpace() {
			return this.spaceTracker.current();
		},
		maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
		graceMs: config.graceMs ?? DEFAULT_GRACE_MS,
		get chromePath() {
			return resolveConfig(bridge.source()).chromePath;
		},
		get captureBackend() {
			return resolveConfig(bridge.source()).captureBackend;
		},
		get streamProfile() {
			return resolveConfig(bridge.source()).streamProfile;
		},
		get cdpFps() {
			return resolveConfig(bridge.source()).cdpFps;
		},
		get cdpQuality() {
			return resolveConfig(bridge.source()).cdpQuality;
		},
		get cdpMaxWidth() {
			return resolveConfig(bridge.source()).cdpMaxWidth;
		},
		get cdpBackstopIntervalMs() {
			return resolveConfig(bridge.source()).cdpBackstopIntervalMs;
		},
		get ffmpegFps() {
			return resolveConfig(bridge.source()).ffmpegFps;
		},
		get ffmpegMaxWidth() {
			return resolveConfig(bridge.source()).ffmpegMaxWidth;
		},
		get ffmpegBitrateKbps() {
			return resolveConfig(bridge.source()).ffmpegBitrateKbps;
		},
		get ffmpegEncoder() {
			return resolveConfig(bridge.source()).ffmpegEncoder;
		},
		get ffmpegPath() {
			return resolveConfig(bridge.source()).ffmpegPath;
		},
		get githubMirror() {
			return resolveConfig(bridge.source()).githubMirror;
		},
		get egoCliArgs() {
			return resolveConfig(bridge.source()).egoCliArgs;
		},
		get chromeArgs() {
			return resolveConfig(bridge.source()).chromeArgs;
		}
	};
	const reg = (tool) => {
		const dispose = ctx.tools.register(tool);
		ctx.effect?.(() => dispose);
	};
	registerEgoStatus(ctx, cfg, reg);
	registerAuthFlush(ctx, cfg, reg);
	registerActionTools(ctx, cfg, reg);
	registerHelpAndDoctor(ctx, cfg, reg);
	if (typeof ctx.webServer?.register === "function") {
		try {
			initCastServer(ctx, cfg, bridge, ffmpegManager);
		} catch (err) {
			ctx.logger?.warn?.(`ego-browser: cast server init failed: ${err?.message ?? err}`);
		}
		try {
			registerEgoBrowserGateway(ctx, bridge, ffmpegManager);
		} catch (err) {
			ctx.logger?.warn?.(`ego-browser: settings gateway init failed: ${err?.message ?? err}`);
		}
	}
	ctx.effect?.(() => {
		try {
			ctx.subprocess.spawn({
				argv: [
					process.execPath,
					cfg.egoBin,
					"--stop"
				],
				cwd: process.cwd(),
				env: resolveEgoEnv(cfg),
				stdio: {
					stdin: { data: "" },
					stdout: { maxBytes: 1024 },
					stderr: { maxBytes: 1024 }
				},
				graceMs: 8e3
			}).done.catch(() => {});
		} catch {}
	});
	ctx.logger?.info?.(`ego-browser: mounted (egoBin=${cfg.egoBin}, defaultSpace=${cfg.defaultSpace})`);
}
/** `ego_status` probes CLI availability by running the real `--status` path. */
function registerEgoStatus(ctx, cfg, reg) {
	reg(defineTool({
		name: "ego_status",
		description: "Check whether the ego-browser CLI is usable (runs `ego-browser --status`). Use this first when other ego_* tools report \"CLI not found\".",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					available: {
						type: "boolean",
						required: true
					},
					path: { type: "string" },
					exitCode: { type: "integer" }
				}
			},
			render: renderText
		},
		timeoutMs: 25e3,
		execute: async () => withEgoLock(async () => {
			try {
				const handle = ctx.subprocess.spawn({
					argv: [
						process.execPath,
						cfg.egoBin,
						"--status"
					],
					cwd: process.cwd(),
					env: resolveEgoEnv(cfg),
					stdio: {
						stdin: { data: "" },
						stdout: { maxBytes: 4096 },
						stderr: { maxBytes: 4096 }
					},
					graceMs: 25e3
				});
				const outcome = await handle.done;
				const out = readAll(handle.collected.stdout).trim();
				return {
					ok: true,
					available: outcome.exitCode === 0 && out !== "",
					path: cfg.egoBin,
					exitCode: outcome.exitCode
				};
			} catch (err) {
				return {
					ok: true,
					available: false,
					path: "",
					exitCode: null,
					error: describeSpawnFailure(err)
				};
			}
		}),
		presentCall: () => ({
			card: "generic",
			title: "ego_status",
			kind: "other",
			rawInput: null
		})
	}));
}
/** `ego_auth_flush` — force persistent login cookies down to the disk profile. */
function registerAuthFlush(ctx, cfg, reg) {
	reg(defineTool({
		name: "ego_auth_flush",
		description: "Force all persistent login cookies in the agent browser to be written to the on-disk profile. Call this after login (or before ending a browsing task) so the login survives a later DSH/browser restart — Chrome only flushes cookies to disk on graceful close, this nudges it to persist them now.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					total: { type: "integer" },
					flushed: { type: "integer" },
					error: { type: "string" }
				}
			},
			render: renderText
		},
		timeoutMs: 1e4,
		execute: async () => withEgoLock(async () => {
			try {
				const { readFile: readFile$1 } = await import("node:fs/promises");
				const e = process.env;
				const isWin = process.platform === "win32";
				const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || "" : homedir());
				const stateDir = e.EGO_LINUX_STATE_DIR || (isWin ? (e.LOCALAPPDATA || `${home}\\AppData\\Local`) + "\\ego-lite-linux" : `${e.XDG_STATE_HOME || `${home}/.local/state`}/ego-lite-linux`);
				let port = null;
				try {
					const state = JSON.parse(await readFile$1(`${stateDir}/ego-cast.json`, "utf8"));
					port = typeof state.port === "number" ? state.port : null;
				} catch {
					port = null;
				}
				if (port === null) return {
					ok: false,
					error: "no live ego-cast worker (browser not running)"
				};
				const jbody = await (await fetch(`http://127.0.0.1:${port}/api/flush`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
					signal: AbortSignal.timeout(8e3)
				})).json();
				return {
					ok: !!jbody.ok,
					total: jbody.total ?? 0,
					flushed: jbody.flushed ?? 0,
					error: jbody.error
				};
			} catch (err) {
				return {
					ok: false,
					error: String(err?.message || err)
				};
			}
		}),
		presentCall: () => ({
			card: "generic",
			title: "ego_auth_flush",
			kind: "other",
			rawInput: null
		})
	}));
}
/** The structured action tools that drive `ego-browser nodejs`. */
function registerActionTools(ctx, cfg, reg) {
	const t = (opts) => defineEgoTool(ctx, cfg, {
		...opts,
		afterExecute: (args, result) => {
			if (!result || result.ok === false) return;
			if (opts.name === "ego_space_open") cfg.spaceTracker.opened(args, result);
			else if (opts.name === "ego_space_close") cfg.spaceTracker.closed(args.name, result.done);
			else if (args && args.space !== void 0 && args.space !== "") cfg.spaceTracker.selected(args.space);
			opts.afterExecute?.(args, result);
		}
	});
	const spaceParam = {
		type: "string",
		description: "Task-space name or numeric id; defaults to the most recently opened or explicitly selected space."
	};
	reg(t({
		name: "ego_space_open",
		description: "Open (or reuse) an ego-lite task space — an isolated browsing context that inherits your login state. It becomes the active space for later ego_* calls that omit `space`.",
		parameters: { name: {
			type: "string",
			required: true,
			description: "Short name for the active user goal, e.g. \"search github issues\". Reuse the same name for follow-ups on the same goal."
		} },
		buildScript: (args) => `${useSpace(str(args.name, cfg.defaultSpace))}console.log('${SENTINEL}' + JSON.stringify({ ok: true, id: task.id ?? null, name: task.name ?? ${j(str(args.name, cfg.defaultSpace))} }))\n`
	}));
	reg(t({
		name: "ego_space_close",
		description: "Complete (close) an ego-lite task space. Must be the final ego_* call for a task — never leave a space hanging. `keep: true` keeps the page open for the user.",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "Task-space name or numeric id to close."
			},
			keep: {
				type: "boolean",
				description: "Keep the live page open (default false: close it)."
			}
		},
		buildScript: (args) => `const res = await taskSpaces.complete(${j(str(args.name, cfg.defaultSpace))}, { keep: ${bool(args.keep, false)} })\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, done: !!res.done, skipped: !!res.skipped, reason: res.skipped ? ${j("target space was not agent-owned")} : null }))\n`
	}));
	reg(t({
		name: "ego_snapshot",
		description: "Read the current page as text: the full-page semantic tree annotated with [ref=N, loc=...] selectors that ego_click / ego_fill can target. This is the main observation tool for any browser task.",
		parameters: {
			space: spaceParam,
			scope: {
				type: "string",
				description: "snapshot scope: 'full_page' (default) or 'only_within_viewport'."
			}
		},
		buildScript: (args) => {
			const scope = str(args.scope, "");
			const call = scope === "" ? "await page.snapshotRaw()" : `await page.snapshotRaw({ scope: ${j(scope)} })`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}let s = ${call}\nlet tries = 0\nwhile (!(s.content ?? '') && tries < 3) { await page.waitForTimeout(400); s = ${call}; tries++ }\nconst text = s.content ?? ''\nconsole.log('${SENTINEL}' + JSON.stringify(text === ''\n  ? { ok: false, text, tries, reason: 'snapshot returned no content after retries (page may be blank, still loading, or the browser dropped)' }\n  : { ok: true, text, tries }))\n`;
		}
	}));
	reg(t({
		name: "ego_navigate",
		description: "Open a URL in the task space, or switch to the existing tab for it. Waits for the document to load. Returns the resulting page info.",
		parameters: {
			url: {
				type: "string",
				required: true,
				description: "Absolute URL to open, e.g. https://example.com/path."
			},
			wait: {
				type: "boolean",
				description: "Wait for document load (default true)."
			},
			timeout: {
				type: "number",
				description: "Load wait timeout in ms (default 20000)."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const u = str(args.url, "");
			if (u === "") return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reused: false, page: null, reason: 'ego_navigate: url is required' }))\n`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}const __existing = __tabs.find(t => t.url.split('#')[0] === ${j(u.split("#")[0])})\nconst tab = __existing ? await browser.switchTab(__existing.targetId) : await page.goto(${j(u)}, { wait: ${bool(args.wait, true)}, timeout: ${num(args.timeout, 2e4)} })\nconst pginfo = await page.info()\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, reused: !!__existing, page: pginfo }))\n`;
		}
	}));
	reg(t({
		name: "ego_click",
		description: "Click an element in the current page. Target with a CSS selector, an xpath=.../loc=.../ref=@N value from ego_snapshot, or viewport coordinates.",
		parameters: {
			selector: {
				type: "string",
				description: "CSS selector, xpath=..., loc=..., or ref=@N from the snapshot. Required unless x/y are given."
			},
			x: {
				type: "number",
				description: "Viewport x coordinate for a coordinate click."
			},
			y: {
				type: "number",
				description: "Viewport y coordinate for a coordinate click."
			},
			label: {
				type: "string",
				description: "Short human label for the action, e.g. \"click submit button\"."
			},
			double: {
				type: "boolean",
				description: "Double-click instead of single-click. Useful for opening files/rows or triggering dblclick handlers."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const sel = str(args.selector, "");
			const x = args.x;
			const y = args.y;
			if (sel === "" && !(typeof x === "number" && typeof y === "number")) throw new Error("ego_click: provide either `selector` (CSS/xpath/loc/ref from ego_snapshot) or both `x` and `y` viewport coordinates");
			const dbl = bool(args.double, false);
			let action;
			if (sel !== "") {
				const labelOpt = str(args.label, "") !== "" ? `{ label: ${j(str(args.label, ""))} }` : "";
				action = dbl ? `await page.locator(${j(sel)}).dblclick(${labelOpt})` : `await page.locator(${j(sel)}).click(${labelOpt})`;
			} else action = dbl ? `await page.mouse.dblclick(${x}, ${y})` : `await page.mouse.click(${x}, ${y})`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}${action}\nconst pginfo = await page.info()\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, double: ${dbl}, page: pginfo }))\n`;
		}
	}));
	reg(t({
		name: "ego_fill",
		description: "Type text into an input field. Target with a CSS selector, xpath=..., loc=..., or ref=@N from ego_snapshot.",
		parameters: {
			selector: {
				type: "string",
				required: true,
				description: "CSS selector, xpath=..., loc=..., or ref=@N for the input."
			},
			text: {
				type: "string",
				required: true,
				description: "Text to type into the field."
			},
			space: spaceParam
		},
		buildScript: (args) => `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}await page.locator(${j(str(args.selector, ""))}).fill(${j(str(args.text, ""))})\nconst pginfo = await page.info()\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, page: pginfo }))\n`
	}));
	reg(t({
		name: "ego_js",
		description: "Evaluate a JavaScript expression in the current page and return its JSON-serializable value (e.g. \"document.title\", \"document.querySelectorAll('a').length\").",
		parameters: {
			expression: {
				type: "string",
				required: true,
				description: "JavaScript expression string to evaluate in the page."
			},
			space: spaceParam
		},
		buildScript: (args) => `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}${SAFE_FN}const result = await page.evaluate(${j(str(args.expression, ""))})\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, result: safe(result) }))\n`
	}));
	reg(t({
		name: "ego_cdp",
		description: "Issue a raw CDP command on the page target, e.g. cdp(\"Page.handleJavaScriptDialog\", { accept: true }).",
		parameters: {
			method: {
				type: "string",
				required: true,
				description: "CDP method name, e.g. Page.handleJavaScriptDialog."
			},
			params: {
				type: "object",
				additionalProperties: true,
				description: "CDP method parameters object."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const params = args.params;
			const call = params !== void 0 && params !== null ? `await cdp(${j(str(args.method, ""))}, ${j(params)})` : `await cdp(${j(str(args.method, ""))})`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}${SAFE_FN}const result = ${call}\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, result: safe(result) }))\n`;
		}
	}));
	reg(t({
		name: "ego_screenshot",
		description: "Capture a screenshot of the current page (or of a single element if selector is given). Returns the file path of the saved PNG, which you can then read with a vision/image tool.",
		parameters: {
			selector: {
				type: "string",
				description: "Optional CSS selector of an element to screenshot instead of the whole page."
			},
			path: {
				type: "string",
				description: "Optional absolute output path for the PNG."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const sel = str(args.selector, "");
			const pth = str(args.path, "");
			const shot = sel !== "" ? `await page.locator(${j(sel)}).screenshot(${pth ? `{ path: ${j(pth)} }` : ""})` : `await page.screenshot(${pth ? `{ path: ${j(pth)} }` : ""})`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}const path = ${shot}\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, path }))\n`;
		}
	}));
	reg(t({
		name: "ego_page_info",
		description: "Return the current page info: url, title, viewport size (w, h), scroll offsets (sx, sy), device metrics (pw, ph), and whether a native dialog is open. Also reports `humanCheck` — whether a CAPTCHA / human-verification challenge is detected on the page (so the agent can alert the user to complete it).",
		parameters: { space: spaceParam },
		buildScript: (args) => `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}const pginfo = await page.info()\nlet __hc = null\ntry { __hc = await page.evaluate(${j(HUMAN_CHECK_PROBE)}).catch(() => null); } catch { __hc = null }\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, page: pginfo, humanCheck: __hc }))\n`
	}));
	reg(t({
		name: "ego_wait",
		description: "Pause for a fixed number of milliseconds (e.g. for animations or partial loads). For load waits prefer ego_navigate's wait option.",
		parameters: { ms: {
			type: "number",
			required: true,
			description: "Milliseconds to wait."
		} },
		buildScript: (args) => `await page.waitForTimeout(${Math.max(0, num(args.ms, 1e3))})\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, waitedMs: ${Math.max(0, num(args.ms, 1e3))} }))\n`
	}));
	reg(t({
		name: "ego_wait_for_selector",
		description: "Wait until an element matching a CSS selector appears (state=visible, default) or disappears (state=hidden). Use instead of a blind fixed wait when a page renders asynchronously.",
		parameters: {
			selector: {
				type: "string",
				required: true,
				description: "CSS selector of the element to wait for, e.g. '.results' or '[data-id=done]'."
			},
			state: {
				type: "string",
				description: "Target state: 'visible' (default) | 'attached' | 'hidden' | 'detached'."
			},
			timeout: {
				type: "number",
				description: "How long to wait in ms (default 10000)."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const sel = str(args.selector, "").trim();
			if (sel === "") return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, waited: false, reason: 'ego_wait_for_selector: selector is required' }))\n`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}await page.waitForSelector(${j(sel)}, { state: ${j(str(args.state, "visible"))}, timeout: ${num(args.timeout, 1e4)} })\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, waited: true, selector: ${j(sel)}, state: ${j(str(args.state, "visible"))} }))\n`;
		}
	}));
	reg(t({
		name: "ego_wait_for_url",
		description: "Wait until the page navigates to a URL matching a substring / glob / regex. Use to catch login redirects or pagination.",
		parameters: {
			pattern: {
				type: "string",
				required: true,
				description: "URL/glob to match (e.g. '/login?done', 'https://*/post/*', or a /regex/)."
			},
			timeout: {
				type: "number",
				description: "How long to wait in ms (default 10000)."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const p = str(args.pattern, "").trim();
			if (p === "") return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reached: false, reason: 'ego_wait_for_url: pattern is required' }))\n`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}const __ok = await page.waitForURL(${j(p)}, { timeout: ${num(args.timeout, 1e4)} }).catch(() => false)\nconst __u = await page.url()\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: !!__ok, reached: !!__ok, url: __u }))\n`;
		}
	}));
	reg(t({
		name: "ego_wait_for_response",
		description: "Wait for a network response matching a URL/glob/regex and return it. Optionally return the body (text or JSON) — ideal for scraping API responses or confirming a submission.",
		parameters: {
			url: {
				type: "string",
				required: true,
				description: "URL/glob/regex to match, e.g. '/api/search' or 'https://*.com/data'."
			},
			timeout: {
				type: "number",
				description: "How long to wait in ms (default 10000)."
			},
			body: {
				type: "string",
				description: "Return the response body: 'none' (default) | 'text' | 'json'."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const u = str(args.url, "").trim();
			const mode = str(args.body, "none");
			const wantBody = mode === "text" || mode === "json";
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}const __res = await page.waitForResponse(${j(u)}, { timeout: ${num(args.timeout, 1e4)} })\n${wantBody ? `const __body = ${mode === "json" ? "await __res.json().catch(()=>null)" : "await __res.text().catch(()=>null)"}\n` : ""}console.log('${SENTINEL}' + JSON.stringify({ ok: true, url: __res.url(), status: __res.status()${wantBody ? ", body: __body" : ""} }))\n`;
		}
	}));
	reg(t({
		name: "ego_key",
		description: "Press a keyboard key or shortcut combination on the current page, e.g. 'Enter', 'Tab', 'Control+a', 'Escape', 'ArrowDown'. Useful for forms, shortcuts and navigation. Pass `text` to type a string of characters instead (keyboard.type).",
		parameters: {
			key: {
				type: "string",
				description: "Key or combo: 'Enter', 'Tab', 'Control+c', 'Meta+v', 'ArrowDown', 'Escape', 'F5', etc. (ignored when `text` is given)."
			},
			text: {
				type: "string",
				description: "Type this text character-by-character (keyboard.type). Use instead of `key` for typing words into the focused element."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const txt = str(args.text, "");
			const k = str(args.key, "").trim();
			if (txt !== "") return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}await page.keyboard.type(${j(txt)})\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, typed: ${j(txt)} }))\n`;
			if (k === "") return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'ego_key: provide key or text to type' }))\n`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}await page.keyboard.press(${j(k)})\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, key: ${j(k)} }))\n`;
		}
	}));
	reg(t({
		name: "ego_hover",
		description: "Move the pointer over an element (CSS selector / ref) or to viewport coordinates. Triggers CSS :hover, dropdowns and mouseenter handlers.",
		parameters: {
			selector: {
				type: "string",
				description: "CSS selector, xpath=..., loc=..., or ref=@N for the element."
			},
			x: {
				type: "number",
				description: "Viewport x (only with y)."
			},
			y: {
				type: "number",
				description: "Viewport y (only with x)."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const sel = str(args.selector, "");
			const hasXY = typeof args.x === "number" && typeof args.y === "number";
			if (sel === "" && !hasXY) return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'ego_hover: provide selector or both x and y' }))\n`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` + (sel !== "" ? `await page.locator(${j(sel)}).hover()\n` : `await page.mouse.move(${args.x}, ${args.y})\n`) + `console.log('${SENTINEL}' + JSON.stringify({ ok: true }))\n`;
		}
	}));
	reg(t({
		name: "ego_read_element",
		description: "Read a single element (by selector): its text, HTML, input value, an attribute, or visibility/enabled/count. Cheaper and more precise than a full-page snapshot.",
		parameters: {
			selector: {
				type: "string",
				required: true,
				description: "CSS selector of the target element."
			},
			what: {
				type: "string",
				description: "What to read: 'text' (default) | 'html' | 'value' | 'attribute' | 'visible' | 'enabled' | 'count'."
			},
			attribute: {
				type: "string",
				description: "Attribute name when what=attribute."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const sel = str(args.selector, "").trim();
			const what = str(args.what, "text");
			if (sel === "") return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'ego_read_element: selector is required' }))\n`;
			const selExpr = `page.locator(${j(sel)})`;
			let expr;
			switch (what) {
				case "html":
					expr = `await ${selExpr}.innerHTML()`;
					break;
				case "value":
					expr = `await ${selExpr}.inputValue()`;
					break;
				case "attribute":
					expr = `await ${selExpr}.getAttribute(${j(str(args.attribute, ""))})`;
					break;
				case "visible":
					expr = `await ${selExpr}.isVisible()`;
					break;
				case "enabled":
					expr = `await ${selExpr}.isEnabled()`;
					break;
				case "count":
					expr = `await ${selExpr}.count()`;
					break;
				default: expr = `await ${selExpr}.textContent()`;
			}
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}${SAFE_FN}const __v = ${expr}\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, what: ${j(what)}, selector: ${j(sel)}, value: safe(__v) }))\n`;
		}
	}));
	reg(t({
		name: "ego_select",
		description: "Choose an option in a <select> dropdown by value, label, or index (a single value or an array for multi-select).",
		parameters: {
			selector: {
				type: "string",
				required: true,
				description: "CSS selector of the <select> element."
			},
			value: {
				type: "json",
				description: "The option: a string value/label, or {value:'..'}, {label:'..'}, {index:n}, or an array of these for multi-select."
			},
			space: spaceParam
		},
		buildScript: (args) => `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}await page.locator(${j(str(args.selector, ""))}).selectOption(${j(args.value ?? "")})\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, select: ${j(str(args.selector, ""))} }))\n`
	}));
	reg(t({
		name: "ego_drag",
		description: "Drag an element to a target (Playwright dragTo) or drag the pointer through coordinates. Use for sliders, sortable rows, and drag-drop zones.",
		parameters: {
			from: {
				type: "string",
				description: "CSS selector of the element to drag from."
			},
			to: {
				type: "string",
				description: "CSS selector of the drop target (used with from)."
			},
			points: {
				type: "array",
				items: { type: "number" },
				description: "Alternative: a flat list of [x1,y1,x2,y2,...] viewport coordinates to drag the mouse through."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const pts = Array.isArray(args.points) ? args.points.map(Number).filter((n) => Number.isFinite(n)) : [];
			const hasEl = str(args.from, "") !== "" && str(args.to, "") !== "";
			if (!hasEl && pts.length < 4) return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'ego_drag: provide from+to selectors, or at least 4 points (x1,y1,x2,y2)' }))\n`;
			const action = hasEl ? `await page.locator(${j(str(args.from, ""))}).dragTo(page.locator(${j(str(args.to, ""))}))\n` : `const __pts = ${j(pts)}\nconst __coords=[];for(let __i=0;__i<__pts.length;__i+=2){__coords.push([__pts[__i],__pts[__i+1]])}\nawait page.mouse.drag(__coords)\n`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` + action + `console.log('${SENTINEL}' + JSON.stringify({ ok: true }))\n`;
		}
	}));
	reg(t({
		name: "ego_scroll",
		description: "Scroll the page: by pixel deltas (wheel), or bring an element into view (scrollIntoView).",
		parameters: {
			deltaX: {
				type: "number",
				description: "Horizontal scroll delta (wheel) in px."
			},
			deltaY: {
				type: "number",
				description: "Vertical scroll delta (wheel) in px."
			},
			selector: {
				type: "string",
				description: "CSS selector to scroll into view (primary if given)."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const hasSelector = str(args.selector, "") !== "";
			const hasDelta = Number.isFinite(args.deltaX) || Number.isFinite(args.deltaY);
			if (!hasSelector && !hasDelta) return `console.log('${SENTINEL}' + JSON.stringify({ ok: false, reason: 'ego_scroll: provide deltaX/deltaY or a selector' }))\n`;
			const action = hasSelector ? `await page.locator(${j(str(args.selector, ""))}).scrollIntoViewIfNeeded()\n` : `await page.mouse.wheel(${num(args.deltaX, 0)}, ${num(args.deltaY, 300)})\n`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}` + action + `const __p = await page.info()\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, scrollX: __p.sx ?? null, scrollY: __p.sy ?? null }))\n`;
		}
	}));
	reg(t({
		name: "ego_upload",
		description: "Set files on a file <input> element (path-driven). Use to upload a dataset/attachment from a local path.",
		parameters: {
			selector: {
				type: "string",
				required: true,
				description: "CSS selector of the <input type=file> element."
			},
			path: {
				type: "string",
				required: true,
				description: "Absolute path of the file(s) to upload on this machine."
			},
			space: spaceParam
		},
		buildScript: (args) => `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}await page.locator(${j(str(args.selector, ""))}).setInputFiles(${j(str(args.path, ""))})\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, upload: ${j(str(args.selector, ""))} }))\n`
	}));
	reg(t({
		name: "ego_download",
		description: "Wait for a file download triggered by the current action, then return its saved path. Provide `triggerSelector` (a download button/link to click) or `triggerScript` (arbitrary JS that triggers the download). The file is captured into a temp dir and (optionally) copied to `savePath`. Returns { path, suggestedFilename, url }.",
		parameters: {
			triggerSelector: {
				type: "string",
				description: "CSS selector of the element (button/link) whose click starts the download."
			},
			triggerScript: {
				type: "string",
				description: "Full JS snippet that triggers the download (e.g. window.open() or a fetch-to-blob download); runs in the page before waiting for the download."
			},
			savePath: {
				type: "string",
				description: "Optional absolute destination path to also copy the downloaded file to. Otherwise only the temp-captured path is returned."
			},
			timeout: {
				type: "number",
				description: "How long to wait for the download in ms (default 30000)."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const sel = str(args.triggerSelector, "");
			const script = str(args.triggerScript, "");
			const savePath = str(args.savePath, "");
			const timeout = num(args.timeout, 3e4);
			const trigger = sel !== "" ? `await page.locator(${j(sel)}).click()\n` : script !== "" ? `await page.evaluate(() => { ${script} })\n` : "/* no trigger given — the download may be started by an earlier navigation */\n";
			const save = savePath !== "" ? `const __final = await __dl.saveAs(${j(savePath)}).catch(()=>null)\n` : `const __final = await __dl.path().catch(()=>null)\n`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}const __dlPromise = page.waitForEvent('download', { timeout: ${timeout} })\n` + trigger + "const __dl = await __dlPromise\nconst __name = typeof __dl.suggestedFilename === 'function' ? __dl.suggestedFilename() : null\nconst __url = typeof __dl.url === 'function' ? __dl.url() : null\n" + save + `console.log('${SENTINEL}' + JSON.stringify({ ok: true, path: __final, suggestedFilename: __name, url: __url }))\n`;
		}
	}));
	reg(t({
		name: "ego_check",
		description: "Check (tick) or uncheck a checkbox/radio element. Does nothing if already in the desired state.",
		parameters: {
			selector: {
				type: "string",
				required: true,
				description: "CSS selector of the checkbox/radio."
			},
			checked: {
				type: "boolean",
				description: "true=check (default), false=uncheck."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const chk = bool(args.checked, true);
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}await page.locator(${j(str(args.selector, ""))}).${chk ? "check" : "uncheck"}()\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, checked: ${chk} }))\n`;
		}
	}));
	reg(t({
		name: "ego_dialog",
		description: "Accept or dismiss a native browser dialog (alert/confirm/prompt), optionally supplying text for a prompt. Use right after the action that triggers the dialog.",
		parameters: {
			accept: {
				type: "boolean",
				description: "true=Accept/OK (default), false=Dismiss/Cancel."
			},
			text: {
				type: "string",
				description: "Text to type into a prompt dialog."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const accept = bool(args.accept, true);
			const text = str(args.text, "");
			const params = `{ accept: ${accept}${text !== "" ? `, promptText: ${j(text)}` : ""} }`;
			return `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}const __r = await cdp("Page.handleJavaScriptDialog", ${params}).catch((e) => ({ error: String(e) }))\nconst __ok = !!(__r && !__r.error)\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, handled: __ok, accept: ${accept}, error: __r?.error ?? null }))\n`;
		}
	}));
	reg(t({
		name: "ego_http",
		description: "Make an HTTP request and return status + body. Default runs in the agent page's browser context (cross-origin allowed when the server's CORS permits); set `mode: server` to use Node-side fetch.server. Use to scrape an API, POST data, or hit a service. (Note: on the vendored ego-linux Windows runtime, fetch.server can hit a libuv crash, so prefer the default browser mode there.)",
		parameters: {
			url: {
				type: "string",
				required: true,
				description: "Absolute URL to request."
			},
			method: {
				type: "string",
				description: "HTTP method, default GET."
			},
			headers: {
				type: "object",
				additionalProperties: true,
				description: "Request headers, e.g. { 'Content-Type': 'application/json' }."
			},
			body: {
				type: "string",
				description: "Request body (for POST/PUT)."
			},
			timeout: {
				type: "number",
				description: "Timeout in ms (default 20000)."
			},
			mode: {
				type: "string",
				description: "'browser' (default) runs via the page context; 'server' uses Node-side fetch.server."
			},
			space: spaceParam
		},
		buildScript: (args) => {
			const opts = {
				method: str(args.method, "GET"),
				headers: args.headers && typeof args.headers === "object" ? args.headers : {},
				timeout: num(args.timeout, 2e4)
			};
			if (str(args.body, "") !== "") opts.body = str(args.body, "");
			const mode = str(args.mode, "browser");
			return `${mode === "server" ? "" : `${useSpace(str(args.space, cfg.defaultSpace))}${ensureRealTab()}`}${SAFE_FN}const __r = await fetch.${mode === "server" ? "server" : "browser"}(${j(str(args.url, ""))}, ${j(opts)})\nconst __status = typeof __r.status !== "undefined" ? __r.status : 200\nlet __body = null\ntry { __body = typeof __r.text === "function" ? await __r.text() : (typeof __r === "string" ? __r : JSON.stringify(safe(__r))) } catch { __body = null }\nconsole.log('${SENTINEL}' + JSON.stringify({ ok: true, mode: ${j(mode)}, status: __status, body: __body, url: ${j(str(args.url, ""))} }))\n`;
		}
	}));
	reg((() => {
		return defineTool({
			name: "ego_cli",
			description: "Escape hatch: run an arbitrary `ego-browser nodejs` heredoc script verbatim (facades page/browser/taskSpaces/site/fetch and the raw cdp() are preloaded). Use when the structured ego_* tools do not cover the task. Returns raw stdout plus the parsed console.log payload when present.",
			parameters: { script: {
				type: "string",
				required: true,
				description: "Full JS script body for the heredoc; ego-browser helpers are preloaded. End with console.log(JSON.stringify(...)) for a parseable sentinel payload."
			} },
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: {
							type: "boolean",
							required: true
						},
						stdout: {
							type: "string",
							required: true
						},
						stderr: { type: "string" },
						result: { type: "json" }
					}
				},
				render: renderText
			},
			timeoutMs: TOOL_TIMEOUT_MS,
			execute: async (args, exec) => {
				markEgoToolCall();
				const script = str(args.script, "");
				const result = await withWarmupRetry(() => runEgoScript(ctx.subprocess, script, exec, cfg));
				if (!result.ok) throw new Error(result.error);
				const parsed = parseSentinel(result.stdout);
				return {
					ok: true,
					stdout: result.stdout,
					stderr: result.stderr,
					result: parsed ?? null
				};
			},
			presentCall: () => ({
				card: "generic",
				title: "ego_cli",
				kind: "other",
				rawInput: null
			})
		});
	})());
}
/** Register ego_help / ego_doctor / ego_script. */
function registerHelpAndDoctor(ctx, cfg, reg) {
	reg(defineTool({
		name: "ego_captcha",
		description: "Check the current page for a human-verification (CAPTCHA) challenge — reCAPTCHA / hCaptcha / Cloudflare / Turnstile — and return { detected, kind }. If detected=true, ALERT THE USER that they must complete the verification in the 'ego lite - agent' browser window (it is the same live session shown in the watch panel), then continue after they have.",
		parameters: { space: {
			type: "string",
			description: "Task-space name or numeric id; defaults to the configured defaultSpace."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					detected: {
						type: "boolean",
						required: true
					},
					kind: { oneOf: [{ type: "string" }, { type: "null" }] }
				}
			},
			render: renderText
		},
		timeoutMs: 15e3,
		execute: async (args, exec) => withEgoLock(async () => {
			markEgoToolCall();
			const result = await withWarmupRetry(() => runEgoScript(ctx.subprocess, humanCheckScript(str(args.space, cfg.defaultSpace)), { signal: exec?.signal }, cfg));
			if (!result.ok) return {
				ok: false,
				detected: false,
				kind: null,
				error: result.error
			};
			const hc = (parseSentinel(result.stdout) || {}).humanCheck;
			return {
				ok: true,
				detected: !!hc?.detected,
				kind: hc?.kind ?? null
			};
		}),
		presentCall: () => ({
			card: "generic",
			title: "ego_captcha",
			kind: "other",
			rawInput: null
		})
	}));
	reg(defineTool({
		name: "ego_help",
		description: "Query the built-in ego-browser tool guide. `topic` may be a category (overview/tools/navigate/observe/input/keyboard-mouse/form/wait/network/login/script/doctor) or a specific tool name (e.g. ego_click). Returns the matching usage notes. Call this when unsure which eyebrow tool to use.",
		parameters: { topic: {
			type: "string",
			description: "Category or tool name to look up; omitted/all returns the overview index."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					topic: {
						type: "string",
						required: true
					},
					text: {
						type: "string",
						required: true
					}
				}
			},
			render: renderText
		},
		timeoutMs: 1e4,
		execute: async (args) => {
			const q = str(args.topic, "").trim().toLowerCase();
			const key = Object.prototype.hasOwnProperty.call(EGO_HELP_INDEX, q) ? q : "";
			const text = key ? EGO_HELP_INDEX[key] : q ? `未找到 topic "${q}"。可用: ` + Object.keys(EGO_HELP_INDEX).filter((k) => k !== "overview").join(", ") + "\n\noverview: " + EGO_HELP_INDEX.overview : EGO_HELP_INDEX.overview;
			return {
				ok: true,
				topic: q || "overview",
				text
			};
		},
		presentCall: () => ({
			card: "generic",
			title: "ego_help",
			kind: "other",
			rawInput: null
		})
	}));
	reg(defineTool({
		name: "ego_doctor",
		description: "Preflight the ego-browser environment: vendored runtime present, Chrome/Edge/Brave candidates, state dir, CDP/browser.json, ego-cast worker, task spaces. Run first when the browser fails to start (update, reboot, port conflict) or before a long session.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					report: {
						type: "string",
						required: true
					}
				}
			},
			render: renderText
		},
		timeoutMs: 25e3,
		execute: async () => {
			const lines = [];
			lines.push(`egoBin: ${cfg.egoBin}`);
			try {
				lines.push(`egoBin exists: ${existsSync(cfg.egoBin)}`);
			} catch {
				lines.push("egoBin exists: n/a");
			}
			const chrome = findChromeBinary();
			const configured = cfg.chromePath;
			if (configured) lines.push(`browser binary: ${configured} (from settings)`);
			else lines.push(`browser binary: ${chrome || "(none found — set chromePath in settings, or set EGO_LINUX_CHROME, or install Chrome/Edge/Brave)"}`);
			const cliArgs = filterArgs(cfg.egoCliArgs ?? "", EGO_CLI_BLOCKED);
			const chrArgs = filterArgs(cfg.chromeArgs ?? "", CHROME_BLOCKED);
			lines.push(`egoCliArgs (effective): ${cliArgs.length ? cliArgs.join(" ") : "(none)"}`);
			lines.push(`chromeArgs (effective, next cold start): ${chrArgs.length ? chrArgs.join(" ") : "(none)"}`);
			const isWin = process.platform === "win32";
			const e = process.env;
			const home = e.HOME || e.USERPROFILE || (isWin ? e.LOCALAPPDATA || "" : homedir());
			const stateDir = e.EGO_LINUX_STATE_DIR || (isWin ? (e.LOCALAPPDATA || `${home}\\AppData\\Local`) + "\\ego-lite-linux" : `${e.XDG_STATE_HOME || `${home}/.local/state`}/ego-lite-linux`);
			lines.push(`state dir: ${stateDir} (exists: ${existsSync(stateDir)})`);
			const bjson = `${stateDir}/browser.json`;
			let browserReport = "browser.json: (none — agent browser not running)";
			if (existsSync(bjson)) try {
				const { readFile: readFile$1 } = await import("node:fs/promises");
				const b = JSON.parse(await readFile$1(bjson, "utf8"));
				const alive = b.pid ? await (async () => {
					try {
						process.kill(b.pid, 0);
						return true;
					} catch (x) {
						return x?.code === "EPERM";
					}
				})() : false;
				browserReport = `browser.json: port=${b.port} pid=${b.pid} alive=${alive} headless=${b.headless}`;
			} catch (err) {
				browserReport = `browser.json: unreadable (${err?.message})`;
			}
			lines.push(browserReport);
			const tjson = `${stateDir}/task-spaces.json`;
			if (existsSync(tjson)) try {
				const { readFile: readFile$1 } = await import("node:fs/promises");
				const t = JSON.parse(await readFile$1(tjson, "utf8"));
				lines.push(`task spaces: ${(t.spaces || []).length}`);
			} catch {}
			lines.push("headless override: " + (e.EGO_LINUX_HEADLESS ? "yes (" + e.EGO_LINUX_HEADLESS + ")" : "no"));
			lines.push("npm/node: " + process.version);
			return {
				ok: true,
				report: lines.join("\n")
			};
		},
		presentCall: () => ({
			card: "generic",
			title: "ego_doctor",
			kind: "other",
			rawInput: null
		})
	}));
	reg((() => {
		return defineTool({
			name: "ego_script",
			description: "Run an arbitrary `ego-browser nodejs` heredoc script in ONE invocation (same runtime/API as ego_cli: page/…locator/browser/taskSpaces/site/fetch/cdp preloaded), and return structured {ok, stdout, stderr, result, durationMs, timedOut}. Use for a full multi-step browser task as a single script.",
			parameters: {
				script: {
					type: "string",
					required: true,
					description: "Full JS script body; end with console.log(JSON.stringify(...)) for a parseable sentinel payload."
				},
				timeoutMs: {
					type: "integer",
					description: "Per-run timeout in ms (default plugin grace)."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: {
							type: "boolean",
							required: true
						},
						stdout: {
							type: "string",
							required: true
						},
						stderr: { type: "string" },
						result: { type: "json" },
						durationMs: { type: "integer" },
						timedOut: { type: "boolean" },
						error: { type: "string" }
					}
				},
				render: renderText
			},
			timeoutMs: TOOL_TIMEOUT_MS,
			execute: async (args, exec) => {
				markEgoToolCall();
				const script = str(args.script, "");
				const timeoutMs = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : void 0;
				const start = Date.now();
				const result = await withWarmupRetry(() => runEgoScript(ctx.subprocess, script, exec, cfg, timeoutMs));
				const durationMs = Date.now() - start;
				if (!result.ok) return {
					ok: false,
					stdout: result.stdout,
					stderr: result.stderr,
					durationMs,
					timedOut: false,
					error: result.error
				};
				const parsed = parseSentinel(result.stdout);
				return {
					ok: true,
					stdout: result.stdout,
					stderr: result.stderr,
					result: parsed ?? null,
					durationMs,
					timedOut: false
				};
			},
			presentCall: () => ({
				card: "generic",
				title: "ego_script",
				kind: "other",
				rawInput: null
			})
		});
	})());
}

//#endregion
export { Config, apply, createActiveSpaceTracker, findChromeBinary, inject, name, resolveEgoEnv };