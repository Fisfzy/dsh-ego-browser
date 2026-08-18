# FFmpeg On-Demand Installation Design

## Goal

Keep the CDP capture backend independent of FFmpeg. Detect compatible local
FFmpeg installations first, and only download a pinned platform build after an
explicit user action. The FFmpeg backend remains unavailable until a binary has
passed platform capture and H.264 encoder probes.

## Sources

- Windows and Linux: pinned BtbN GitHub release tags and assets.
- macOS Intel/Apple Silicon: pinned `ffmpeg-static` GitHub release assets whose
  upstream binaries originate from Evermeet and OSXExperts respectively.

Every asset is identified by an exact URL and SHA-256 digest. Floating `latest`
or snapshot URLs are not allowed. GitHub URLs may be rewritten by replacing
`https://github.com` with the configured HTTPS mirror base. Non-GitHub sources
are not rewritten.

## Resolution

Candidates are checked in this order:

1. User-configured `ffmpegPath`.
2. `ffmpeg` from `PATH`.
3. The plugin-managed cache.

An invalid candidate does not block later candidates. Windows requires
`gfxcapture`; macOS requires `avfoundation`; Linux requires X11 and `x11grab`.
All platforms require a usable H.264 encoder. Wayland remains unsupported.

## Installation

The host owns a single installation manager. It downloads into a temporary
directory under `~/.dsh/cache/ego-browser/ffmpeg`, verifies the archive hash,
extracts only the declared FFmpeg executable, applies platform permissions,
probes the installed binary, writes `install.json`, and atomically renames the
temporary directory into place. Interrupted or failed installs never become
selectable.

The host exposes status, recheck, and install endpoints. Downloading continues
if the settings page closes, and duplicate install requests share one task.

## Settings UI

The settings card shows source, version, path, progress, and failure details.
It adds `githubMirror`, recheck, and download/reinstall controls. The FFmpeg
backend option is disabled until host status reports `canSelectFfmpeg: true`.
The settings gateway also rejects attempts to save FFmpeg while unavailable.

If a previously valid binary disappears, capture falls back to CDP for that
watch session and reports the reason without silently rewriting persisted
settings.

## Verification

Tests cover manifest selection, mirror rewriting, checksums, safe extraction,
candidate priority, platform probes, concurrent installs, gateway rejection,
UI disabling, progress states, and CDP fallback. Manual validation covers
Windows gfxcapture, macOS permissions and VideoToolbox, Linux X11, and explicit
Wayland rejection.
