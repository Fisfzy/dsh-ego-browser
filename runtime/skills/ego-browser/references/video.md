# Video recording

Record the current page viewport with Playwright-style `page.screencast`. Start and stop the recording in the same Bash invocation so FFmpeg can finalize the silent VP8 WebM file.

```js
await page.screencast.start({
  path: "/absolute/path/browser-run.webm",
  size: { width: 1280, height: 720 },
  quality: 90,
});

// Perform and verify browser actions here.

await page.screencast.stop();
```

The path must end in `.webm`; relative paths resolve from the CLI working directory, and missing parent directories are created. `quality` is an integer from 0 to 100. Dimensions are rounded down to even values for VP8. When `size` is omitted, the viewport is scaled down to fit within 800×800. Frames are scaled and letterboxed into the selected bounds if the viewport size changes during recording. The finalized file replaces the destination only after FFmpeg succeeds. Recording captures the page viewport without audio or browser chrome. Install `ffmpeg` on `PATH` or set `EGO_BROWSER_FFMPEG_PATH` to its executable.
