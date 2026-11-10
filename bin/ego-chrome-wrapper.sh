#!/bin/sh
# ego-browser — bundled --no-sandbox Chrome wrapper.
#
# Shipped INSIDE this plugin so it requires no host-side setup: root / Docker /
# CI environments refuse to run Chrome without `--no-sandbox`, and that flag
# cannot be passed through EGO_LINUX_CHROME (which takes a bare binary path).
# This wrapper finds a usable Chrome binary and execs it with `--no-sandbox`,
# forwarding every other flag the ego-linux CLI passes.
#
# It only ever ADDS --no-sandbox (via the wrapper) and never changes any other
# launch argument, so behavior on non-root machines is identical to pointing
# EGO_LINUX_CHROME straight at the binary.
set -eu

# Frame-rate uncap is OPT-IN and OFF by default. Measured on Chromium:
# --disable-frame-rate-limit (and worse, --disable-gpu-vsync) makes the compositor
# spin ~250% CPU even on a static page — a bad trade. As a consequence the
# watch-panel screencast stays at Chromium's native (throttled) cadence unless
# EGO_FRAME_RATE_UNCAP=1 is explicitly set by someone who wants higher FPS even
# if the page is not repainting. The worker's EGO_CAST_FPS_CAP and the frontend's
# rAF-coalesced frame flush are the low-cost levers; use those first.
EXTRA=""
if [ "${EGO_FRAME_RATE_UNCAP:-0}" = "1" ]; then
  EXTRA="--disable-frame-rate-limit"
fi

# Resolve our own absolute path so we can refuse to exec ourselves. On root
# hosts the plugin sets EGO_LINUX_CHROME to this very wrapper (see
# resolveEgoEnv in lib/index.js); without this guard the first candidate below
# would exec us again — re-appending --no-sandbox on every pass — and spin
# forever instead of ever reaching a real browser binary.
SELF="$(readlink -f "$0" 2>/dev/null || echo "$0")"

# Resolve a real browser binary and exec it. Preference order:
#   1. EGO_LINUX_CHROME_BIN — the plugin's own findChromeBinary() result, so the
#      wrapper and `ego_doctor` can never disagree about which binary is used.
#   2. Fixed common install paths.
#   3. PATH lookup (`command -v`), which covers custom shims such as
#      /usr/local/bin/chromium on rootless/Android proot hosts (issue #98).
run_bin() {
  bin="$1"
  shift
  if [ -n "${bin:-}" ] && [ -x "${bin}" ]; then
    if [ "$(readlink -f "${bin}" 2>/dev/null || echo "${bin}")" != "${SELF}" ]; then
      exec "${bin}" --no-sandbox ${EXTRA} "$@"
    fi
  fi
}

for bin in \
  "${EGO_LINUX_CHROME_BIN:-}" \
  "${EGO_LINUX_CHROME:-}" \
  /usr/bin/google-chrome-stable \
  /usr/bin/google-chrome \
  /usr/bin/chromium \
  /usr/bin/chromium-browser \
  /opt/google/chrome/google-chrome \
  /usr/local/bin/google-chrome-stable \
  /usr/local/bin/chromium \
  /snap/bin/chromium
do
  run_bin "${bin:-}" "$@"
done

# PATH fallback: custom installs (Playwright, Homebrew, proot shims) are often
# only reachable through PATH, which the fixed list above cannot see.
for name in google-chrome-stable google-chrome chromium chromium-browser chrome
do
  bin="$(command -v "${name}" 2>/dev/null || true)"
  run_bin "${bin:-}" "$@"
done

echo "ego-browser wrapper: no Chrome/Chromium binary found (searched EGO_LINUX_CHROME_BIN, common paths and PATH). Set EGO_LINUX_CHROME_BIN or EGO_LINUX_CHROME to an absolute path." >&2
exit 127
