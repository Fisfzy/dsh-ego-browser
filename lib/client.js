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
			intro: 'Agent browser integration. Configure the Chrome/Chromium binary path and cast parameters below.',
			chromePath: 'Browser binary path',
			chromePathHint: 'Path to the Chrome/Chromium/Edge binary. Empty = auto-detect.',
			captureBackend: 'Capture backend', streamProfile: 'Quality profile', cdpFps: 'CDP FPS', cdpQuality: 'CDP JPEG quality', cdpMaxWidth: 'CDP max width', cdpBackstopIntervalMs: 'CDP recovery interval', ffmpegFps: 'FFmpeg FPS', ffmpegMaxWidth: 'FFmpeg max width', ffmpegEncoder: 'FFmpeg encoder', ffmpegPath: 'FFmpeg binary path', fpsUnit: 'fps', pxUnit: 'px', msUnit: 'ms',
			save: 'Save', saving: 'Saving…', discard: 'Discard',
			unsaved: 'Unsaved', readOnly: 'Settings are read-only in this deployment.',
			namespaceUnavailable: 'The ego-browser configuration channel is unavailable. Please retry later.',
			retry: 'Retry',
			expand: 'Show settings', collapse: 'Hide settings',
		}
		var zh = {
			title: 'ego-browser',
			intro: 'Agent 浏览器集成。在下方配置 Chrome/Chromium 浏览器路径及推流参数。',
			chromePath: '浏览器路径',
			chromePathHint: 'Chrome/Chromium/Edge 可执行文件路径。留空 = 自动检测。',
			captureBackend: '捕获后端', streamProfile: '画质档位', cdpFps: 'CDP 帧率', cdpQuality: 'CDP JPEG 质量', cdpMaxWidth: 'CDP 最大宽度', cdpBackstopIntervalMs: 'CDP 恢复截图间隔', ffmpegFps: 'FFmpeg 帧率', ffmpegMaxWidth: 'FFmpeg 最大宽度', ffmpegEncoder: 'FFmpeg 编码器', ffmpegPath: 'FFmpeg 路径', fpsUnit: 'fps', pxUnit: 'px', msUnit: 'ms',
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
				draft: { chromePath: '', captureBackend: 'auto', streamProfile: 'balanced', cdpFps: '20', cdpQuality: '55', cdpMaxWidth: '960', cdpBackstopIntervalMs: '3000', ffmpegFps: '20', ffmpegMaxWidth: '1280', ffmpegEncoder: 'auto', ffmpegPath: '' },
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
				s.draft = {
					chromePath: config.chromePath || '',
					captureBackend: config.captureBackend || 'auto', streamProfile: config.streamProfile || 'balanced',
					cdpFps: String(config.cdpFps ?? 20), cdpQuality: String(config.cdpQuality ?? 55), cdpMaxWidth: String(config.cdpMaxWidth ?? 960), cdpBackstopIntervalMs: String(config.cdpBackstopIntervalMs ?? 3000),
					ffmpegFps: String(config.ffmpegFps ?? 20), ffmpegMaxWidth: String(config.ffmpegMaxWidth ?? 1280), ffmpegEncoder: config.ffmpegEncoder || 'auto', ffmpegPath: config.ffmpegPath || '',
				}
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
			var NUMERIC_FIELDS = {
				cdpFps: { min: 5, max: 30, def: 20 }, cdpQuality: { min: 1, max: 100, def: 55 }, cdpMaxWidth: { min: 320, max: 1920, def: 960 }, cdpBackstopIntervalMs: { min: 1000, max: 10000, def: 3000 }, ffmpegFps: { min: 5, max: 30, def: 20 }, ffmpegMaxWidth: { min: 320, max: 1920, def: 1280 },
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
				s.draft = {
					chromePath: config.chromePath || '',
					captureBackend: config.captureBackend || 'auto', streamProfile: config.streamProfile || 'balanced',
					cdpFps: String(config.cdpFps ?? 20), cdpQuality: String(config.cdpQuality ?? 55), cdpMaxWidth: String(config.cdpMaxWidth ?? 960), cdpBackstopIntervalMs: String(config.cdpBackstopIntervalMs ?? 3000),
					ffmpegFps: String(config.ffmpegFps ?? 20), ffmpegMaxWidth: String(config.ffmpegMaxWidth ?? 1280), ffmpegEncoder: config.ffmpegEncoder || 'auto', ffmpegPath: config.ffmpegPath || '',
				}
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
			}, props.options.map(function (option) { return h('option', { key: option, value: option }, option) })) : h('input', {
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

			var body = null
			if (!open) {
				body = null
			} else if (!state.available) {
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
				var saveDisabled = !state.dirty || saving || !state.writable
				var discardDisabled = !state.dirty || saving
				body = h('div', { className: 'dsh-ego-card__body' },
					!state.writable ? h('p', { className: 'dsh-ego-card__notice', role: 'status' }, t('readOnly')) : null,
					saved ? h('p', { className: 'dsh-ego-card__saved', role: 'status' }, t('save')) : null,
					h('div', { className: 'dsh-ego-card__form' },
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
							id: 'plugin-config-ego-browser-backend', label: t('captureBackend'), value: state.draft.captureBackend, options: ['auto', 'cdp', 'ffmpeg'], disabled: busy, onEdit: function (v) { controller.edit('captureBackend', v) },
						}),
						h(SettingsField, { id: 'plugin-config-ego-browser-profile', label: t('streamProfile'), value: state.draft.streamProfile, options: ['low', 'balanced', 'high'], disabled: busy, onEdit: function (v) { controller.edit('streamProfile', v) } }),
						h(SettingsField, { id: 'plugin-config-ego-browser-cdpfps', label: t('cdpFps'), value: state.draft.cdpFps, numeric: true, narrow: true, unit: t('fpsUnit'), min: 5, max: 30, step: 1, disabled: busy, onEdit: function (v) { controller.edit('cdpFps', v) } }),
						h(SettingsField, { id: 'plugin-config-ego-browser-cdpquality', label: t('cdpQuality'), value: state.draft.cdpQuality, numeric: true, narrow: true, min: 1, max: 100, step: 1, disabled: busy, onEdit: function (v) { controller.edit('cdpQuality', v) } }),
						h(SettingsField, { id: 'plugin-config-ego-browser-cdpwidth', label: t('cdpMaxWidth'), value: state.draft.cdpMaxWidth, numeric: true, narrow: true, unit: t('pxUnit'), min: 320, max: 1920, step: 40, disabled: busy, onEdit: function (v) { controller.edit('cdpMaxWidth', v) } }),
						h(SettingsField, { id: 'plugin-config-ego-browser-backstop', label: t('cdpBackstopIntervalMs'), value: state.draft.cdpBackstopIntervalMs, numeric: true, narrow: true, unit: t('msUnit'), min: 1000, max: 10000, step: 100, disabled: busy, onEdit: function (v) { controller.edit('cdpBackstopIntervalMs', v) } }),
						h(SettingsField, { id: 'plugin-config-ego-browser-fffps', label: t('ffmpegFps'), value: state.draft.ffmpegFps, numeric: true, narrow: true, unit: t('fpsUnit'), min: 5, max: 30, step: 1, disabled: busy, onEdit: function (v) { controller.edit('ffmpegFps', v) } }),
						h(SettingsField, { id: 'plugin-config-ego-browser-ffwidth', label: t('ffmpegMaxWidth'), value: state.draft.ffmpegMaxWidth, numeric: true, narrow: true, unit: t('pxUnit'), min: 320, max: 1920, step: 40, disabled: busy, onEdit: function (v) { controller.edit('ffmpegMaxWidth', v) } }),
						h(SettingsField, { id: 'plugin-config-ego-browser-encoder', label: t('ffmpegEncoder'), value: state.draft.ffmpegEncoder, options: ['auto', 'software', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox', 'h264_vaapi'], disabled: busy, onEdit: function (v) { controller.edit('ffmpegEncoder', v) } }),
						h(SettingsField, { id: 'plugin-config-ego-browser-ffpath', label: t('ffmpegPath'), value: state.draft.ffmpegPath, placeholder: 'bundled ffmpeg-static', disabled: busy, onEdit: function (v) { controller.edit('ffmpegPath', v) },
						}),
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

			return h('li', {
				className: 'dsh-ego-card' + (open ? ' dsh-ego-card--open' : ''),
			}, header, open ? body : null)
		}

		const SPACES_ROUTE = '/api/ego/spaces'
		const EGO_CLOSE_ROUTE = '/api/ego/close'
		const WATCH_START_ROUTE = '/api/ego/watch/start'
		const WATCH_SWITCH_ROUTE = '/api/ego/watch/switch'
		const WATCH_STOP_ROUTE = '/api/ego/watch/stop'
		const VIDEO_ROUTE = '/api/ego/video'

		function postJson(path, body) {
			return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then(function (res) { return res.json().catch(function () { return {} }) })
		}

		function createMsePlayer(video, generation, mime, onFailure) {
			if (!window.MediaSource || !window.MediaSource.isTypeSupported(mime)) { onFailure('当前浏览器不支持此 H.264 流'); return function () {} }
			var mediaSource = new MediaSource()
			var objectUrl = URL.createObjectURL(mediaSource)
			var abort = new AbortController()
			var sourceBuffer = null, queue = [], disposed = false
			video.src = objectUrl; video.muted = true; video.autoplay = true; video.playsInline = true
			function appendNext() {
				if (disposed || !sourceBuffer || sourceBuffer.updating || queue.length === 0) return
				try { sourceBuffer.appendBuffer(queue.shift()) } catch (error) { onFailure(error.message) }
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
					appendNext()
				})
				fetch(VIDEO_ROUTE + '?generation=' + encodeURIComponent(generation), { signal: abort.signal }).then(function (res) {
					if (!res.ok || !res.body) throw new Error('视频流连接失败 (' + res.status + ')')
					var reader = res.body.getReader()
					function pump() { return reader.read().then(function (part) { if (disposed || part.done) return; queue.push(part.value); appendNext(); return pump() }) }
					return pump()
				}).catch(function (error) { if (!disposed && error.name !== 'AbortError') onFailure(error.message) })
			})
			return function () {
				disposed = true; abort.abort(); queue = []
				try { video.pause(); video.removeAttribute('src'); video.load() } catch (e) {}
				try { URL.revokeObjectURL(objectUrl) } catch (e) {}
			}
		}
		const OPEN_KEY = 'dsh.ego.watch.open'
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
						// Thumbnails are no longer carried in the spaces payload —
						// pull the latest cached JPEG from the SSE frame pipeline.
						const thumbSrc = frameCache.get(s.targetId)
						const thumb = thumbSrc
							? `<img class="dsh-ego-hthumb" src="${thumbSrc}" alt="">`
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
				const watchClientId = 'floating-' + Math.random().toString(36).slice(2)
				let watchStarted = false, watchTargetId = null, watchRenewTimer = null, watchStopTimer = null
				let captureBackend = 'cdp', streamGeneration = 0, streamState = 'idle', streamMessage = '', streamMime = 'video/mp4; codecs="avc1.42E01E"', videoCleanup = null
				const effectiveVisible = () => !panel.hidden && document.visibilityState !== 'hidden'
				const stopVideo = () => { if (videoCleanup) try { videoCleanup() } catch {}; videoCleanup = null }
				const syncWatch = (targetId) => {
					if (disposed || !effectiveVisible() || !targetId) return
					if (watchStopTimer) { window.clearTimeout(watchStopTimer); watchStopTimer = null }
					if (watchStarted && watchTargetId === targetId) return
					postJson(watchStarted ? WATCH_SWITCH_ROUTE : WATCH_START_ROUTE, { clientId: watchClientId, targetId }).then((status) => { watchStarted = status && status.ok !== false; watchTargetId = targetId; if (!effectiveVisible()) stopWatch(true) }).catch(() => {})
					if (!watchRenewTimer) watchRenewTimer = window.setInterval(() => { if (effectiveVisible() && watchTargetId) postJson(WATCH_START_ROUTE, { clientId: watchClientId, targetId: watchTargetId }).catch(() => {}) }, 5000)
				}
				const stopWatch = (immediate) => {
					if (watchRenewTimer) { window.clearInterval(watchRenewTimer); watchRenewTimer = null }
					const stop = () => { watchStopTimer = null; watchStarted = false; watchTargetId = null; postJson(WATCH_STOP_ROUTE, { clientId: watchClientId }).catch(() => {}) }
					if (immediate) stop(); else { if (watchStopTimer) window.clearTimeout(watchStopTimer); watchStopTimer = window.setTimeout(stop, 1500) }
				}

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
					const natW = img.naturalWidth || img.videoWidth || rect.width
					const natH = img.naturalHeight || img.videoHeight || rect.height
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
				const makeZoomImage = (urlEl, tagName = 'img') => {
					const img = document.createElement(tagName)
					img.className = 'dsh-ego-liveimg'
					if (tagName === 'img') img.draggable = false
					else { img.muted = true; img.autoplay = true; img.playsInline = true }
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
							syncWatch(s.targetId)
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
					// The thumbnail is no longer in the spaces payload — pull the
					// latest cached JPEG from the SSE frame pipeline. attachLiveImg
					// wires up the live <img> so future SSE frame events for this
					// target swap its src in place.
					const cached = frameCache.get(s.targetId)
					if (captureBackend === 'ffmpeg' || cached) {
						const img = makeZoomImage(u, captureBackend === 'ffmpeg' ? 'video' : 'img')
						if (captureBackend === 'ffmpeg' && streamState === 'streaming') { stopVideo(); videoCleanup = createMsePlayer(img, streamGeneration, streamMime, (message) => { streamMessage = message }) }
						else img.src = cached
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
				// Busy signal: derived from whether any page was touched recently.
				// Previously lived in the now-removed polling scheduler; moved
				// here so the SSE `spaces` event keeps the status dot live.
				const busy = lastList.some(s => (Date.now() - (s.lastActive || 0)) <= ACTIVE_WINDOW_MS)
				if (busy !== lastSawActive) {
					fab.classList.toggle('dsh-ego-busy', busy)
					lastSawActive = busy
				} else {
					fab.classList.remove('dsh-ego-busy')
				}
					// If the user picked a tab on the bar, keep showing that tab
					// (even as the agent opens new pages); else follow the newest.
					const sel = selectedTabId !== null ? lastList.find(x => x.targetId === selectedTabId) : null
					const current = sel || activeMarked
					currentActiveId = current.targetId
					syncWatch(current.targetId)
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
					const cached = frameCache.get(current.targetId)
					if (captureBackend === 'ffmpeg' || cached) {
						const img = makeZoomImage(u, captureBackend === 'ffmpeg' ? 'video' : 'img')
						if (captureBackend === 'ffmpeg' && streamState === 'streaming') { stopVideo(); videoCleanup = createMsePlayer(img, streamGeneration, streamMime, (message) => { streamMessage = message }) }
						else img.src = cached
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

				// ── spaces loading ────────────────────────────────────────────
				// The watch panel is now pure SSE-driven (spaces + frame events
				// from /api/ego/stream). This `refresh` is NO LONGER called on a
				// timer — it is only used as a one-shot fallback when:
				//   • the SSE stream errors / reconnects (to re-sync the tab list),
				//   • the user manually clicks the refresh button,
				//   • the user closes a tab (to re-sync),
				//   • initial mount (the SSE `spaces` event on connect covers this
				//     too, but we do an explicit fetch to surface any error early).
				// The response carries NO thumbnail bytes (worker /api/spaces is
				// pure metadata now); thumbnails come from the SSE frame cache.
				let lastSawActive = false
				const refresh = () => {
					void (async () => {
						try {
							const res = await fetch(SPACES_ROUTE, { cache: 'no-store' })
							if (disposed || !res.ok) { renderEmpty(); return }
							const data = await res.json()
							if (!data || data.ok !== true) { renderEmpty(); return }
							renderSpaces(data.spaces)
						} catch {
							renderEmpty()
						}
					})()
				}
				const renderEmpty = () => {
					if (body.children.length === 0) renderSpaces([])
				}

				// ── realtime SSE: live frames + active-page auto-follow ──
				// The cast worker pushes two kinds of events on /api/ego/stream:
				//   • `frame`  — per-repaint JPEG for any page (real-time video)
				//   • `spaces` — pure metadata (url/title/active/viewport/humanCheck),
				//                broadcast on every keepalive tick (~500ms) and on
				//                tab churn, so the tab bar + main view stay in sync
				//                WITHOUT any client-side polling.
				// The panel no longer polls /api/ego/spaces on a timer. A one-shot
				// `refresh()` is only called on initial mount and on SSE reconnect
				// (via the `onerror` debouncer below) to re-sync after a stream gap.
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
								renderLiveMain({ ...meta, targetId }, false)
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
				// churn); treat it as the authoritative tab-list + main-view
				// update. This replaces the old /api/ego/spaces polling loop.
					sse.addEventListener('spaces', (ev) => {
					if (disposed) return
					try {
						const list = JSON.parse(ev.data)
						if (Array.isArray(list)) {
							// Even for an empty list, we want to call renderSpaces
							// so the "no live browser" placeholder shows up.
							renderSpaces(list)
						}
					} catch {}
				})
				sse.addEventListener('capture-status', (ev) => {
					try {
						const status = JSON.parse(ev.data)
						const changed = captureBackend !== (status.backend || 'cdp') || streamGeneration !== (status.generation || 0) || streamState !== (status.state || 'idle') || streamMime !== (status.mime || streamMime)
						captureBackend = status.backend || 'cdp'; streamGeneration = status.generation || 0; streamState = status.state || 'idle'; streamMessage = status.message || status.code || ''; streamMime = status.mime || streamMime
						if (changed) { stopVideo(); const current = lastList.find((s) => s.targetId === (selectedTabId || currentActiveId)); if (current) renderLiveMain(current, selectedTabId !== null) }
					} catch {}
				})
				// Debounced reconnect fallback: when the SSE stream drops,
				// EventSource auto-reconnects, but we also kick off a one-shot
				// /api/ego/spaces fetch so the panel re-syncs immediately on the
				// next successful connect (without waiting for the worker's next
				// keepalive broadcast). The 1.5s delay gives EventSource room to
				// reconnect cleanly first, avoiding a redundant fetch on a
				// momentary blip.
				let reconnectFallbackTimer = null
				sse.onerror = () => {
					doConnected = false
					if (reconnectFallbackTimer) return
					reconnectFallbackTimer = window.setTimeout(() => {
						reconnectFallbackTimer = null
						if (disposed) return
						refresh()
					}, 1500)
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
						openStream()
						if (currentActiveId) syncWatch(selectedTabId || currentActiveId)
					} else {
						panel.classList.remove('dsh-ego-panel-open')
						// after the close transition ends, fully hide to free layout.
						clearTimeout(panel._dshHideT)
						panel._dshHideT = setTimeout(() => {
							panel.classList.add('dsh-ego-panel-hide')
							panel.hidden = true
							fab.classList.remove('on')
						}, 280)
						try { if (sse) sse.close() } catch {}
						sse = null
						stopWatch(false)
						stopVideo()
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
				const onVisibility = () => { if (document.visibilityState === 'hidden') { try { if (sse) sse.close() } catch {}; sse = null; stopWatch(false); stopVideo() } else if (!panel.hidden) { openStream(); syncWatch(selectedTabId || currentActiveId) } }
				document.addEventListener('visibilitychange', onVisibility)

				return () => {
					disposed = true
					if (liveFlushRaf != null) try { window.cancelAnimationFrame(liveFlushRaf) } catch {}
					if (followTimer) window.clearTimeout(followTimer)
					if (reconnectFallbackTimer) window.clearTimeout(reconnectFallbackTimer)
					document.removeEventListener('visibilitychange', onVisibility)
					if (watchRenewTimer) window.clearInterval(watchRenewTimer)
					if (watchStopTimer) window.clearTimeout(watchStopTimer)
					stopWatch(true); stopVideo()
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
			this.visible = false
			this.clientId = 'sidebar-' + Math.random().toString(36).slice(2)
			this.watchStarted = false
			this.watchTargetId = null
			this.watchRenewTimer = null
			this.watchStopTimer = null
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
			this.historyOpen = false
			this._zoomHint = null
			this._zoomHintTimer = null
			this._pointerState = null
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
				backend: 'cdp', streamState: 'idle', streamMessage: '', streamGeneration: 0, streamMime: 'video/mp4; codecs="avc1.42E01E"',
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
				s.backend = self.backend
				s.streamState = self.streamState
				s.streamMessage = self.streamMessage
				s.streamGeneration = self.streamGeneration
				s.streamMime = self.streamMime
			})
			this._syncWatch(currentTargetId)
		}
		LivePreviewController.prototype.start = function () {
			document.addEventListener('visibilitychange', this.onDocumentVisibility)
			this._recompute()
			if (this.visible && this.documentVisible) { this.refresh(); this.openStream() }
		}
		LivePreviewController.prototype.dispose = function () {
			this.disposed = true
			if (this.liveFlushRaf != null) try { window.cancelAnimationFrame(this.liveFlushRaf) } catch (e) {}
			if (this.followTimer) window.clearTimeout(this.followTimer)
			if (this.reconnectFallbackTimer) window.clearTimeout(this.reconnectFallbackTimer)
			if (this._zoomHintTimer) window.clearTimeout(this._zoomHintTimer)
			document.removeEventListener('visibilitychange', this.onDocumentVisibility)
			if (this.watchRenewTimer) window.clearInterval(this.watchRenewTimer)
			if (this.watchStopTimer) window.clearTimeout(this.watchStopTimer)
			this._stopWatch(true)
			this._destroyVideo()
			this.closeStream()
		}
		LivePreviewController.prototype._handleDocumentVisibility = function () {
			this.documentVisible = document.visibilityState !== 'hidden'
			this.setVisible(this.visible)
		}
		LivePreviewController.prototype.setVisible = function (v) {
			var changed = this.visible !== v
			this.visible = v
			var effective = v && this.documentVisible
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
		LivePreviewController.prototype._syncWatch = function (targetId) {
			if (this.disposed || !this.visible || !this.documentVisible || !targetId) return
			var self = this
			if (this.watchStopTimer) { window.clearTimeout(this.watchStopTimer); this.watchStopTimer = null }
			var route = this.watchStarted ? WATCH_SWITCH_ROUTE : WATCH_START_ROUTE
			if (this.watchStarted && this.watchTargetId === targetId) return
			var body = { clientId: this.clientId, targetId: targetId }
			postJson(route, body).then(function (status) {
				self.watchStarted = status && status.ok !== false
				self.watchTargetId = targetId
				if (!self.visible || !self.documentVisible) self._stopWatch(true)
			}).catch(function () {})
			if (!this.watchRenewTimer) this.watchRenewTimer = window.setInterval(function () {
				if (self.visible && self.documentVisible && self.watchTargetId) postJson(WATCH_START_ROUTE, { clientId: self.clientId, targetId: self.watchTargetId }).catch(function () {})
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
			}
		}
		// `refresh` is NOT a polling loop anymore. It is a one-shot fallback
		// used at start / setVisible(true) / SSE reconnect to re-sync the tab
		// list immediately. The authoritative metadata source is the SSE
		// `spaces` event broadcast by the worker every ~500ms.
		LivePreviewController.prototype.refresh = function () {
			var self = this
			void (async function () {
				try {
					var res = await fetch(SPACES_ROUTE, { cache: 'no-store' })
					if (self.disposed || !res.ok) { self._renderEmpty(); return }
					var data = await res.json()
					if (!data || data.ok !== true) { self._renderEmpty(); return }
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
			// Busy signal: derived from whether any page was touched recently.
			// Previously this lived in the now-removed polling scheduler; moved
			// here so the SSE `spaces` event keeps the status dot live.
			var busy = this.lastList.some(function (s) { return (Date.now() - (s.lastActive || 0)) <= ACTIVE_WINDOW_MS })
			if (busy !== this.lastSawActive) this.lastSawActive = busy
			this._recompute()
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
					var status = JSON.parse(ev.data)
					var generationChanged = self.streamGeneration !== (status.generation || 0)
					self.backend = status.backend || 'cdp'; self.streamState = status.state || 'idle'; self.streamMessage = status.message || status.code || ''; self.streamGeneration = status.generation || 0; self.streamMime = status.mime || self.streamMime
					if (generationChanged || self.backend !== 'ffmpeg') self._destroyVideo()
					self._recompute()
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
			var videoRef = React.useRef(null)

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
				var liveImg = state.backend === 'ffmpeg'
					? h('video', {
						ref: videoRef, key: 'livevideo-' + state.streamGeneration, className: 'dsh-ego-side-liveimg', muted: true, autoPlay: true, playsInline: true,
						onPointerDown: function (e) { controller.handlePointerDown(e) }, onPointerMove: function (e) { controller.handlePointerMove(e) }, onPointerUp: function (e) { controller.handlePointerUp(e) }, onPointerCancel: function (e) { controller.handlePointerUp(e) }, onDoubleClick: function (e) { controller.handleDoubleClick(e) },
					})
					: currentSpace.thumbnail
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
					: h('div', { className: 'dsh-ego-side-liveurl' }, state.streamMessage || '（暂无截图 — about:blank 或浏览器未渲染）')

				body = h('div', { className: 'dsh-ego-side-body' },
					h('div', { className: 'dsh-ego-side-liveview' },
						h('div', { className: 'dsh-ego-side-livebadge' },
							h('span', { className: 'dsh-ego-side-state-dot' + (state.pinned ? ' pin' : state.busy ? ' busy' : '') }),
							h('span', { style: { flex: 1 } }, (state.backend === 'ffmpeg' ? 'FFmpeg · H.264' : 'CDP') + ' · ' + (state.streamState === 'failed' ? (state.streamMessage || '失败') : state.streamState)),
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

			// ── Auto-open probe (SSE-driven, no polling) ─────────────────────
			// Listens for `tool-call` events on the SSE stream to detect when
			// the agent first calls an ego_* tool, then opens the sidebar Tab.
			// No /api/ego/spaces polling — the host-side markEgoToolCall()
			// pushes the event into the SSE stream the moment a tool runs.
			//
			// Why "increase beyond baseline" not "0 → >0": toolCallCount is a
			// host-process counter that persists across page reloads. The
			// baseline is fetched ONCE at mount via a single /api/ego/spaces
			// request; after that, only a NEW tool call (count goes up)
			// triggers the open.
			var probeDisposed = false
			var baseline = null // null = not yet observed; set on first fetch
			var autoOpened = false
			// One-shot baseline fetch (NOT a polling loop). After this, the
			// SSE `tool-call` event is the sole signal.
			void (async function () {
				if (probeDisposed) return
				try {
					var res = await fetch(SPACES_ROUTE, { cache: 'no-store' })
					if (!res.ok) return
					var data = await res.json()
					if (data && typeof data.toolCallCount === 'number') {
						baseline = data.toolCallCount
					}
				} catch (e) {}
			})()
			// Listen for tool-call events on the shared SSE stream. The probe
			// opens its OWN EventSource so it works even before the Tab is
			// mounted (the Tab's controller only connects after the Tab opens).
			var probeSse = null
			try { probeSse = new EventSource('/api/ego/stream') } catch (e) {}
			if (probeSse) {
				probeSse.addEventListener('tool-call', function (ev) {
					if (probeDisposed || autoOpened) return
					try {
						var m = JSON.parse(ev.data)
						if (!m || typeof m.count !== 'number') return
						if (baseline === null) {
							// Event arrived before the baseline fetch resolved —
							// treat this count as the baseline (it's the first
							// we've seen) and open on the NEXT one. But if count
							// is already >0, the agent has called a tool this
							// session, so open now.
							baseline = m.count
							if (m.count > 0) {
								autoOpened = true
								try { betterSidebar.openTab({ type: 'ego-browser:watch' }) } catch (e) {}
							}
							return
						}
						if (m.count > baseline) {
							autoOpened = true
							try { betterSidebar.openTab({ type: 'ego-browser:watch' }) } catch (e) {}
							// Auto-opened: close the probe stream (no longer needed).
							try { probeSse.close() } catch (e) {}
						}
					} catch (e) {}
				})
			}

			return function () {
				probeDisposed = true
				try { if (probeSse) probeSse.close() } catch (e) {}
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
