# Third-Party Notices

This plugin **vendors** (embeds) the following open-source components from the
[CitroLabs/ego-lite](https://github.com/CitroLabs/ego-lite) project (MIT License),
including the Linux port work in [PR #234](https://github.com/citrolabs/ego-lite/pull/234)
(`package/ego-linux`):

| Vendored component | Source | License |
|---|---|---|
| `runtime/ego-browser/dist/out/index.js` | shared ego-browser harness build (`package/ego-browser`) | MIT |
| `runtime/ego-linux/*` | Linux CDP host (`package/ego-linux`, PR #234) + local proxy patch | MIT |
| `runtime/skills/ego-browser/*` | agent skill package (`skills/ego-browser`) | MIT |
| BtbN FFmpeg builds (optional download) | https://github.com/BtbN/FFmpeg-Builds | GPL-3.0-or-later for the selected GPL build |
| `ffmpeg-static` macOS release assets (optional download) | https://github.com/eugeneware/ffmpeg-static | GPL-3.0-or-later; upstream binaries originate from Evermeet/OSXExperts |
| FFmpeg | https://ffmpeg.org/ | GPL-3.0-or-later for the selected builds |

## FFmpeg distribution notice

The CDP backend does not require FFmpeg. The optional FFmpeg backend first checks
the user path and system PATH, then offers an explicit managed download into the
user cache. No FFmpeg executable is included in this repository or npm package.
Users and distributors must comply with the license attached to the selected
build, preserve notices, and provide corresponding source as required. Sources:

- BtbN builds: https://github.com/BtbN/FFmpeg-Builds
- macOS release assets: https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1
- Evermeet macOS Intel builds: https://evermeet.cx/ffmpeg/
- OSXExperts Apple Silicon builds: https://www.osxexperts.net/
- FFmpeg: https://git.ffmpeg.org/ffmpeg.git
- GPL v3 text: https://www.gnu.org/licenses/gpl-3.0.html

Using a user-supplied FFmpeg binary may carry different licensing obligations;
the user/distributor is responsible for the selected build.

Additional local modifications on top of upstream (see `runtime/ego-linux/src/chrome.mjs`):
- `EGO_LINUX_PROXY` support: injects `--proxy-server` / `--proxy-bypass-list` into the
  launched Chrome, so the agent browser can reach the network through a local proxy
  without hijacking the CLI's own loopback CDP traffic.

MIT License (as provided by the upstream project):

    MIT License

    Copyright (c) 2026 CitroLabs (ego-lite) and contributors

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
