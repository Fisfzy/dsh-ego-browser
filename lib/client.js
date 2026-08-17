window.__ModuleLoader__.load({
	id: "@dsh-external/ego-browser",
	factory: (require) => {
		var module = { exports: {} };
		module.exports;

		// #region ego-browser client: realtime browser watch-bubble
		//
		// A floating "watch" bubble (bottom-right) plus an expandable overlay
		// panel that shows what the agent's ego-browser is doing in real time:
		// one thumbnail per live page target (URL + title), polled from the
		// host route /api/ego/spaces (which the host proxies to the ego-cast
		// worker attached to the agent's own Chrome via CDP screencast).
		//
		// Design constraints (kept deliberately minimal / read-only):
		//  - NO layout takeover: it is an overlay, not a grid-sidebar, so it
		//    never reshapes the conversation area or fights other panels.
		//  - READ-ONLY: only displays what the agent browser is already doing;
		//    there is no pause/resume/navigate control here (that stays out of
		//    scope to avoid racing the running agent).
		//  - Self-cleaning: everything is registered through ctx.effect so
		//    unmount / hot-reload restores the DOM and stops the poller.
		//
		// == 内部结构（维护前先看 docs/ARCH.md）==
		//   PANEL_CSS + ICON_*        : 样式与图标（顶部常量区）
		//   apply()                   : 入口，挂载面板/浮球/事件
		//   makeZoomImage / browserXY : 主视图缩放 + 坐标逆映射
		//   makeDraggable / snapPanelToFab : 球/窗口各自拖动 + 打点吸附
		//   renderSpaces / applyFrame / openStream : 轮询 + SSE 实时帧
		//   maybeShowLoginGuide / maybeShowCaptchaGuide : 登录/人机验证提醒条
		// 注意：本前端是单文件（受 DSH 注入机制限制），不要在页面上拆文件；
		//   数据源 = 轮询 /api/ego/spaces + SSE /api/ego/stream(实时帧)。
		// #endregion

		// ── Settings card dependencies ───────────────────────────────────
		// Required up-front so the settings card + watch panel share the same
		// React runtime. The ModuleLoader factory's `require` resolves these
		// from the profile's node_modules (declared as peerDependencies).
		var React = require('react')
		var runtimeClient = require('@deepseek-ai/dsh-client-runtime/client')
		var webReact = require('@deepseek-ai/dsh-client-web-react')
		var createSnapshotStore = runtimeClient.createSnapshotStore
		var bindSnapshotSelector = webReact.bindSnapshotSelector

		const inject = ['slots', 'locale', 'connection']

		// ── Settings card: locale ─────────────────────────────────────────
		var SETTINGS_NS = 'ego-browser'
		var en = {
			title: 'ego-browser',
			intro: 'Agent browser integration. Configure the Chrome/Chromium binary path below.',
			chromePath: 'Browser binary path',
			chromePathHint: 'Absolute path to chrome.exe / chromium. Leave empty to auto-detect.',
			save: 'Save', saving: 'Saving…', discard: 'Discard',
			unsaved: 'Unsaved', readOnly: 'Settings are read-only in this deployment.',
			namespaceUnavailable: 'The ego-browser configuration channel is unavailable. Please retry later.',
			retry: 'Retry',
			expand: 'Show settings', collapse: 'Hide settings',
		}
		var zh = {
			title: 'ego-browser',
			intro: 'Agent 浏览器集成。在下方配置 Chrome/Chromium 浏览器路径。',
			chromePath: '浏览器路径',
			chromePathHint: 'chrome.exe / chromium 的绝对路径。留空则自动检测。',
			save: '保存', saving: '保存中…', discard: '放弃',
			unsaved: '未保存', readOnly: '当前部署下设置只读。',
			namespaceUnavailable: 'ego-browser 配置通道不可用，请稍后重试。',
			retry: '重试',
			expand: '展开设置', collapse: '收起设置',
		}

		// ── Settings card: store ──────────────────────────────────────────
		function initialSettingsState() {
			return {
				status: 'idle',        // 'idle' | 'loading' | 'ready'
				available: false,      // true after a successful /ego/api/get
				writable: false,       // false when settings service is absent
				draft: { chromePath: '' },
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
				self.loaded = true
				self.staged.clear()
				self.store.update(function (s) {
					s.status = 'ready'
					s.available = true
					s.writable = true
					s.draft = { chromePath: config.chromePath || '' }
					s.dirty = false
					s.applyState = { kind: 'idle' }
				})
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
			this.staged.forEach(function (v, k) { patch[k] = v })
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
				if (!res.ok) return null
				return res.json().catch(function () { return null })
			}).then(function (parsed) {
				if (gen !== self.generation) return
				if (!parsed || parsed.ok !== true || !parsed.value) {
					self.store.update(function (s) {
						s.applyState = { kind: 'error', message: 'Save failed' }
					})
					return
				}
				var config = parsed.value.config || {}
				self.staged.clear()
				self.store.update(function (s) {
					s.applyState = { kind: 'saved' }
					s.draft = { chromePath: config.chromePath || '' }
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
		// Plain React.createElement (no JSX) — keeps the single-file plain-JS
		// pattern. Root is <li> per the settings.plugin.item slot contract.
		var h = React.createElement
		function EgoBrowserCard(props) {
			var t = props.t
			var controller = props.controller
			var useSnapshot = props.useSnapshot
			var state = useSnapshot(function (s) { return s })
			if (state.status === 'idle') void controller.load()
			var degraded = state.status === 'ready' && !state.available
			var open = state._open || degraded
			var applyState = state.applyState || { kind: 'idle' }
			var saving = applyState.kind === 'saving'
			var saved = applyState.kind === 'saved'
			var errorText = applyState.kind === 'error' ? applyState.message : undefined

			var header = h('button', {
				type: 'button',
				onClick: function () { controller.toggle() },
				style: { width: '100%', display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 16px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'inherit', fontSize: '14px' },
			},
				h('span', { style: { flex: 1 } },
					h('span', { style: { fontWeight: 600 } }, t('title')),
					h('span', { style: { display: 'block', fontSize: '12px', opacity: 0.6, marginTop: '2px' } }, t('intro')),
				),
				state.dirty ? h('span', { style: { fontSize: '11px', opacity: 0.7, fontStyle: 'italic' } }, t('unsaved')) : null,
				h('span', { style: { transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s', fontSize: '12px', opacity: 0.6 } }, '▾'),
			)

			var body = null
			if (!open) {
				body = null
			} else if (!state.available) {
				body = h('div', { style: { padding: '12px 16px' } },
					h('p', { role: 'status', style: { fontSize: '13px', opacity: 0.7, margin: '0 0 8px' } }, t('namespaceUnavailable')),
					h('div', { style: { display: 'flex', gap: '8px' } },
						h('button', {
							type: 'button',
							onClick: function () { controller.load() },
							style: btnStyle(false),
						}, t('retry')),
					),
				)
			} else {
				var footerItems = []
				if (errorText !== undefined) {
					footerItems.push(h('p', { role: 'status', style: { color: '#ff6b6b', fontSize: '12px', margin: '0' } }, errorText))
				} else if (saved) {
					footerItems.push(h('p', { role: 'status', style: { color: '#30d158', fontSize: '12px', margin: '0' } }, t('save')))
				}
				footerItems.push(h('div', { style: { display: 'flex', gap: '8px', marginLeft: 'auto' } },
					h('button', {
						type: 'button',
						onClick: function () { controller.discard() },
						disabled: !state.dirty || saving,
						style: btnStyle(state.dirty && !saving),
					}, t('discard')),
					h('button', {
						type: 'button',
						onClick: function () { controller.save() },
						disabled: !state.dirty || saving,
						style: btnStyle(state.dirty && !saving),
					}, saving ? t('saving') : t('save')),
				))
				body = h('div', { style: { padding: '4px 16px 16px' } },
					!state.writable ? h('p', { role: 'status', style: { fontSize: '12px', opacity: 0.6, margin: '0 0 8px' } }, t('readOnly')) : null,
					h('label', { style: { display: 'block', fontSize: '13px', fontWeight: 500, marginBottom: '4px' } }, t('chromePath')),
					h('input', {
						type: 'text',
						value: state.draft.chromePath || '',
						disabled: !state.writable || saving,
						placeholder: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
						onChange: function (e) { controller.edit('chromePath', e.target.value) },
						style: { width: '100%', padding: '6px 10px', fontSize: '13px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.3)', background: 'rgba(128,128,128,0.1)', color: 'inherit', boxSizing: 'border-box' },
					}),
					h('p', { style: { fontSize: '12px', opacity: 0.5, margin: '4px 0 12px' } }, t('chromePathHint')),
					h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, footerItems),
				)
			}

			return h('li', {
				style: { listStyle: 'none', borderBottom: '1px solid rgba(128,128,128,0.15)' },
			}, header, body)
		}
		function btnStyle(active) {
			return {
				padding: '5px 14px', fontSize: '13px', borderRadius: '6px', cursor: active ? 'pointer' : 'default',
				border: '1px solid rgba(128,128,128,0.3)', background: active ? 'rgba(48,209,88,0.15)' : 'none',
				color: 'inherit', opacity: active ? 1 : 0.5, transition: 'opacity 0.15s',
			}
		}

		const SPACES_ROUTE = '/api/ego/spaces'
		const EGO_CLOSE_ROUTE = '/api/ego/close'
		const OPEN_KEY = 'dsh.ego.watch.open'
		// Dynamic poll: fast while the agent is actively driving the browser,
		// slow once nothing has changed — keeps the view responsive without
		// hammering the worker with screenshots during idle stretches.
		const POLL_ACTIVE_MS = 2000
		const POLL_IDLE_MS = 8000
		// Treat the agent as "active" when any page was touched within this window.
		const ACTIVE_WINDOW_MS = 3000

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

		// ── SF-Symbols-style linear icons (inline SVG, zero deps) ──
		// Each icon carries explicit width/height (scaled from a 24 viewBox)
		// so it renders at a sane size even if no CSS rule targets it.
		const ICON_GLOBE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 3c2.5 2.4 3.8 5.4 3.8 9S14.5 18.6 12 21"/><path d="M12 3C9.5 5.4 8.2 8.4 8.2 12s1.3 6.6 3.8 9"/><path d="M3 12h18"/></svg>`;
		const ICON_REFRESH = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 4.5V9h-4.5"/></svg>`;
		const ICON_CLOCK = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg>`;
		const ICON_CLOSE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
		// 6-dot drag grip for the panel's title bar.
		const ICON_GRIP = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="6" r="1.8"/><circle cx="16" cy="6" r="1.8"/><circle cx="8" cy="12" r="1.8"/><circle cx="16" cy="12" r="1.8"/><circle cx="8" cy="18" r="1.8"/><circle cx="16" cy="18" r="1.8"/></svg>`;

		function apply(ctx) {
			// ── Settings card: register locale + slot (always runs) ──────
			ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), 'ego-browser: settings dictionaries')
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
			ctx.slots.inject('settings.plugin.item', function* () {
				yield ctx.slots.register({
					name: 'settings.plugin.item',
					id: 'ego-browser',
					order: 60,
					locale: SETTINGS_NS,
					inject: function () { return { controller: controller, useSnapshot: useSnapshot } },
				}, EgoBrowserCard)
			})

		// ── Watch panel: sidebar tab if available, floating fallback otherwise ──
		// Opportunistic consumption via ctx.get() (NOT ctx.betterSidebar — that
		// requires 'betterSidebar' in inject, which would make it a hard
		// dependency: without dsh-better-sidebar installed the whole plugin,
		// including the settings card, would fail to load). ctx.get() is the
		// documented pattern for optional services (see approval-seam notes,
		// postmortem 0001). Reads presence per call, degrades across HMR.
		if (ctx.get('betterSidebar') !== undefined) {
			ctx.effect(() => mountSidebarTab(ctx), 'ego-browser sidebar tab')
		} else {
			ctx.effect(() => mountFloatingWatch(ctx), 'ego-browser watch panel')
		}
	}

	// ── Floating watch panel (vanilla DOM, fallback when no sidebar) ────────
	// This is the original self-contained overlay: a draggable FAB + pop-out
	// panel. Kept verbatim for the no-sidebar path; the sidebar Tab path uses
	// the React EgoBrowserTab component + LivePreviewController instead.
	function mountFloatingWatch(ctx) {
		// Guard: skip if already mounted (apply() may fire multiple times).
		if (document.getElementById('dsh-ego-fab') !== null) return () => {}
				const style = document.createElement('style')
				style.textContent = PANEL_CSS
				document.head.appendChild(style)

				const panel = document.createElement('div')
				panel.id = 'dsh-ego-panel'
				panel.hidden = true
				panel.innerHTML = `
					<div id="dsh-ego-head">
						<span class="dsh-ego-grip" title="拖动移动面板">${ICON_GRIP}</span>
						<span id="dsh-ego-title">${ICON_GLOBE}<span style="margin-left:6px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Agent 浏览器</span></span>
						<button id="dsh-ego-refresh" class="dsh-ego-iconbtn" title="刷新">${ICON_REFRESH}</button>
						<button id="dsh-ego-historybtn" class="dsh-ego-iconbtn off" title="历史浏览轨迹">${ICON_CLOCK}</button>
						<button id="dsh-ego-close" class="dsh-ego-iconbtn" title="收起">${ICON_CLOSE}</button>
					</div>
					<div id="dsh-ego-tabs"></div>
					<div id="dsh-ego-login">
						<span class="dsh-ego-login-txt">需要账号登录时，请到桌面上那个 <b>「ego lite — agent」</b> Chrome 窗口完成登录。</span>
						<button id="dsh-ego-login-btn" class="dsh-ego-login-btn" type="button">已登录，保存</button>
						<span class="dsh-ego-login-note" id="dsh-ego-login-note"></span>
						<button class="dsh-ego-dismiss" type="button" title="关闭提示" data-dismiss="login">×</button>
					</div>
					<div id="dsh-ego-captcha">
						<span class="dsh-ego-captcha-txt"><b>⚠️ 检测到人机验证</b> — 请在桌面那个 <b>「ego lite — agent」</b> 浏览器窗口手动完成验证，agent 会继续。</span>
						<span class="dsh-ego-captcha-kind" id="dsh-ego-captcha-kind"></span>
						<button class="dsh-ego-dismiss" type="button" title="关闭提示" data-dismiss="captcha">×</button>
					</div>
					<div id="dsh-ego-cols">
						<div class="dsh-ego-maincol">
							<div id="dsh-ego-body"></div>
						</div>
						<aside id="dsh-ego-history">
							<div id="dsh-ego-historyhead">${ICON_CLOCK} 历史浏览轨迹</div>
							<div id="dsh-ego-historylist"></div>
						</aside>
					</div>
					<div class="dsh-ego-off">只读观察窗 · 实时显示 agent 正在浏览的页面 · ${ICON_CLOCK} 查看历史轨迹</div>
				`

				const fab = document.createElement('button')
				fab.id = 'dsh-ego-fab'
				fab.type = 'button'
				fab.title = 'Agent 浏览器实时视图'
				fab.textContent = ''
				fab.innerHTML = `${ICON_GLOBE}<span class="dsh-ego-dot"></span>`

				const body = panel.querySelector('#dsh-ego-body')
				const titleEl = panel.querySelector('#dsh-ego-title')
				const refreshBtn = panel.querySelector('#dsh-ego-refresh')
				const closeBtn = panel.querySelector('#dsh-ego-close')
				const historyBtn = panel.querySelector('#dsh-ego-historybtn')
				const historyEl = panel.querySelector('#dsh-ego-history')
				const historyList = panel.querySelector('#dsh-ego-historylist')
				const tabsEl = panel.querySelector('#dsh-ego-tabs')
				const loginEl = panel.querySelector('#dsh-ego-login')
				const loginBtn = panel.querySelector('#dsh-ego-login-btn')
				const loginNote = panel.querySelector('#dsh-ego-login-note')
				const captchaEl = panel.querySelector('#dsh-ego-captcha')
				const captchaKindEl = panel.querySelector('#dsh-ego-captcha-kind')
				const FLUSH_ROUTE = '/api/ego/flush'

				// Guide strips that the user can dismiss (×). Once closed in this
				// panel lifecycle they stay closed, so they never permanently eat
				// vertical space above the main view.
				const dismissedGuides = { login: false, captcha: false }
				const bindGuideDismiss = (which, el) => {
					const btn = el && el.querySelector('[data-dismiss="' + which + '"]')
					if (!btn) return
					btn.addEventListener('click', () => {
						dismissedGuides[which] = true
						el.classList.remove('show')
					})
				}
				bindGuideDismiss('login', loginEl)
				bindGuideDismiss('captcha', captchaEl)

				// Title keeps a leading globe icon; update only the trailing label
				// text so the icon is never wiped by a textContent reassignment.
				const setTitle = (text) => {
					const label = titleEl.querySelector('span:last-child')
					if (label) label.textContent = text
				}

				let disposed = false
				let liveCount = 0
				let historyOpen = false
				// Cache of the most recent spaces payload, so the preview "back"
				// control can restore the list synchronously and reliably instead
				// of depending on a fresh network round-trip (which may hang when
				// the worker/host is transiently unreachable).
				let lastList = []

				// Toggle the history drawer (side panel).
				const setHistory = (open) => {
					historyOpen = open
					historyEl.classList.toggle('open', open)
					panel.classList.toggle('open-drawer', open)
					historyBtn.classList.toggle('off', !open)
					historyBtn.title = open ? '收起历史轨迹' : '历史浏览轨迹'
					if (open) renderHistory(lastList)
				}

				// ---- History drawer: list every page, oldest -> newest ----
				const renderHistory = (spaces) => {
					historyList.innerHTML = ''
					const list = Array.isArray(spaces) ? [...spaces].sort((a, b) => (a.lastActive ?? 0) - (b.lastActive ?? 0)) : []
					if (list.length === 0) {
						historyList.innerHTML = `<div class="dsh-ego-hnone">暂无浏览记录</div>`
						return
					}
					for (const s of list) {
						const item = document.createElement('div')
						item.className = 'dsh-ego-hitem'
						const thumb = s.thumbnail
							? `<img class="dsh-ego-hthumb" src="${s.thumbnail}" alt="">`
							: `<div class="dsh-ego-hthumb"></div>`
						const active = s.targetId === currentActiveId
						item.innerHTML = `${thumb}
							<div class="dsh-ego-hinfo">
								<div class="dsh-ego-htitle">${escapeHtml(s.title || (s.url || '新标签页'))}</div>
								<div class="dsh-ego-hurl">${escapeHtml(s.url || '(about:blank)')}</div>
								${active ? '<div class="dsh-ego-hactive">● 当前</div>' : ''}
							</div>`
						item.addEventListener('click', () => openPreview(s))
						historyList.appendChild(item)
					}
				}

				// "pinned" = the user clicked a history entry and the main view is
				// now locked to that page. null = live view (auto-follows the
				// agent's current active page). Polling must NOT overwrite a
				// pinned view, or it would snap back to live every poll tick.
				let pinned = null
				// Which page is "current" (the live one shown in the main view).
				let currentActiveId = null
				// The page the AGENT is actually on — the browser's MRU-active tab,
				// reported by the worker as `active: true` in the spaces payload.
				// Distinct from currentActiveId (what the user is viewing): gating
				// auto-follow on agentActiveId stops a background repainting tab
				// (video/animation) from hijacking the view.
				let agentActiveId = null
				// selectedTabId = the tab the user last clicked on the tab bar. When
				// set to a live tab, the main view shows that tab (and sticks with
				// it across polls) instead of auto-following the agent's newest page.
				let selectedTabId = null
				// Zoom/pan state for the main live image, persisted across renders
				// so a re-render (poll refresh) keeps the user's zoom & position.
				let zoomState = { scale: 1, tx: 0, ty: 0 }
				// ── realtime SSE frame pipeline ──
				// frameCache: targetId -> dataURL of the newest JPEG that arrived
				// over the stream. liveImg: the <img> currently in the main view,
				// so a frame event for the shown tab swaps its src in place without
				// tearing down the zoom/pan state.
				const frameCache = new Map()
				let liveImg = null
				let liveImgTargetId = null
				// rAF-coalesced live-frame flush: newest frame is applied at display
				// cadence instead of decoding every source frame (bounds CPU under
				// an uncapped screencast).
				let pendingLiveFrame = null
				let liveFlushRaf = null
				// pageMeta: targetId -> { url, title }, kept authoritative for the
				// auto-follow path. Polled /api/ego/spaces data lags the SSE frame
				// stream, so a brand-new page (frame-first, list-later) would never
				// be findable in lastList in time to follow it. We merge updates
				// from both sources here and follow from this map instead.
				const pageMeta = new Map()

				// ── browser interaction: map panel pointer → real browser pixels ──
				const INPUT_ROUTE = '/api/ego/input'
				let inputBusy = false
				/**
				 * Send a pointer/wheel intention to the agent browser. Coordinates
				 * are already in browser CSS pixels; the worker turns them into CDP
				 * Input.dispatchMouseEvent on the page the panel is showing.
				 * `type`: mouseMoved | mousePressed | mouseReleased | mouseWheel.
				 */
				const sendInput = (targetId, type, params) => {
					if (inputBusy && type !== 'mouseReleased') return
					inputBusy = true
					window.setTimeout(() => { inputBusy = false }, type === 'mouseMoved' ? 24 : 8)
					void fetch(INPUT_ROUTE, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ targetId, type, ...params }),
					}).catch(() => {})
				}
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
					if (liveImgTargetId == null) return null
					const m = pageMeta.get(liveImgTargetId)
					const vw = m?.vw, vh = m?.vh
					if (!Number.isFinite(vw) || !Number.isFinite(vh)) return null
					const img = liveImg
					if (!img) return null
					const rect = img.getBoundingClientRect()
					const natW = img.naturalWidth || rect.width
					const natH = img.naturalHeight || rect.height
					if (!natW || !natH) return null
					const scale = Math.min(rect.width / natW, rect.height / natH)
					const contentW = natW * scale
					const contentH = natH * scale
					const ox = (rect.width - contentW) / 2
					const oy = (rect.height - contentH) / 2
					const rx = e.clientX - rect.left - ox
					const ry = e.clientY - rect.top - oy
					const x = (rx / contentW) * vw
					const y = (ry / contentH) * vh
					return { x, y }
				}

				// Build the zoomable main-view <img>. Wheel zooms around the cursor,
				// drag pans, double-click resets. State is shared via zoomState.
				// `urlEl` is the URL line below the image: while the user is zooming
				// or panning it briefly shows the relevant hint instead of the URL.
				// Interaction modes:
				//   plain wheel  → scroll the agent page (sent to the browser)
				//   Ctrl+wheel   → zoom the view (magnifier, local only)
				//   plain drag   → drag inside the agent page (sent to the browser)
				//   Ctrl+drag    → pan the view (local only)
				//   click        → click the agent page
				//   dblclick     → reset the view zoom
				const makeZoomImage = (urlEl) => {
					const img = document.createElement('img')
					img.className = 'dsh-ego-liveimg'
					img.draggable = false
					img.title = '滚轮缩放 · 按住拖动平移 · 缩小到最小或双击复位'
					// Hint swap: remember the real URL, show a tip while operating,
					// restore it after a short quiet period.
					const realText = urlEl ? urlEl.textContent : ''
					let hintTimer = null
					const clearHint = () => { if (hintTimer) { window.clearTimeout(hintTimer); hintTimer = null } }
					const showHint = (txt) => {
						if (!urlEl) return
						urlEl.textContent = txt
						urlEl.classList.add('dsh-ego-hint')
						clearHint()
						hintTimer = window.setTimeout(() => {
							urlEl.textContent = realText
							urlEl.classList.remove('dsh-ego-hint')
							hintTimer = null
						}, 2000)
					}
					const apply = () => {
						img.style.transformOrigin = '0 0'
						img.style.transform = `translate(${zoomState.tx}px, ${zoomState.ty}px) scale(${zoomState.scale})`
					}
					let viewPanning = false   // Ctrl+drag → local pan
					let browserDrag = false   // plain drag → send to agent
					let sx = 0, sy = 0, stx = 0, sty = 0
					let lastDragPos = null     // last browser coords sent during drag
					let downButtons = 0

					const resetView = () => {
						zoomState = { scale: 1, tx: 0, ty: 0 }
						apply()
						showHint('已复位 · 滚轮滚动页面 · Ctrl+滚轮缩放 · Ctrl+拖动平移 · 点按/拖动操作浏览器 · 双击复位')
					}
					img.title = '滚轮滚动页面 · Ctrl+滚轮缩放 · Ctrl+拖动平移 · 点按/拖动=操作浏览器 · 双击复位'

					// Wheel: plain = scroll the agent page; Ctrl+wheel = view zoom.
					img.addEventListener('wheel', (e) => {
						e.preventDefault()
						e.stopPropagation()
						if (e.ctrlKey || e.metaKey) {
							const rect = img.getBoundingClientRect()
							const mx = e.clientX - rect.left, my = e.clientY - rect.top
							const next = Math.min(8, Math.max(1, zoomState.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
							if (next <= 1) { resetView(); return }
							zoomState.tx = mx - (mx - zoomState.tx) * (next / zoomState.scale)
							zoomState.ty = my - (my - zoomState.ty) * (next / zoomState.scale)
							zoomState.scale = next
							apply()
							showHint('Ctrl+滚轮缩放 · Ctrl+拖动平移 · 双击复位')
							return
						}
						// Plain wheel → scroll the real page.
						const p = browserXY(e)
						if (p && liveImgTargetId) {
							sendInput(liveImgTargetId, 'mouseWheel', { x: p.x, y: p.y, deltaX: e.deltaX || 0, deltaY: e.deltaY || (e.deltaMode === 1 ? 40 : (e.deltaY || 100)) })
						}
					}, { passive: false })

					img.addEventListener('pointerdown', (e) => {
						if (e.button !== 0) return // left button only
						img.setPointerCapture(e.pointerId)
						sx = e.clientX; sy = e.clientY
						stx = zoomState.tx; sty = zoomState.ty
						if (e.ctrlKey || e.metaKey) {
							// Ctrl+drag → pan the view (magnifier), no browser input.
							viewPanning = true
							img.style.cursor = 'grabbing'
							showHint('Ctrl+拖动平移 · 滚轮滚动页面')
							return
						}
						// Plain press → start a browser interaction (click or drag).
						browserDrag = true
						lastDragPos = null
						downButtons = 1
						const p = browserXY(e)
						if (p) {
							lastDragPos = p
							sendInput(liveImgTargetId, 'mousePressed', { x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
						}
					})
					img.addEventListener('pointermove', (e) => {
						if (viewPanning) {
							zoomState.tx = stx + (e.clientX - sx)
							zoomState.ty = sty + (e.clientY - sy)
							apply()
							return
						}
						// Hover feedback even when not dragging: move the browser pointer.
						if (!browserDrag) {
							const p = browserXY(e)
							if (p) sendInput(liveImgTargetId, 'mouseMoved', { x: p.x, y: p.y, buttons: 0 })
							return
						}
						// Active drag → stream pointer moves to the browser.
						const p = browserXY(e)
						if (p) {
							// Skip a first tiny jitter if the press also set lastDragPos.
							sendInput(liveImgTargetId, 'mouseMoved', { x: p.x, y: p.y, buttons: downButtons })
							lastDragPos = p
						}
					})
					const stopDrag = (e) => {
						if (viewPanning) { viewPanning = false; img.style.cursor = e.ctrlKey ? 'grab' : 'grab' }
						if (browserDrag) {
							browserDrag = false
							if (lastDragPos && liveImgTargetId) {
								sendInput(liveImgTargetId, 'mouseReleased', { x: lastDragPos.x, y: lastDragPos.y, button: 'left', buttons: 0, clickCount: 1 })
							}
						}
						img.style.cursor = 'grab'
					}
					img.addEventListener('pointerup', stopDrag)
					img.addEventListener('pointercancel', stopDrag)
					img.addEventListener('pointerleave', (e) => { if (browserDrag || viewPanning) stopDrag(e) })
					img.addEventListener('dblclick', (e) => { e.preventDefault(); resetView() })
					img.style.cursor = 'grab'
					apply()
					return img
				}


				// ---- tab bar ----
				const renderTabs = (spaces) => {
					tabsEl.innerHTML = ''
					const list = Array.isArray(spaces) ? spaces : []
					if (list.length === 0) { if (selectedTabId) selectedTabId = null; return }
					for (const s of list) {
						const tab = document.createElement('div')
						tab.className = 'dsh-ego-tab'
						tab.title = s.url || ''
						tab.__tid = s.targetId
						const dot = document.createElement('span')
						dot.className = 'dsh-ego-tabdot'
						const txt = document.createElement('span')
						txt.className = 'dsh-ego-tabtxt'
						txt.textContent = s.title || (s.url || '(新标签页)')
						tab.appendChild(dot)
						tab.appendChild(txt)
						// Tab close "×": POST to the host close route, then refresh.
						const closeBtn = document.createElement('span')
						closeBtn.className = 'dsh-ego-tabclose'
						closeBtn.title = '关闭标签'
						closeBtn.textContent = '×'
						closeBtn.addEventListener('click', (e) => {
							e.stopPropagation()
							void (async () => {
								try {
									await fetch(EGO_CLOSE_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId: s.targetId }) })
								} catch { /* keep silent */ }
								if (selectedTabId === s.targetId) { selectedTabId = null; pinned = null }
							})().then(() => refresh())
						})
						tab.appendChild(closeBtn)
						if (s.targetId === selectedTabId || (selectedTabId === null && s.targetId === currentActiveId)) tab.classList.add('active')
						tab.addEventListener('click', () => {
							// Clicking the already-selected tab returns to live follow.
							if (selectedTabId === s.targetId) { selectedTabId = null; pinned = null; renderSpaces(lastList); return }
							selectedTabId = s.targetId
							pinned = null
							renderLiveMain(s, true)
							;[...tabsEl.querySelectorAll('.dsh-ego-tab')].forEach(t => t.classList.toggle('active', t.__tid === s.targetId))
						})
						tabsEl.appendChild(tab)
					}
				}

				// Render one page's screenshot in the main view. `pinned` controls
				// whether this is the sticky (user-selected) view or the live one.
				// Reuses the SAME large landscape layout as the live view so aspect
				// ratio / sizing never changes between live and history preview.
				const renderSingleView = (s) => {
					body.innerHTML = ''
					const view = document.createElement('div')
					view.className = 'dsh-ego-liveview'
					const badge = document.createElement('div')
					badge.className = 'dsh-ego-livebadge'
					badge.innerHTML = pinned
						? `<span class="dsh-ego-state-dot pin"></span> 已固定查看`
						: `<span class="dsh-ego-state-dot${fab.classList.contains('dsh-ego-busy') ? ' busy' : ''}"></span> 正在实时浏览`
					view.appendChild(badge)
					if (pinned) {
						const back = document.createElement('button')
						back.className = 'dsh-ego-back'
						back.type = 'button'
						back.textContent = '← 返回实时'
						back.addEventListener('click', () => { pinned = null; renderSpaces(lastList) })
						badge.appendChild(back)
					}
					const t = document.createElement('div')
					t.className = 'dsh-ego-livetitle'
					t.textContent = s.title || (s.url || '(新标签页)')
					// URL line — also the surface the hint is shown on while operating.
					const u = document.createElement('div')
					u.className = 'dsh-ego-liveurl'
					u.textContent = s.url || ''
					if (s.thumbnail) {
						const img = makeZoomImage(u)
						img.src = s.thumbnail
						img.alt = 'live'
						attachLiveImg(s.targetId, img)
						view.appendChild(img)
					} else {
						const n = document.createElement('div')
						n.className = 'dsh-ego-liveurl'
						n.textContent = '（暂无截图 — about:blank 或浏览器未渲染）'
						view.appendChild(n)
					}
					view.appendChild(t)
					view.appendChild(u)
					body.appendChild(view)
				}

				// Secondary view: open a specific history page in the main view,
				// pinned until the user returns to live.
				const openPreview = (s) => {
					if (disposed) return
					pinned = s
					renderSingleView(s)
				}

				const renderSpaces = (spaces) => {
					if (disposed) return
					lastList = Array.isArray(spaces) ? spaces : []
					// Keep pageMeta authoritative for the auto-follow AND for the
					// viewport-based coordinate mapping. Merge (do not overwrite) so
					// vw/vh learned from an SSE frame are not lost on the next poll;
					// also pick up viewportW/H now that /api/ego/spaces carries them.
					for (const s of lastList) {
						const prev = pageMeta.get(s.targetId) || { targetId: s.targetId }
						pageMeta.set(s.targetId, {
							url: s.url,
							title: s.title,
							targetId: s.targetId,
							...(Number.isFinite(s.viewportW) ? { vw: s.viewportW } : prev.vw !== undefined ? { vw: prev.vw } : {}),
							...(Number.isFinite(s.viewportH) ? { vh: s.viewportH } : prev.vh !== undefined ? { vh: prev.vh } : {}),
						})
					}
					// Prune caches for tabs that no longer exist, so long sessions
					// never grow frameCache/pageMeta unboundedly on closed pages.
					const liveIds = new Set(lastList.map(s => s.targetId))
					for (const id of [...pageMeta.keys()]) if (!liveIds.has(id)) pageMeta.delete(id)
					for (const id of [...frameCache.keys()]) if (!liveIds.has(id)) frameCache.delete(id)
					const sorted = [...lastList].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
					// Authoritative active page: the worker marks it `active: true`
					// (the browser's MRU tab, not "last repaint"). Prefer it over the
					// recency sort so a repainting background tab (video/animation)
					// with a high lastActive cannot steal the view.
					const activeMarked = lastList.find(s => s.active === true) || sorted[0] || null
					if (activeMarked) {
						agentActiveId = activeMarked.targetId
						currentActiveId = activeMarked.targetId
					}
					// Reflect whether a page is present (for the login guide).
					maybeShowLoginGuide()
					// Reflect whether the agent is being asked to verify (CAPTCHA).
					maybeShowCaptchaGuide()
					// Tab bar always reflects the current open tabs.
					renderTabs(lastList)
					if (historyOpen) renderHistory(lastList)
					// While the user pinned a history page, do NOT overwrite the main
					// view — otherwise the standing poll snaps it back to live.
					if (pinned) return
					if (lastList.length === 0) {
						setTitle('Agent 浏览器')
						body.innerHTML = `<div class="dsh-ego-empty">暂无活跃浏览器页<br><span style="font-size:11px;">当 agent 开始用 ego_* 操作网页时，这里会实时显示</span></div>`
						liveCount = 0
						fab.classList.remove('dsh-ego-live', 'dsh-ego-busy')
						return
					}
					liveCount = lastList.length
					fab.classList.add('dsh-ego-live')
					fab.classList.remove('dsh-ego-busy')
					// If the user picked a tab on the bar, keep showing that tab
					// (even as the agent opens new pages); else follow the newest.
					const sel = selectedTabId !== null ? lastList.find(x => x.targetId === selectedTabId) : null
					const current = sel || activeMarked
					currentActiveId = current.targetId
					setTitle(sel ? 'Agent 浏览器' : 'Agent 浏览器 · 实时')
					renderLiveMain(current, sel)
				}

				// Point the realtime pipeline at this <img> so incoming SSE frames
				// for `targetId` swap its src in place (no view teardown).
				const attachLiveImg = (targetId, img) => {
					liveImg = img
					liveImgTargetId = targetId
					const cached = frameCache.get(targetId)
					if (cached) img.src = cached
				}

				const renderLiveMain = (current, isPinned) => {
					body.innerHTML = ''
					const view = document.createElement('div')
					view.className = 'dsh-ego-liveview'
					const badge = document.createElement('div')
					badge.className = 'dsh-ego-livebadge'
					badge.innerHTML = isPinned
						? `<span class="dsh-ego-state-dot pin"></span> 当前标签`
						: `<span class="dsh-ego-state-dot${fab.classList.contains('dsh-ego-busy') ? ' busy' : ''}"></span> 正在实时浏览`
					view.appendChild(badge)
					const t = document.createElement('div')
					t.className = 'dsh-ego-livetitle'
					t.textContent = current.title || (current.url || '(新标签页)')
					// URL line — also the surface the hint is shown on while operating.
					const u = document.createElement('div')
					u.className = 'dsh-ego-liveurl'
					u.textContent = current.url || ''
					const openHere = document.createElement('button')
					openHere.type = 'button'
					openHere.className = 'dsh-ego-back'
					openHere.title = '在浏览器新标签打开真实页面'
					openHere.textContent = '⧉ 打开真实页'
					openHere.addEventListener('click', () => {
						const url = current.url
						if (url && !url.startsWith('about:') && !url.startsWith('chrome://')) window.open(url, '_blank', 'noopener')
						else openHere.textContent = '无可打开的地址'
					})
					badge.appendChild(openHere)
					if (current.thumbnail) {
						const img = makeZoomImage(u)
						img.src = current.thumbnail
						img.alt = 'live'
						attachLiveImg(current.targetId, img)
						view.appendChild(img)
					} else {
						const n = document.createElement('div')
						n.className = 'dsh-ego-liveurl'
						n.textContent = '（暂无截图 — about:blank 或浏览器未渲染）'
						view.appendChild(n)
					}
					view.appendChild(t)
					view.appendChild(u)
					body.appendChild(view)
				}

				// Dynamic scheduler: after each refresh, decide how soon to poll
				// again based on whether the agent has recently interacted with any
				// page. Active → fast (POLL_ACTIVE_MS); quiet → slow (POLL_IDLE_MS).
				let pollTimer = null
				let lastSawActive = false
				const scheduleNext = (spaces) => {
					if (disposed) return
					// Never let two poll timers accumulate: a manual refresh (or an
					// earlier pending tick) would otherwise stack extra timers and
					// double-fetch on every cycle.
					if (pollTimer) window.clearTimeout(pollTimer)
					const active = Array.isArray(spaces) && spaces.some(s => (Date.now() - (s.lastActive || 0)) <= ACTIVE_WINDOW_MS)
					const delay = active ? POLL_ACTIVE_MS : POLL_IDLE_MS
					if (active !== lastSawActive) {
						// Reflect the speed change on the status dot (busy=agent active now).
						fab.classList.toggle('dsh-ego-busy', active)
						lastSawActive = active
					}
					pollTimer = window.setTimeout(() => { if (!disposed && !panel.hidden) refresh() }, delay)
				}

				const refresh = () => {
					void (async () => {
						try {
							const res = await fetch(SPACES_ROUTE, { cache: 'no-store' })
							if (disposed || !res.ok) { renderEmptyAndSchedule(); return }
							const data = await res.json()
							if (!data || data.ok !== true) { renderEmptyAndSchedule(); return }
							renderSpaces(data.spaces)
							scheduleNext(data.spaces)
						} catch {
							renderEmptyAndSchedule()
						}
					})()
				}
				// On failure, keep polling but at the idle rate (no flapping).
				const renderEmptyAndSchedule = () => {
					if (body.children.length === 0) renderSpaces([])
					scheduleNext(undefined)
				}

				// ── realtime SSE: live frames + active-page auto-follow ──
				// The cast worker pushes a `frame` event per repaint of any live
				// page (browser-native cadence, far faster than the polled snapshot
				// which costs a ~700ms captureScreenshot per request). The panel
				// swaps the shown <img> in place and, in live-follow mode, tracks
				// the page the agent is actively repainting. Polling is kept as a
				// metadata/backstop channel.
				let sse = null
				let lastFrameAt = 0
				const FRAME_FOLLOW_MIN_MS = 350 // throttle live-follow view swaps
				let followTimer = null

				const applyFrame = (targetId, dataUrl, vw, vh) => {
					if (disposed) return
					frameCache.set(targetId, dataUrl)
					// Bounded cache: cap live frames to the most recent few pages so a
					// busy session can never accumulate unbounded JPEG dataURLs.
					const MAX_CACHED_FRAMES = 12
					if (frameCache.size > MAX_CACHED_FRAMES) {
						for (const [id] of frameCache) {
							if (id === targetId || id === liveImgTargetId) continue
							frameCache.delete(id)
							if (frameCache.size <= MAX_CACHED_FRAMES) break
						}
					}
					// Snapshot the page viewport for coordinate mapping.
					if (Number.isFinite(vw) && Number.isFinite(vh)) {
						const cur = pageMeta.get(targetId) || { targetId }
						pageMeta.set(targetId, { ...cur, vw, vh })
					}
					// Swap the currently shown image in place, no view rebuild.
					if (liveImg && liveImgTargetId === targetId) {
						// Coalesce to display cadence: with an uncapped screencast the
						// frames can arrive faster than the panel can present, and
						// setting img.src on every frame decodes each one. Instead keep
						// only the newest frame and apply it on the next animation
						// frame — the browser samples the latest, so bursts cost one
						// decode per presentation instead of per source frame.
						pendingLiveFrame = dataUrl
						if (!liveFlushRaf && !disposed) {
							liveFlushRaf = window.requestAnimationFrame(() => {
								liveFlushRaf = null
								if (disposed || !liveImg || pendingLiveFrame == null) return
								try { liveImg.src = pendingLiveFrame } catch {}
								pendingLiveFrame = null
							})
						}
						return
					}
					// Auto-follow: while not pinned to a history page and not pinned to
					// a manually chosen tab, jump to the page the agent is ACTIVELY on.
					// Only follow when this frame belongs to the agent's current page
					// (worker-reported MRU-active tab). Frames from a background
					// repainting tab (video/animation) must NOT hijack the view; we
					// merely swap its cached frame so the moment the user/agent brings
					// the tab forward the correct picture is already there.
					if (!pinned && selectedTabId === null && targetId === agentActiveId) {
						const now = Date.now()
						if (now - lastFrameAt >= FRAME_FOLLOW_MIN_MS) {
							lastFrameAt = now
							if (followTimer) window.clearTimeout(followTimer)
							followTimer = window.setTimeout(() => {
								if (disposed || pinned || selectedTabId !== null) return
								if (liveImg && liveImgTargetId === targetId) return
								const meta = pageMeta.get(targetId)
								if (!meta) return
								currentActiveId = targetId
								renderLiveMain({ ...meta, targetId, thumbnail: dataUrl }, false)
							}, 0)
						}
					}
				}

				const openStream = () => {
					if (disposed) return
					try { if (sse) sse.close() } catch {}
					doConnected = false
					sse = new EventSource('/api/ego/stream')
					sse.onopen = () => { doConnected = true }
					// A frame event looks like: { targetId, data (base64 jpeg), ts, vw, vh }.
					sse.addEventListener('frame', (ev) => {
						try {
							const m = JSON.parse(ev.data)
							if (!m || !m.targetId || !m.data) return
							if (Number.isFinite(m.vw) && Number.isFinite(m.vh)) {
								const cur = pageMeta.get(m.targetId) || { targetId: m.targetId }
								pageMeta.set(m.targetId, { ...cur, vw: m.vw, vh: m.vh })
							}
							applyFrame(m.targetId, `data:image/jpeg;base64,${m.data}`, m.vw, m.vh)
						} catch {}
					})
					// The worker also sends the live list on open (and on tab
					// churn); treat it as a metadata refresh for the tab bar.
					sse.addEventListener('spaces', (ev) => {
						if (disposed) return
						try {
							const list = JSON.parse(ev.data)
							if (Array.isArray(list) && list.length) {
								// Update the follow map so a frame-first new page is
								// still followable even before the next poll lands.
								for (const s of list) {
									const cur = pageMeta.get(s.targetId) || { targetId: s.targetId }
									pageMeta.set(s.targetId, { url: s.url, title: s.title, targetId: s.targetId, ...(Number.isFinite(s.viewportW) ? { vw: s.viewportW } : {}), ...(Number.isFinite(s.viewportH) ? { vh: s.viewportH } : {}) })
									if (s.active === true) agentActiveId = s.targetId
								}
								renderTabs(list)
							}
						} catch {}
					})
					sse.onerror = () => {
						// EventSource auto-reconnects; just flag so the status dot
						// doesn't claim "live" while the stream is down.
						doConnected = false
					}
				}
				let doConnected = false

				// ── draggable FAB + panel, independently positioned ──
				// The ball and its pop-out window each keep their own spot: dragging
				// the ball moves only the ball, dragging the panel header moves only
				// the panel. When you open the panel by tapping the ball it snaps to
				// a corner next to the ball (flipping below when near the top edge),
				// so it never pops up in a surprising spot.
				const DRAG_KEY = 'dsh.ego.watch.pos'
				const DRAG_PANEL_KEY = 'dsh.ego.watch.panelPos'
				const FAB_W = 48, FAB_H = 48
				const PANEL_W = 408, PANEL_GAP = 8
				const loadPos = (key) => {
					try { const s = JSON.parse(localStorage.getItem(key) || 'null'); if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) return s } catch {}
					return null
				}
				let pos = loadPos(DRAG_KEY) || { x: window.innerWidth - 18 - FAB_W, y: window.innerHeight - 104 - FAB_H }
				let panelPos = loadPos(DRAG_PANEL_KEY)
				const clampFab = () => {
					const vw = window.innerWidth, vh = window.innerHeight
					pos.x = Math.max(4, Math.min(vw - FAB_W - 4, pos.x))
					pos.y = Math.max(4, Math.min(vh - FAB_H - 4, pos.y))
				}
				const placeFab = () => { clampFab(); fab.style.left = pos.x + 'px'; fab.style.top = pos.y + 'px' }
				const placePanel = () => { panel.style.left = panelPos.x + 'px'; panel.style.top = panelPos.y + 'px' }
				/** Position the panel against the ball: just above it (below when near
				 *  the top edge), clamped inside the viewport. */
				const snapPanelToFab = () => {
					const vw = window.innerWidth, vh = window.innerHeight
					const pw = panel.classList.contains('open-drawer') ? 640 : PANEL_W
					const ph = panel.offsetHeight > 0 ? panel.offsetHeight : Math.min(Math.round(vh * 0.7), 520)
					// Panel's right edge hugs the ball's left edge.
					let px = pos.x + FAB_W - pw
					let py = pos.y - ph - PANEL_GAP
					if (py < 8) py = pos.y + FAB_H + PANEL_GAP // ball near top -> panel below
					px = Math.max(8, Math.min(vw - pw - 8, px))
					py = Math.max(8, Math.min(vh - ph - 8, py))
					panelPos = { x: Math.round(px), y: Math.round(py) }
					placePanel()
				}
				placeFab()
				if (panelPos) placePanel()
				let suppressFabClick = false
				/**
				 * Make `el` drag the FAB or the panel (`which` = 'fab' | 'panel').
				 * Movement under ~5px is treated as a click, so the FAB still toggles.
				 * Interactive children (buttons/icons) never start a drag.
				 */
				const makeDraggable = (el, which) => {
					const state = () => (which === 'fab' ? pos : panelPos)
					let sx = 0, sy = 0, bx = 0, by = 0, active = false, dragged = false
					const down = (e) => {
						if (e.button !== 0) return
						if (e.target && e.target.closest) {
							const hit = e.target.closest('button, a, input, [role="button"]')
							if (hit && hit !== el) return
						}
						active = true; dragged = false
						sx = e.clientX; sy = e.clientY
						const s = state(); bx = s.x; by = s.y
						try { el.setPointerCapture(e.pointerId) } catch {}
						el.classList.add('dsh-ego-dragging')
						e.preventDefault()
					}
					const move = (e) => {
						if (!active) return
						const dx = e.clientX - sx, dy = e.clientY - sy
						if (!dragged && Math.abs(dx) + Math.abs(dy) > 5) dragged = true
						if (dragged) {
							const s = state(); s.x = bx + dx; s.y = by + dy
							which === 'fab' ? placeFab() : placePanel()
						}
					}
					const up = (e) => {
						if (!active) return
						active = false
						el.classList.remove('dsh-ego-dragging')
						try { el.releasePointerCapture(e.pointerId) } catch {}
						if (dragged) {
							if (which === 'fab') suppressFabClick = true
							try { localStorage.setItem(which === 'fab' ? DRAG_KEY : DRAG_PANEL_KEY, JSON.stringify(state())) } catch {}
						}
					}
					el.addEventListener('pointerdown', down)
					el.addEventListener('pointermove', move)
					el.addEventListener('pointerup', up)
					el.addEventListener('pointercancel', up)
				}
				// Ball drags the ball; the panel header drags the panel. Independent.
				makeDraggable(fab, 'fab')
				makeDraggable(panel.querySelector('#dsh-ego-head'), 'panel')

				const setOpen = (open) => {
					if (open) {
						// Reveal then transition in, so the pop-out animation plays
						// (hidden -> display:flex would otherwise jump with no tween).
						panel.hidden = false
						panel.classList.remove('dsh-ego-panel-hide')
						// Snap the panel next to the ball each time it opens, so it
						// never appears at a surprise location.
						snapPanelToFab()
						// force a reflow so the browser sees the closed state first
						void panel.offsetHeight
						panel.classList.add('dsh-ego-panel-open')
						fab.classList.add('on')
						refresh()
					} else {
						panel.classList.remove('dsh-ego-panel-open')
						// after the close transition ends, fully hide to free layout.
						clearTimeout(panel._dshHideT)
						panel._dshHideT = setTimeout(() => {
							panel.classList.add('dsh-ego-panel-hide')
							panel.hidden = true
							fab.classList.remove('on')
						}, 280)
					}
					try { localStorage.setItem(OPEN_KEY, open ? '1' : '0') } catch {}
				}
				// A real click (not a drag) toggles the panel; a drag suppresses it.
				fab.addEventListener('click', () => {
					if (suppressFabClick) { suppressFabClick = false; return }
					setOpen(panel.hidden)
				})
				closeBtn.addEventListener('click', () => setOpen(false))
				refreshBtn.addEventListener('click', () => {
					// Show a spinner so a manual refresh has clear feedback even when
					// the underlying picture is static (no visible change).
					refreshBtn.classList.add('spinning')
					window.setTimeout(() => refreshBtn.classList.remove('spinning'), 800)
					refresh()
				})
				historyBtn.addEventListener('click', () => setHistory(!historyOpen))

				// Show a login guide when an agent browser is actually showing
				// something, so the user knows where to log in (the separate
				// 'ego lite — agent' Chrome window) and can persist the login.
				const maybeShowLoginGuide = () => {
					if (disposed || dismissedGuides.login) return
					const hasPage = lastList.some(s => s.url && !s.url.startsWith('about:'))
					// Avoid stacking two guide strips above the main view (which would
					// squash it): the captcha strip takes priority when both apply.
					const show = hasPage && !captchaEl.classList.contains('show')
					loginEl.classList.toggle('show', show)
					loginNote.textContent = ''
				}
				// Human-verification (CAPTCHA) reminder: if any live page reports a
				// challenge, flash a strip asking the user to complete it in the
				// 'ego lite — agent' browser window (the same session the panel views).
				const maybeShowCaptchaGuide = () => {
					if (disposed || dismissedGuides.captcha) return
					const hit = lastList.find(s => s.humanCheck && s.humanCheck.detected)
					const show = !!hit
					captchaEl.classList.toggle('show', show)
					if (show && captchaKindEl) captchaKindEl.textContent = hit.humanCheck.kind || 'captcha'
				}
				// "已登录，保存" → POST /api/ego/flush, which forces the agent
				// browser's persistent cookies down to its on-disk profile so a
				// later DSH/browser restart does not drop the login.
				loginBtn.addEventListener('click', () => {
					void (async () => {
						loginBtn.classList.add('saving')
						loginBtn.textContent = '保存中…'
						try {
							const r = await fetch(FLUSH_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
							const j = await r.json()
							if (j && j.ok) loginNote.textContent = `已保存 ${j.total ?? ''} 条会话`
							else loginNote.textContent = (j?.error ? '未连接浏览器' : '保存失败')
						} catch {
							loginNote.textContent = '保存失败'
						} finally {
							loginBtn.classList.remove('saving')
							loginBtn.textContent = '已登录，保存'
						}
					})()
				})

				document.body.appendChild(fab)
				document.body.appendChild(panel)

				// Start collapsed: the FAB is the persistent entry point and should
				// not disappear just because a previous session left the panel open.
				// Ignore any stale OPEN_KEY so the ball always shows on load.
				try { localStorage.removeItem(OPEN_KEY) } catch {}
				panel.hidden = true
				fab.classList.remove('on')
				refresh()
				openStream()

				return () => {
					disposed = true
					if (liveFlushRaf != null) try { window.cancelAnimationFrame(liveFlushRaf) } catch {}
					if (followTimer) window.clearTimeout(followTimer)
					if (pollTimer) window.clearTimeout(pollTimer)
					try { if (sse) sse.close() } catch {}
					fab.remove()
					panel.remove()
					style.remove()
				}
		}

		// ── Sidebar Tab (React UI + vanilla LivePreviewController) ─────────────
		// Registered via ctx.betterSidebar.registerTab() when the sidebar service
		// is available. The Tab reuses the same /api/ego/spaces + /api/ego/stream
		// data sources as the floating panel but renders through React into the
		// sidebar's tab content area instead of a fixed-position overlay.
		var INPUT_ROUTE = '/api/ego/input'
		var FLUSH_ROUTE = '/api/ego/flush'
		var FRAME_FOLLOW_MIN_MS = 350

		// ── Tab CSS (scoped under .dsh-ego-side-root) ──────────────────────────
		// Separate from PANEL_CSS (the floating panel's styles): the Tab lives
		// inside the sidebar's content area, so no fixed positioning / FAB / drag.
		// Selectors are class-scoped to avoid clashing with the floating panel's
		// #dsh-ego-* IDs (both paths can coexist in the bundle, only one runs).
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
			this.visible = true
			this.pollTimer = null
			this.sse = null
			this.lastSawActive = false
			this.lastFrameAt = 0
			this.followTimer = null
			this.pendingLiveFrame = null
			this.liveFlushRaf = null
			this.liveImg = null
			this.liveImgTargetId = null
			this.historyOpen = false
			this._zoomHint = null
			this._zoomHintTimer = null
			this._pointerState = null
			this.dismissedGuides = { login: false, captcha: false }
			// Tool-call signal: the host surfaces toolCallCount in /api/ego/spaces
			// (bumped by markEgoToolCall() in lib/index.js). Transition on 0 → >0
			// auto-opens the sidebar Tab. autoOpened guards against re-opening.
			this.lastToolCallCount = 0
			this.autoOpened = false
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
				// Fall back to cached frame if the poll hasn't got a thumbnail
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
			})
		}
		LivePreviewController.prototype.start = function () {
			this._recompute()
			this.refresh()
			this.openStream()
		}
		LivePreviewController.prototype.dispose = function () {
			this.disposed = true
			if (this.liveFlushRaf != null) try { window.cancelAnimationFrame(this.liveFlushRaf) } catch (e) {}
			if (this.followTimer) window.clearTimeout(this.followTimer)
			if (this.pollTimer) window.clearTimeout(this.pollTimer)
			if (this._zoomHintTimer) window.clearTimeout(this._zoomHintTimer)
			this.closeStream()
		}
		LivePreviewController.prototype.setVisible = function (v) {
			if (this.visible === v) return
			this.visible = v
			if (v) {
				this.refresh()
				this.openStream()
			} else {
				this.closeStream()
				if (this.pollTimer) { window.clearTimeout(this.pollTimer); this.pollTimer = null }
			}
		}
		LivePreviewController.prototype.setLiveImg = function (img, targetId) {
			this.liveImg = img
			this.liveImgTargetId = targetId
			if (img && targetId != null) {
				var cached = this.frameCache.get(targetId)
				if (cached) {
					try { img.src = cached } catch (e) {}
				}
			}
		}
		LivePreviewController.prototype.refresh = function () {
			var self = this
			void (async function () {
				try {
					var res = await fetch(SPACES_ROUTE, { cache: 'no-store' })
					if (self.disposed || !res.ok) { self._renderEmptyAndSchedule(); return }
					var data = await res.json()
					if (!data || data.ok !== true) {
						// Even on "no live browser" the host surfaces toolCallCount,
						// so the auto-open still fires when an ego_* tool ran but the
						// browser isn't up yet (rare; usually tool runs after launch).
						if (data && typeof data.toolCallCount === 'number') {
							self._maybeAutoOpenTab(data.toolCallCount)
						}
						self._renderEmptyAndSchedule(); return
					}
					self._processSpaces(data.spaces, data.toolCallCount)
					self._scheduleNext(data.spaces)
				} catch (e) {
					self._renderEmptyAndSchedule()
				}
			})()
		}
		LivePreviewController.prototype._renderEmptyAndSchedule = function () {
			if (this.lastList.length === 0) this._processSpaces([])
			this._scheduleNext(undefined)
		}
		LivePreviewController.prototype._maybeAutoOpenTab = function (toolCallCount) {
			if (this.autoOpened) return
			if (typeof toolCallCount !== 'number') return
			// Transition: 0 (or never-seen) → >0. Also fires when the host
			// restarted (counter resets to 0 then bumps) — that's fine, the
			// auto-open is a one-shot per session/page-load.
			if (toolCallCount > 0 && this.lastToolCallCount === 0) {
				this.autoOpened = true
				var sidebar = this.ctx && this.ctx.get ? this.ctx.get('betterSidebar') : null
				if (sidebar && typeof sidebar.openTab === 'function') {
					try { sidebar.openTab({ type: 'ego-browser:watch' }) } catch (e) {}
				}
			}
			this.lastToolCallCount = toolCallCount
		}
		LivePreviewController.prototype._processSpaces = function (spaces, toolCallCount) {
			if (this.disposed) return
			if (typeof toolCallCount === 'number') this._maybeAutoOpenTab(toolCallCount)
			this.lastList = Array.isArray(spaces) ? spaces : []
			var self = this
			for (var i = 0; i < this.lastList.length; i++) {
				var s = this.lastList[i]
				var prev = this.pageMeta.get(s.targetId) || { targetId: s.targetId }
				var meta = {
					url: s.url,
					title: s.title,
					targetId: s.targetId,
				}
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
			this._recompute()
		}
		LivePreviewController.prototype._scheduleNext = function (spaces) {
			if (this.disposed) return
			if (this.pollTimer) window.clearTimeout(this.pollTimer)
			var active = Array.isArray(spaces) && spaces.some(function (s) { return (Date.now() - (s.lastActive || 0)) <= ACTIVE_WINDOW_MS })
			if (active !== this.lastSawActive) {
				this.lastSawActive = active
				this._recompute()
			}
			if (!this.visible) return
			var delay = active ? POLL_ACTIVE_MS : POLL_IDLE_MS
			var self = this
			this.pollTimer = window.setTimeout(function () { if (!self.disposed && self.visible) self.refresh() }, delay)
		}
		LivePreviewController.prototype.openStream = function () {
			if (this.disposed || !this.visible) return
			this.closeStream()
			var self = this
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
					if (Array.isArray(list) && list.length) {
						for (var i = 0; i < list.length; i++) {
							var s = list[i]
							var cur = self.pageMeta.get(s.targetId) || { targetId: s.targetId }
							var meta = { url: s.url, title: s.title, targetId: s.targetId }
							if (Number.isFinite(s.viewportW)) meta.vw = s.viewportW
							if (Number.isFinite(s.viewportH)) meta.vh = s.viewportH
							self.pageMeta.set(s.targetId, Object.assign({}, cur, meta))
							if (s.active === true) self.agentActiveId = s.targetId
						}
						self.lastList = list
						self._recompute()
					}
				} catch (e) {}
			})
			this.sse.onerror = function () {}
		}
		LivePreviewController.prototype.closeStream = function () {
			try { if (this.sse) this.sse.close() } catch (e) {}
			this.sse = null
		}
		LivePreviewController.prototype.applyFrame = function (targetId, dataUrl, vw, vh) {
			if (this.disposed) return
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
						try { self2.liveImg.src = self2.pendingLiveFrame } catch (e) {}
						self2.pendingLiveFrame = null
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
			if (!targetId) return
			void fetch(INPUT_ROUTE, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(Object.assign({ targetId: targetId, type: type }, params)),
			}).catch(function () {})
		}
		LivePreviewController.prototype.browserXY = function (e) {
			if (this.liveImgTargetId == null || !this.liveImg) return null
			var m = this.pageMeta.get(this.liveImgTargetId)
			var vw = m && m.vw, vh = m && m.vh
			if (!Number.isFinite(vw) || !Number.isFinite(vh)) return null
			var img = this.liveImg
			var rect = img.getBoundingClientRect()
			var natW = img.naturalWidth || rect.width
			var natH = img.naturalHeight || rect.height
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
		LivePreviewController.prototype._applyZoom = function () {
			if (!this.liveImg) return
			this.liveImg.style.transformOrigin = '0 0'
			this.liveImg.style.transform = 'translate(' + this.zoomState.tx + 'px,' + this.zoomState.ty + 'px) scale(' + this.zoomState.scale + ')'
		}
		LivePreviewController.prototype.resetZoom = function () {
			this.zoomState = { scale: 1, tx: 0, ty: 0 }
			this._applyZoom()
			this._showHint('已复位 · 滚轮滚动页面 · Ctrl+滚轮缩放 · 双击复位')
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
				this._showHint('Ctrl+滚轮缩放 · Ctrl+拖动平移 · 双击复位')
				return
			}
			var p = this.browserXY(e)
			if (p && this.liveImgTargetId) {
				this.sendInput(this.liveImgTargetId, 'mouseWheel', {
					x: p.x, y: p.y,
					deltaX: e.deltaX || 0,
					deltaY: e.deltaY || (e.deltaMode === 1 ? 40 : (e.deltaY || 100)),
				})
			}
		}
		LivePreviewController.prototype.handlePointerDown = function (e) {
			if (e.button !== 0) return
			this._pointerState = {
				viewPanning: false, browserDrag: false,
				sx: e.clientX, sy: e.clientY,
				stx: this.zoomState.tx, sty: this.zoomState.ty,
				lastDragPos: null, downButtons: 0,
			}
			try { e.currentTarget.setPointerCapture(e.pointerId) } catch (err) {}
			if (e.ctrlKey || e.metaKey) {
				this._pointerState.viewPanning = true
				e.currentTarget.style.cursor = 'grabbing'
				this._showHint('Ctrl+拖动平移 · 滚轮滚动页面')
				return
			}
			this._pointerState.browserDrag = true
			this._pointerState.downButtons = 1
			var p = this.browserXY(e)
			if (p) {
				this._pointerState.lastDragPos = p
				this.sendInput(this.liveImgTargetId, 'mousePressed', { x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
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
					this.sendInput(this.liveImgTargetId, 'mouseMoved', { x: p2.x, y: p2.y, buttons: this._pointerState.downButtons })
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
				if (this._pointerState.lastDragPos && this.liveImgTargetId) {
					this.sendInput(this.liveImgTargetId, 'mouseReleased', {
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

			React.useEffect(function () {
				controller.start()
				return function () { controller.dispose() }
			}, [controller])

			React.useEffect(function () {
				controller.setVisible(visible)
			}, [visible, controller])

			// Attach the live <img> to the controller whenever the target changes
			React.useEffect(function () {
				if (imgRef.current && state.currentTargetId != null) {
					controller.setLiveImg(imgRef.current, state.currentTargetId)
				}
			}, [state.currentTargetId, controller])

			// Native wheel listener (React onWheel is passive, can't preventDefault)
			React.useEffect(function () {
				var img = imgRef.current
				if (!img) return
				var handler = function (e) { controller.handleWheel(e) }
				img.addEventListener('wheel', handler, { passive: false })
				return function () { img.removeEventListener('wheel', handler) }
			}, [controller, state.currentTargetId])

			var h = React.createElement

			// Header
			var header = h('div', { className: 'dsh-ego-side-head' },
				h('span', { className: 'dsh-ego-side-title' },
					h('span', { dangerouslySetInnerHTML: { __html: ICON_GLOBE } }),
					h('span', { style: { marginLeft: '5px' } }, state.busy ? 'Agent 浏览器 · 实时' : 'Agent 浏览器')
				),
				h('button', {
					className: 'dsh-ego-side-iconbtn' + (state.busy ? ' spinning' : ''),
					title: '刷新',
					onClick: function () {
						controller.refresh()
					},
				}, h('span', { dangerouslySetInnerHTML: { __html: ICON_REFRESH } })),
				h('button', {
					className: 'dsh-ego-side-iconbtn' + (state.historyOpen ? '' : ' off'),
					title: state.historyOpen ? '收起历史轨迹' : '历史浏览轨迹',
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
							' 历史浏览轨迹'
						),
						h('div', { className: 'dsh-ego-side-historylist' },
							sorted.length === 0
								? h('div', { className: 'dsh-ego-side-hnone' }, '暂无浏览记录')
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
											h('div', { className: 'dsh-ego-side-htitle' }, s.title || s.url || '新标签页'),
											h('div', { className: 'dsh-ego-side-hurl' }, s.url || '(about:blank)'),
											s.targetId === state.currentTargetId ? h('div', { className: 'dsh-ego-side-hactive' }, '● 当前') : null
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
							h('span', { className: 'dsh-ego-side-tabtxt' }, s.title || s.url || '(新标签页)'),
							h('span', {
								className: 'dsh-ego-side-tabclose',
								title: '关闭标签',
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
						h('div', null, '暂无活跃浏览器页'),
						h('div', { style: { fontSize: '11px' } }, '当 agent 开始用 ego_* 操作网页时，这里会实时显示')
					)
				)
			} else {
				var liveImg = currentSpace.thumbnail
					? h('img', {
						ref: imgRef,
						key: 'liveimg',
						className: 'dsh-ego-side-liveimg',
						src: currentSpace.thumbnail,
						alt: 'live',
						draggable: false,
						onPointerDown: function (e) { controller.handlePointerDown(e) },
						onPointerMove: function (e) { controller.handlePointerMove(e) },
						onPointerUp: function (e) { controller.handlePointerUp(e) },
						onPointerCancel: function (e) { controller.handlePointerUp(e) },
						onDoubleClick: function (e) { controller.handleDoubleClick(e) },
					})
					: h('div', { className: 'dsh-ego-side-liveurl' }, '（暂无截图 — about:blank 或浏览器未渲染）')

				body = h('div', { className: 'dsh-ego-side-body' },
					h('div', { className: 'dsh-ego-side-liveview' },
						h('div', { className: 'dsh-ego-side-livebadge' },
							h('span', { className: 'dsh-ego-side-state-dot' + (state.pinned ? ' pin' : state.busy ? ' busy' : '') }),
							h('span', { style: { flex: 1 } }, state.pinned ? '已固定查看' : '正在实时浏览'),
							state.pinned
								? h('button', {
									className: 'dsh-ego-side-back', type: 'button',
									onClick: function () { controller.unpin() },
								}, '← 返回实时')
								: null,
							h('button', {
								className: 'dsh-ego-side-back', type: 'button',
								title: '在浏览器新标签打开真实页面',
								onClick: function () {
									var url = currentSpace.url
									if (url && !url.startsWith('about:') && !url.startsWith('chrome://')) window.open(url, '_blank', 'noopener')
								},
							}, '⧉ 打开真实页')
						),
						liveImg,
						h('div', { className: 'dsh-ego-side-livetitle' }, currentSpace.title || currentSpace.url || '(新标签页)'),
						h('div', { className: 'dsh-ego-side-liveurl' + (state.zoomHint ? ' dsh-ego-side-hint' : '') }, state.zoomHint || currentSpace.url || '')
					)
				)
			}

			return h('div', { className: 'dsh-ego-side-root' }, header, guides, tabsEl, body)
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
					'需要账号登录时，请到桌面上那个 ',
					h('b', null, '「ego lite — agent」'),
					' Chrome 窗口完成登录。'
				),
				h('button', {
					className: 'dsh-ego-side-login-btn' + (saving ? ' saving' : ''),
					type: 'button',
					disabled: saving,
					onClick: function () {
						setSaving(true)
						setNote('')
						controller.flushLogin().then(function (j) {
							if (j && j.ok) setNote('已保存 ' + (j.total || '') + ' 条会话')
							else setNote(j && j.error ? '未连接浏览器' : '保存失败')
						}).catch(function () { setNote('保存失败') }).finally(function () { setSaving(false) })
					},
				}, saving ? '保存中…' : '已登录，保存'),
				note ? h('span', { className: 'dsh-ego-side-login-note' }, note) : null,
				h('button', {
					className: 'dsh-ego-side-iconbtn', type: 'button', title: '关闭提示',
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
					h('b', null, '⚠️ 检测到人机验证'),
					' — 请在桌面那个 ',
					h('b', null, '「ego lite — agent」'),
					' 浏览器窗口手动完成验证，agent 会继续。'
				),
				h('span', { className: 'dsh-ego-side-captcha-kind' }, kind),
				h('button', {
					className: 'dsh-ego-side-iconbtn', type: 'button', title: '关闭提示',
					onClick: function () { controller.dismissGuide('captcha') },
				}, '×')
			)
		}

		// ── mountSidebarTab: register the ego-browser watch tab ────────────────
		function mountSidebarTab(ctx) {
			var betterSidebar = ctx.get('betterSidebar')
			if (!betterSidebar) return function () {}
			// Inject Tab CSS once (cleaned up on dispose)
			var styleEl = document.createElement('style')
			styleEl.textContent = TAB_CSS
			document.head.appendChild(styleEl)

			var disposeTab = betterSidebar.registerTab({
				id: 'ego-browser:watch',
				title: function () { return 'Agent 浏览器' },
				order: 70,
				single: true,
				component: EgoBrowserTab,
			})

			// ── Auto-open probe ───────────────────────────────────────────────
			// The LivePreviewController (inside the Tab component) only polls
			// once the Tab is mounted, but the Tab only mounts once opened — a
			// chicken-and-egg that means the auto-open transition inside the
			// controller never fires. This lightweight standalone poller runs
			// regardless of Tab visibility: it fetches /api/ego/spaces, watches
			// toolCallCount 0 → >0, and calls openTab() once. Stops itself
			// after firing (one-shot per session) and on plugin dispose.
			var probeDisposed = false
			var probeTimer = null
			var lastToolCallCount = 0
			var autoOpened = false
			var probe = function () {
				if (probeDisposed || autoOpened) return
				void (async function () {
					try {
						var res = await fetch(SPACES_ROUTE, { cache: 'no-store' })
						if (!res.ok) { scheduleProbe(); return }
						var data = await res.json()
						if (data && typeof data.toolCallCount === 'number') {
							if (data.toolCallCount > 0 && lastToolCallCount === 0) {
								autoOpened = true
								try { betterSidebar.openTab({ type: 'ego-browser:watch' }) } catch (e) {}
								return // stop probing after auto-open
							}
							lastToolCallCount = data.toolCallCount
						}
					} catch (e) {}
					scheduleProbe()
				})()
			}
			var scheduleProbe = function () {
				if (probeDisposed || autoOpened) return
				if (probeTimer) window.clearTimeout(probeTimer)
				probeTimer = window.setTimeout(probe, POLL_IDLE_MS)
			}
			// Kick off the first probe shortly after mount (give the host a
			// moment to be ready; avoids a startup spike if multiple plugins
			// fire at once).
			probeTimer = window.setTimeout(probe, 1500)

			return function () {
				probeDisposed = true
				if (probeTimer) window.clearTimeout(probeTimer)
				disposeTab()
				styleEl.remove()
			}
		}

		function escapeHtml(s) {
			return String(s).replace(/[&<>"']/g, (c) => ({
				'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
			}[c]))
		}

		module.exports = {
			name: 'ego-browser',
			inject,
			apply,
		}
		return module.exports
	}
})
// # sourceMappingURL=client.js.map
