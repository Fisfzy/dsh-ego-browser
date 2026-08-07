# ego-browser — DSH plugin (dshx external plugin)

Bring [CitroLabs/ego-lite](https://github.com/CitroLabs/ego-lite) — a Chromium
browser built for AI agents — into the DeepSeek Harness as 13 structured
`ego_*` tools, on the same plugin mechanism as `zotero-wave-rag`, `dsh-vision`
etc. (`~/.dsh/config.yaml` overlay + Cordis plugin entry).

**Linux + Chrome = out of the box.** The package **vendors the ego runtime**
(`runtime/`, from the MIT-licensed ego-lite project, see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)) — no cloning the upstream repo,
no manual build. A plain Chrome/Chromium is all that is needed on top.

## Prerequisites

| Requirement | Notes |
|---|---|
| Node >= 22 | provided by the harness |
| **Any Chrome / Chromium / Brave / Edge** | auto-discovered on `PATH`, or point `EGO_LINUX_CHROME` at a binary. **Running as root requires a `--no-sandbox` wrapper** (see below). |
| DSH + dshx | the plugin loader |

## Install

```sh
# 1. install (tarball or git URL)
dshx install ego-browser ego-browser-plugin-0.1.0.tgz

# 2. verify
dshx list                    # expect: [on] ego-browser

# 3. optional config (~/.dsh/config.yaml, under the plugin entry):
#    egoBin: /path/to/ego-browser       # default: the vendored CLI inside the package
#    defaultSpace: dsh-agent            # task space used when no `space` arg given
#    maxOutputBytes: 4194304            # stdout cap for snapshots/JS results
#    graceMs: 15000                     # process-tree termination grace
```

Notes:
- `egoBin` defaults to the vendored `runtime/ego-linux/bin/ego-browser.mjs`
  (includes the proxy patch). Users with the **official macOS app** set
  `egoBin: ego-browser` to use the official host instead.
- **root / Docker / CI**: Chrome refuses to run as root without `--no-sandbox`.
  Create a wrapper and point `EGO_LINUX_CHROME` at it:
  ```sh
  #!/bin/sh
  exec /usr/bin/google-chrome-stable --no-sandbox "$@"
  ```
- **headless servers**: set `EGO_LINUX_HEADLESS=1` to avoid opening a window.

## Tools (13, prefix `ego_`)

| Tool | What it does |
|---|---|
| `ego_status` | Probe whether the ego-browser CLI is usable (runs `--status`). |
| `ego_space_open` | Open/reuse a task space (isolated browsing context inheriting your login state); returns the space id. |
| `ego_space_close` | Complete/close a task space (`keep: true` leaves the page open). |
| `ego_snapshot` | Current page as a semantic text tree with `[ref=N, loc=...]` selectors for click/fill targeting. |
| `ego_navigate` | Open a URL or switch to the existing tab; waits for load; returns page info. |
| `ego_click` | Click by CSS/xpath/loc/ref selector or viewport coordinates. |
| `ego_fill` | Type text into an input. |
| `ego_js` | Evaluate a JS expression in the page; returns a JSON-serializable value. |
| `ego_cdp` | Raw CDP command (e.g. `Page.handleJavaScriptDialog`). |
| `ego_screenshot` | Screenshot; returns the PNG path (feed it to a vision tool). |
| `ego_page_info` | Current url/title/viewport/scroll, or a native dialog state. |
| `ego_wait` | Pause for a fixed number of milliseconds. |
| `ego_cli` | Escape hatch: run an arbitrary `ego-browser nodejs` heredoc script verbatim. |

## How it works

- Each tool composes a small JS script from its arguments and pipes it to
  `ego-browser nodejs` via `ctx.subprocess`; the vendored host drives a plain
  Chrome over CDP.
- Scripts use the shared harness facade surface (`taskSpaces.useOrCreate/.complete`,
  `browser.openOrReuseTab`, `page.info()`, `page.snapshotRaw()`, `page.evaluate()`,
  `page.waitForTimeout()`, `page.screenshot()`, `page.locator(...).click()/.fill()`,
  `page.mouse.click(x, y)`, raw `cdp()`) — identical on the macOS app and the Linux host.
- Results are reported via `console.log('@@DSH_RESULT@@' + JSON.stringify(payload))`;
  the plugin parses the sentinel line. `ego_snapshot` text renders directly.
- All `ego_*` executions are **serialized** through an in-process lock (one
  persistent browser is shared by every call); the plugin stops the browser
  best-effort on unmount (`ctx.effect`).
- Non-zero exits, missing CLI, and aborts surface as clear errors.

## Development

```sh
# build (lib/)
<dsh-checkout>/node_modules/.bin/tsc -p tsconfig.json

# tests (core suite):
#   smoke — plugin registration + error paths (fake CLI, always passes)
#   real-test — real-browser basic flow against example.com
#   verify-real — interactive loop + arXiv literature search (host flakiness may require a retry)
```

`node_modules/` contains only symlinks into a DSH checkout for compile-time type
resolution; the harness loader resolves `@deepseek-ai/dsh-tools` at runtime.

## Known limitations

- **Snapshot quality**: the Linux host rebuilds the semantic tree via CDP
  `DOMSnapshot.captureSnapshot` (refs faithful, content readable) — not the
  macOS kernel-level snapshot; complex iframes/canvases may degrade.
- **Official support**: Linux is an unmerged community PR (#234); macOS remains
  the officially supported platform.
- **Host reliability (Linux)**: the unmerged host can lose tab/space state
  across CLI invocations (blank tabs, occasional EPIPE). The plugin defends
  with `ensureRealTab`, snapshot retries, and EPIPE tolerance; simple flows are
  stable, complex multi-step flows may need a retry. Production use is
  recommended once official Linux support lands, or on the macOS app.
- **Output schema** is a permissive `additionalProperties: true` structure;
  client rendering follows the actual returned values.

## Verification record (2026-08, Linux + Chrome 151 + PR #234)

Verified against a real browser (headless):

```
✅ base read/write: ego_status / ego_navigate(example.com) / ego_snapshot / ego_js / ego_page_info / ego_space_close
✅ interactive loop (controlled page): ego_fill×2 → ego_click(form submit) → ego_js assert
   "submitted:hello DSH|a@b.c" → ego_wait → ego_click(#anchor) → ego_page_info(#target)
   → ego_screenshot(PNG on disk) → ego_cdp(Runtime.evaluate 1+1=2)
✅ literature search (arXiv): search snapshot → extract 5 real paper titles → take first URL →
   ego_click(loc=href:https://arxiv.org/abs/...) → abstract page reached
✅ audit gaps: ego_cli custom heredoc, ego_click coordinate mode, CJK input, snapshot scope param
   → 13/13 tools verified on a real browser
✅ concurrency lock: 6 concurrent calls → peak 1 active CLI
✅ fresh-install acceptance: tarball → clean dir + system Chrome → works with zero config
```

## License / attribution

The plugin itself is MIT. The vendored runtime embeds MIT-licensed code from
[CitroLabs/ego-lite](https://github.com/CitroLabs/ego-lite) (including the Linux
port in [PR #234](https://github.com/citrolabs/ego-lite/pull/234)) plus a local
proxy patch — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
