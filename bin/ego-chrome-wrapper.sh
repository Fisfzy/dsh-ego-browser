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

# Candidate Chrome binaries, in preference order. The first that exists wins.
for bin in \
  "${EGO_LINUX_CHROME:-}" \
  /usr/bin/google-chrome-stable \
  /usr/bin/google-chrome \
  /usr/bin/chromium \
  /usr/bin/chromium-browser \
  /opt/google/chrome/google-chrome \
  /usr/local/bin/google-chrome-stable \
  /snap/bin/chromium
do
  if [ -n "${bin:-}" ] && [ -x "${bin}" ]; then
    exec "${bin}" --no-sandbox ${EXTRA} "$@"
  fi
done

echo "ego-browser wrapper: no Chrome/Chromium binary found (searched common paths). Set EGO_LINUX_CHROME to an absolute path." >&2
exit 127
