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
  position: fixed; right: 18px; bottom: 104px; z-index: 9999;
  width: 48px; height: 48px; border-radius: 50%;
  border: 1px solid rgba(255,255,255,.14);
  background: rgba(30,30,32,.72);
  -webkit-backdrop-filter: blur(22px) saturate(180%);
  backdrop-filter: blur(22px) saturate(180%);
  color: #f5f5f7; cursor: pointer;
  box-shadow: 0 10px 30px rgba(0,0,0,.45);
  transition: transform .18s cubic-bezier(.2,.7,.3,1.3);
  display: flex; align-items: center; justify-content: center;
}
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
  position: fixed; right: 18px; bottom: 168px; z-index: 9998;
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
						<span id="dsh-ego-title">${ICON_GLOBE}<span style="margin-left:6px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Agent 浏览器</span></span>
						<button id="dsh-ego-refresh" class="dsh-ego-iconbtn" title="刷新">${ICON_REFRESH}</button>
						<button id="dsh-ego-historybtn" class="dsh-ego-iconbtn off" title="历史浏览轨迹">${ICON_CLOCK}</button>
						<button id="dsh-ego-close" class="dsh-ego-iconbtn" title="收起">${ICON_CLOSE}</button>
					</div>
					<div id="dsh-ego-tabs"></div>
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

				// Build the zoomable main-view <img>. Wheel zooms around the cursor,
				// drag pans, double-click resets. State is shared via zoomState.
				// `urlEl` is the URL line below the image: while the user is zooming
				// or panning it briefly shows the relevant hint instead of the URL.
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
					let dragging = false, sx = 0, sy = 0, stx = 0, sty = 0
					img.addEventListener('wheel', (e) => {
						e.preventDefault()
						const rect = img.getBoundingClientRect()
						const mx = e.clientX - rect.left, my = e.clientY - rect.top
						const next = Math.min(8, Math.max(1, zoomState.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
						if (next <= 1) {
							// Scrolling all the way in always snap back to the pristine
							// 1:1 fit — an easy, discoverable "reset" after panning.
							zoomState = { scale: 1, tx: 0, ty: 0 }
							apply()
							showHint('拖拽平移画面 · 滚轮缩放')
							return
						}
						showHint('滚轮缩放 · 按住拖动平移 · 缩小到最小或双击复位')
						// Zoom about the cursor: adjust translate so the point under the
						// cursor stays fixed.
						zoomState.tx = mx - (mx - zoomState.tx) * (next / zoomState.scale)
						zoomState.ty = my - (my - zoomState.ty) * (next / zoomState.scale)
						zoomState.scale = next
						apply()
					}, { passive: false })
					img.addEventListener('pointerdown', (e) => {
						dragging = true; sx = e.clientX; sy = e.clientY
						stx = zoomState.tx; sty = zoomState.ty
						img.setPointerCapture(e.pointerId); img.style.cursor = 'grabbing'
						showHint('拖拽平移画面 · 缩小到最小或双击复位')
					})
					img.addEventListener('pointermove', (e) => {
						if (!dragging) return
						zoomState.tx = stx + (e.clientX - sx)
						zoomState.ty = sty + (e.clientY - sy)
						apply()
					})
					const stop = (e) => { dragging = false; img.style.cursor = 'grab' }
					img.addEventListener('pointerup', stop)
					img.addEventListener('pointercancel', stop)
					img.addEventListener('dblclick', () => { zoomState = { scale: 1, tx: 0, ty: 0 }; apply() })
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
					const sorted = [...lastList].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
					if (sorted.length > 0) currentActiveId = sorted[0].targetId
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

				// Render the standard live main view (used by the default follow).
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
					if (current.thumbnail) {
						const img = makeZoomImage(u)
						img.src = current.thumbnail
						img.alt = 'live'
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

				const setOpen = (open) => {
					panel.hidden = !open
					// The FAB stays visible at all times — it is the persistent entry
					// point. Toggling marks it as "active" while the panel is open.
					fab.classList.toggle('on', open)
					try { localStorage.setItem(OPEN_KEY, open ? '1' : '0') } catch {}
					if (open) refresh()
				}
				fab.addEventListener('click', () => setOpen(panel.hidden))
				closeBtn.addEventListener('click', () => setOpen(false))
				refreshBtn.addEventListener('click', () => {
					// Show a spinner so a manual refresh has clear feedback even when
					// the underlying picture is static (no visible change).
					refreshBtn.classList.add('spinning')
					window.setTimeout(() => refreshBtn.classList.remove('spinning'), 800)
					refresh()
				})
				historyBtn.addEventListener('click', () => setHistory(!historyOpen))

				document.body.appendChild(fab)
				document.body.appendChild(panel)

				// Start collapsed: the FAB is the persistent entry point and should
				// not disappear just because a previous session left the panel open.
				// Ignore any stale OPEN_KEY so the ball always shows on load.
				try { localStorage.removeItem(OPEN_KEY) } catch {}
				panel.hidden = true
				fab.classList.remove('on')
				refresh()

				return () => {
					disposed = true
					if (pollTimer) window.clearTimeout(pollTimer)
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
