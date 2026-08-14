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
		// #endregion

		const inject = []

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
#dsh-ego-fab.dsh-ego-live .dsh-ego-dot { background: #30d158; box-shadow: 0 0 8px #30d158aa; }
#dsh-ego-fab.dsh-ego-busy .dsh-ego-dot { background: #ffd60a; box-shadow: 0 0 8px #ffd60aaa; }
#dsh-ego-fab svg { width: 22px; height: 22px; }

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
}
#dsh-ego-panel[hidden] { display: none; }
#dsh-ego-panel.open-drawer { width: 640px; }

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
  background:#30d158; box-shadow:0 0 6px #30d15888; flex-shrink:0; }
.dsh-ego-state-dot.pin { background:#0a84ff; box-shadow:0 0 6px #0a84ff88; }
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
			if (document.getElementById('dsh-ego-fab') !== null) return

			ctx.effect(() => {
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
				const FLUSH_ROUTE = '/api/ego/flush'

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
						: `<span class="dsh-ego-state-dot"></span> 正在实时浏览`
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
					const sorted = [...lastList].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
					if (sorted.length > 0) currentActiveId = sorted[0].targetId
					// Reflect whether a page is present (for the login guide).
					maybeShowLoginGuide()
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
					const current = sel || sorted[0]
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
						: `<span class="dsh-ego-state-dot"></span> 正在实时浏览`
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
					// Snapshot the page viewport for coordinate mapping.
					if (Number.isFinite(vw) && Number.isFinite(vh)) {
						const cur = pageMeta.get(targetId) || { targetId }
						pageMeta.set(targetId, { ...cur, vw, vh })
					}
					// Swap the currently shown image in place, no view rebuild.
					if (liveImg && liveImgTargetId === targetId) {
						try { liveImg.src = dataUrl } catch {}
						return
					}
					// Auto-follow: while not pinned to a history page and not pinned to
					// a manually chosen tab, jump to the page the agent is actively
					// driving (the one emitting frames right now). Tolerates a new
					// target that has no lastList row yet by reading pageMeta, and
					// skips the rebuild when we are already showing that very page.
					if (!pinned && selectedTabId === null) {
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

				// ── draggable floating FAB + panel ──
				// The FAB and the panel move together as one unit. Position is
				// stored top-left of the FAB; the panel sits a fixed offset up-left
				// of it. Persisted so a user's preferred spot survives reloads.
				const DRAG_KEY = 'dsh.ego.watch.pos'
				const FAB_W = 48, FAB_H = 48
				const PANEL_DX = -66, PANEL_DY = -66
				let pos = null
				try {
					const saved = JSON.parse(localStorage.getItem(DRAG_KEY) || 'null')
					if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) pos = saved
				} catch {}
				if (!pos) {
					// Mimic the old fixed `right:18; bottom:104` default.
					pos = { x: window.innerWidth - 18 - FAB_W, y: window.innerHeight - 104 - FAB_H }
				}
				const clampPos = () => {
					const vw = window.innerWidth, vh = window.innerHeight
					pos.x = Math.max(4, Math.min(vw - FAB_W - 4, pos.x))
					pos.y = Math.max(4, Math.min(vh - FAB_H - 4, pos.y))
				}
				const layoutDrag = () => {
					clampPos()
					fab.style.left = pos.x + 'px'
					fab.style.top = pos.y + 'px'
					panel.style.left = Math.round(pos.x + PANEL_DX) + 'px'
					panel.style.top = Math.round(pos.y + PANEL_DY) + 'px'
				}
				const saveDrag = () => { try { localStorage.setItem(DRAG_KEY, JSON.stringify(pos)) } catch {} }
				layoutDrag()
				let suppressFabClick = false
				/**
				 * Make an element drag the whole FAB+panel unit. A movement of under
				 * ~5px is treated as a plain click so the FAB still toggles the panel.
				 * Interactive children (buttons/icons) never start a drag.
				 */
				const makeDraggable = (el) => {
					let sx = 0, sy = 0, bx = 0, by = 0, active = false, dragged = false
					const down = (e) => {
						if (e.button !== 0) return
						if (e.target && e.target.closest && e.target.closest('button, a, input, .dsh-ego-iconbtn')) return
						active = true; dragged = false
						sx = e.clientX; sy = e.clientY
						bx = pos.x; by = pos.y
						try { el.setPointerCapture(e.pointerId) } catch {}
						el.classList.add('dsh-ego-dragging')
						e.preventDefault()
					}
					const move = (e) => {
						if (!active) return
						const dx = e.clientX - sx, dy = e.clientY - sy
						if (!dragged && Math.abs(dx) + Math.abs(dy) > 5) dragged = true
						if (dragged) { pos.x = bx + dx; pos.y = by + dy; layoutDrag() }
					}
					const up = (e) => {
						if (!active) return
						active = false
						el.classList.remove('dsh-ego-dragging')
						try { el.releasePointerCapture(e.pointerId) } catch {}
						if (dragged) { suppressFabClick = true; saveDrag() }
					}
					el.addEventListener('pointerdown', down)
					el.addEventListener('pointermove', move)
					el.addEventListener('pointerup', up)
					el.addEventListener('pointercancel', up)
				}
				// FAB + panel header are both drag handles for the whole unit.
				makeDraggable(fab)
				makeDraggable(panel.querySelector('#dsh-ego-head'))

				const setOpen = (open) => {
					panel.hidden = !open
					// The FAB stays visible at all times — it is the persistent entry
					// point. Toggling marks it as "active" while the panel is open.
					fab.classList.toggle('on', open)
					try { localStorage.setItem(OPEN_KEY, open ? '1' : '0') } catch {}
					if (open) refresh()
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
					if (disposed) return
					const hasPage = lastList.some(s => s.url && !s.url.startsWith('about:'))
					loginEl.classList.toggle('show', hasPage)
					loginNote.textContent = ''
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
					if (followTimer) window.clearTimeout(followTimer)
					if (pollTimer) window.clearTimeout(pollTimer)
					try { if (sse) sse.close() } catch {}
					fab.remove()
					panel.remove()
					style.remove()
				}
			}, 'ego-browser watch panel')
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
