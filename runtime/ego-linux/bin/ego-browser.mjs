#!/usr/bin/env node
/**
 * ego-browser, Linux edition.
 *
 * Same CLI shape as the macOS app's `ego-browser`: a heredoc of JS on stdin,
 * executed with every ego-browser helper preloaded. The difference is what backs
 * it — `globalThis.ego` is this port's CDP shim over a stock Chromium instead of
 * the app's native bindings. Everything above that line is the upstream harness,
 * unmodified.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { browserStatus, stopBrowser } from "../src/chrome.mjs";
import { installDesktopEntry } from "../src/desktop.mjs";
import {
  CHROME_CONFIG_CANDIDATES,
  PROFILE_DIR,
  SPACES_STATE_FILE,
  TASK_SPACE_FILE,
  STATE_DIR,
} from "../src/paths.mjs";
import { createEgoShim } from "../src/shim.mjs";
import { startSpacesServer } from "../src/spaces-server.mjs";

const HARNESS = new URL("../../ego-browser/dist/out/index.js", import.meta.url);
const SKILL_WORKSPACE = new URL("../../skills/ego-browser", import.meta.url); // vendored layout: runtime/ego-linux/bin -> runtime/skills/ego-browser

const USAGE = `ego-browser (Linux port)

  ego-browser <<'JS'
  await page.goto('https://example.com')
  console.log(await page.snapshot())
  JS

Linux-only commands:
  --status                  show the backing browser's connection state
  --open                    open the shared agent browser window
  --spaces                  open the Spaces overview panel
  --prune-spaces            close spaces that hold nothing but about:blank
                            Spaces nobody returns to are also closed on their
                            own after 30 minutes idle; a space stays alive as
                            long as its session keeps using it. Set
                            EGO_LINUX_SPACE_IDLE_MIN to change the window, or
                            0 to sweep only by hand
  --serve                   resident request/response loop over stdio: one JSON
                            request per line ({"id","code"}) in, one JSON response
                            per line ({"id","ok","stdout","stderr"}) out. Pays
                            process startup and harness import once instead of per
                            call. Not for interactive use — a host drives it.
  --stop                    stop the backing browser
  --import-chrome-profile   copy your real Chrome profile in, to inherit logins
  --install-desktop-entry   add it to your app launcher, with an icon
  --headless                run the backing browser headless (first launch only)
                            EGO_LINUX_HEADLESS=1 makes that the default, so the
                            agent window never opens over your work; --open
                            still gives you a visible one when you want it
`;

async function importChromeProfile() {
  const source = CHROME_CONFIG_CANDIDATES.find((candidate) =>
    existsSync(join(candidate, "Default")),
  );
  if (!source) {
    process.stderr.write("no Chrome/Chromium profile found to import\n");
    return 1;
  }
  const status = await browserStatus();
  if (status.running) {
    process.stderr.write(
      "the backing browser is running; run --stop and close it before importing\n",
    );
    return 1;
  }
  process.stderr.write(`importing ${join(source, "Default")} -> ${PROFILE_DIR}/Default\n`);
  await cp(join(source, "Default"), join(PROFILE_DIR, "Default"), {
    recursive: true,
    force: true,
  });
  process.stderr.write("done — logins and cookies now carry into agent tasks\n");
  return 0;
}

/** Is a Spaces server already listening on the recorded port? */
async function liveSpacesServer() {
  try {
    const state = JSON.parse(await readFile(SPACES_STATE_FILE, "utf8"));
    const response = await fetch(`http://127.0.0.1:${state.port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok ? state.port : null;
  } catch {
    return null;
  }
}

/** Open the panel as a chrome-less app window on the shared browser. */
async function openPanelWindow(url) {
  const status = await browserStatus();
  spawn(status.binary || "google-chrome", [`--user-data-dir=${PROFILE_DIR}`, `--app=${url}`], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

/**
 * Serve the Spaces panel until the browser goes away.
 *
 * Runs detached, because the panel's backend must outlive the command that
 * opened it. Tying the server to a foreground CLI process meant that closing
 * the terminal — or any timeout around it — left the panel showing
 * "cannot reach the browser".
 */
async function runSpacesDaemon() {
  // Spaces created from the panel are the user's, not the profile that happened
  // to launch this daemon (see agent-identity.mjs).
  process.env.EGO_LINUX_PANEL = "1";
  const shim = await createEgoShim({ headless: false });
  const spaces = await startSpacesServer(shim);
  const url = `http://127.0.0.1:${spaces.port}/`;

  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    SPACES_STATE_FILE,
    JSON.stringify({ port: spaces.port, pid: process.pid }, null, 2),
  );

  // The daemon owns the window it serves, so starting one always shows it.
  await openPanelWindow(url);

  const outcome = await new Promise((resolve) => {
    process.on("SIGINT", () => resolve("signal"));
    process.on("SIGTERM", () => resolve("signal"));

    // Give Chrome a moment to register the window before deciding it is absent.
    let seenPanel = false;
    const started = Date.now();

    const timer = setInterval(async () => {
      let tabs;
      try {
        ({ tabs } = await shim.ego.listTabs());
      } catch {
        // The browser went away, taking every window — including this panel —
        // with it. That is a restart, not a decision, so hand off to a fresh
        // daemon that will reopen the panel against the new browser.
        clearInterval(timer);
        resolve("browser-gone");
        return;
      }

      const open = tabs.some((tab) => tab.url.startsWith(url));
      if (open) {
        seenPanel = true;
        return;
      }
      // Closing the panel while the browser keeps running is deliberate: stop
      // serving rather than reopening a window the user just dismissed.
      if (seenPanel || Date.now() - started > 20000) {
        clearInterval(timer);
        resolve("panel-closed");
      }
    }, 2500);
  });

  spaces.close();
  shim.close();
  await rm(SPACES_STATE_FILE, { force: true });

  if (outcome === "browser-gone") {
    spawn(process.execPath, [fileURLToPath(import.meta.url), "--spaces-daemon"], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }
  return 0;
}

/**
 * Open the Spaces overview.
 *
 * The panel is a real Chrome app window (`--app`): no tab strip, no toolbar, its
 * own app_id. Chrome routes the request to the already-running instance because
 * the profile matches, so this adds a window rather than a second browser.
 */
async function openSpaces() {
  const running = await liveSpacesServer();

  // A running daemon already owns a window; ask it for another one. A cold start
  // opens its own, so opening one here too would give you two.
  if (running) {
    await openPanelWindow(`http://127.0.0.1:${running}/`);
    process.stderr.write(`Spaces panel: http://127.0.0.1:${running}/\n`);
    return 0;
  }

  spawn(process.execPath, [fileURLToPath(import.meta.url), "--spaces-daemon"], {
    detached: true,
    stdio: "ignore",
  }).unref();

  let port = null;
  const deadline = Date.now() + 30000;
  while (!port && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    port = await liveSpacesServer();
  }
  if (!port) {
    process.stderr.write("the Spaces server did not come up\n");
    return 1;
  }

  process.stderr.write(`Spaces panel: http://127.0.0.1:${port}/\n`);
  return 0;
}

/**
 * Sweep spaces that hold nothing but about:blank.
 *
 * The automatic sweep in reconcile only touches spaces stamped with a creation
 * time, so it cannot reach the drift left behind before that existed — and a
 * user staring at twenty empty windows wants them gone now, not in two minutes.
 * Explicitly invoked, so it ignores age and asks no questions.
 */
async function pruneSpaces() {
  // Maintenance must never be the thing that opens a browser. Forcing a headed
  // launch here meant running the sweep on a quiet machine started a visible
  // window — producing exactly the empty windows it exists to clear.
  const status = await browserStatus();
  if (!status.running) {
    process.stdout.write("no backing browser is running; nothing to prune\n");
    return 0;
  }
  const shim = await createEgoShim({ headless: status.headless === true });
  try {
    const { taskSpaces = [] } = await shim.ego.listTaskSpaces();
    // The selected space is the one an agent is working in right now, and its
    // tab is about:blank for a moment on every navigation. Closing it would
    // take the agent's context out from under it mid-task.
    let selectedId = null;
    try {
      ({ selectedId = null } = JSON.parse(await readFile(TASK_SPACE_FILE, "utf8")));
    } catch {
      // No state file means no selection to protect.
    }
    const { targetInfos = [] } = await shim.cdp.call("Target.getTargets");
    const byTarget = new Map(targetInfos.map((target) => [target.targetId, target]));

    let closed = 0;
    for (const space of taskSpaces) {
      const tabs = (space.targetIds || []).map((id) => byTarget.get(id)).filter(Boolean);
      if (tabs.length === 0) continue;
      if (space.id === selectedId) continue;
      if (space.lastContentAt) continue;
      if (!tabs.every((target) => target.url === "about:blank")) continue;
      await shim.ego.closeTaskSpace(space.id).then(
        () => {
          closed += 1;
        },
        () => {},
      );
    }
    process.stdout.write(
      closed === 0
        ? "no empty spaces to close\n"
        : `closed ${closed} empty ${closed === 1 ? "space" : "spaces"}\n`,
    );
  } finally {
    shim.close();
  }
  return 0;
}

/**
 * `--serve`: a resident request/response loop over stdio, so a host that makes
 * many `ego_*` calls can pay process startup and harness import ONCE instead of
 * per call. Measured on Windows/Edge 151: ~350ms per call via spawn-per-call
 * (of which ~246ms is the host's own spawn path) versus ~8ms resident.
 *
 * Protocol — newline-delimited JSON, one exchange per line:
 *
 *   --> {"id":"1","code":"<the heredoc the plugin would have piped to stdin>"}
 *   <-- {"id":"1","ok":true,"stdout":"<verbatim script stdout>","stderr":"<...>"}
 *   <-- {"id":"1","ok":false,"error":"<message>","stdout":"...","stderr":"..."}
 *
 * The frame carries the streams VERBATIM and nothing else. It deliberately does
 * NOT wrap or re-emit the `@@DSH_RESULT@@` sentinel: that sentinel is printed by
 * the script the caller generates, not by this runner, and the caller's reader
 * already scans the collected stdout backwards for the last sentinel-carrying
 * line. If this layer also stamped one, it would have to re-implement last-wins
 * and a script that merely *prints* sentinel-shaped text (very reachable — any
 * script that echoes a source file) could be mistaken for the response. Keeping
 * the sentinel in exactly one place means the blob handed to the reader is
 * byte-identical to the one-shot path, so collision is not possible.
 *
 * Two traps this loop has to work around, both verified by experiment:
 *
 *  1. `console.log` is re-pointed at the run's output sink by the harness's
 *     `executionContext()`, permanently, for the life of the process. From the
 *     second request onward, calling `console.log` here would route protocol
 *     output into the captured stdout of whichever script is running (or drop it
 *     entirely). Protocol lines therefore go through `process.stdout.write`,
 *     captured before any script runs.
 *
 *  2. A script can leave globals behind — and not only NEW ones. Snapshotting the
 *     key set is not enough: `globalThis.fetch = ...` leaves the key set
 *     unchanged while replacing the value. The snapshot records VALUES (shallow
 *     references, ~80 entries) and the restore both deletes additions and puts
 *     overwritten values back, so a resident process matches spawn-per-call
 *     isolation without the harness needing to know.
 */

/** Collect a sink's text without touching the process streams. */
function createCapture() {
  const chunks = [];
  return {
    sink: { write: (chunk) => chunks.push(String(chunk)) },
    text: () => chunks.join(""),
  };
}

/**
 * Snapshot every own property of `globalThis`, keys AND descriptors.
 *
 * `Object.entries`/`Object.keys` are not usable here: on this Node they see 15 of
 * 135 own globals, silently omitting `Object`, `Function`, `Promise`, `Error` and
 * the rest of the built-ins — exactly the ones a script is most likely to
 * poison. `Object.getOwnPropertyNames` sees all of them.
 *
 * Descriptors, not values, because a script can replace a property's
 * ACCESSOR as well as its value, and because restoring a non-writable property
 * by assignment throws in strict mode.
 *
 * @returns {Map<string, PropertyDescriptor>}
 */
function snapshotGlobals() {
  const snapshot = new Map();
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    if (descriptor !== undefined) snapshot.set(key, descriptor);
  }
  return snapshot;
}

/**
 * Undo a script's global side effects: remove what it added, put back what it
 * replaced. Together these make a resident process match spawn-per-call
 * isolation without the harness having to know.
 *
 * @param {Map<string, PropertyDescriptor>} before - from {@link snapshotGlobals}.
 */
function restoreGlobals(before) {
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    if (before.has(key)) continue;
    // A global the script invented. Deleting is the spawn-per-call equivalent.
    try {
      delete globalThis[key];
    } catch {
      // Non-configurable; nothing to do.
    }
  }
  for (const [key, descriptor] of before) {
    const current = Object.getOwnPropertyDescriptor(globalThis, key);
    // Cheap identity check first: the overwhelmingly common case is untouched.
    if (current !== undefined && Object.is(current.value, descriptor.value)
      && Object.is(current.get, descriptor.get)
      && Object.is(current.set, descriptor.set)) {
      continue;
    }
    try {
      Object.defineProperty(globalThis, key, descriptor);
    } catch {
      // Non-configurable and already replaced; nothing to do.
    }
  }
}

/**
 * Read newline-delimited JSON from a stream.
 *
 * Yields raw lines rather than parsed objects so the caller can answer a
 * malformed line with an error frame instead of dying — a wedged serve process
 * would take every subsequent tool call with it.
 */
async function* readLines(stream) {
  stream.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim() !== "") yield line;
    }
  }
  // A final line with no trailing newline is still a request.
  if (buffer.trim() !== "") yield buffer;
}

async function serve({ harness, headless }) {
  // Captured before any script runs: `console.log` is about to be hijacked, and
  // process.stdout itself can be redirected later by a script.
  const writeLine = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

  const shim = await createEgoShim({ headless });
  globalThis.ego = shim.ego;

  const { runMain } = await import(harness);

  // `globalThis.ego` is setup state, not script state: the snapshot/restore pair
  // below runs around each request, and re-asserting it keeps the restored
  // globals from ever removing the harness's own bridge.
  const pinEgo = () => {
    globalThis.ego = shim.ego;
  };

  try {
    for await (const line of readLines(process.stdin)) {
      let request;
      try {
        request = JSON.parse(line);
      } catch (error) {
        // No id to echo back — the caller cannot correlate this one, but it must
        // not wedge the loop.
        writeLine({
          id: null,
          ok: false,
          error: `malformed request line: ${error?.message ?? error}`,
          stdout: "",
          stderr: "",
        });
        continue;
      }

      const id = request?.id ?? null;
      const snapshot = snapshotGlobals();
      const out = createCapture();
      const err = createCapture();

      let ok = true;
      let errorMessage;
      try {
        await runMain({
          argv: [],
          stdinText: String(request?.code ?? ""),
          stdout: out.sink,
          stderr: err.sink,
        });
      } catch (error) {
        // `execute()` rethrows a script throw after stopScreencast(); the stream
        // itself is still healthy, so this is a per-request failure, not a fatal.
        ok = false;
        errorMessage = String(error?.message ?? error);
      } finally {
        restoreGlobals(snapshot);
        pinEgo();
      }

      writeLine({
        id,
        ok,
        ...(ok ? {} : { error: errorMessage ?? "unknown failure" }),
        stdout: out.text(),
        stderr: err.text(),
      });
    }
  } finally {
    shim.close();
  }
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);

  // The skill documents `ego-browser nodejs <<'EOF'`; accept it as a no-op prefix.
  if (argv[0] === "nodejs") argv.shift();

  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv[0] === "--status") {
    process.stdout.write(`${JSON.stringify(await browserStatus(), null, 2)}\n`);
    return 0;
  }
  if (argv[0] === "--stop") {
    const stopped = await stopBrowser();
    process.stdout.write(
      stopped
        ? "backing browser stopped; the next run launches a fresh one\n"
        : "no backing browser was running; profile lock cleared\n",
    );
    return 0;
  }
  if (argv[0] === "--import-chrome-profile") {
    return importChromeProfile();
  }
  if (argv[0] === "--prune-spaces") {
    return pruneSpaces();
  }
  if (argv[0] === "--spaces") {
    return openSpaces();
  }
  if (argv[0] === "--spaces-daemon") {
    return runSpacesDaemon();
  }
  if (argv[0] === "--install-desktop-entry") {
    const { entryPath, iconPath } = await installDesktopEntry();
    process.stdout.write(`installed ${entryPath}\n         ${iconPath}\n`);
    return 0;
  }
  if (argv[0] === "--open") {
    // Launched from a desktop icon there is no terminal to read an error in, so
    // this has to succeed rather than explain. A headless browser has no window
    // to show, so trade it for a visible one.
    const status = await browserStatus();
    if (status.running && status.headless) {
      process.stderr.write("replacing the headless browser with a visible one\n");
      await stopBrowser();
    }
    const shim = await createEgoShim({ headless: false });
    try {
      const { tabs } = await shim.ego.listTabs();
      // A browser with no page target shows no window; give it one.
      let targetId = tabs.find((tab) => tab.active)?.targetId ?? tabs[0]?.targetId;
      if (!targetId) ({ targetId } = await shim.ego.createTab("about:blank"));

      // The window usually already exists — it is just behind everything else.
      // Clicking a launcher icon has to raise it, not quietly confirm it is
      // running, which looks identical to nothing happening.
      await shim.cdp.call("Target.activateTarget", { targetId }).catch(() => {});
      const { sessionId } = await shim.cdp.call("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      await shim.cdp.call("Page.bringToFront", {}, sessionId).catch(() => {});
    } finally {
      shim.close();
    }
    return 0;
  }

  // EGO_LINUX_HEADLESS is for a machine whose owner does not want the agent
  // window in front of their work (or a box with no display at all). When a
  // usable X display is present (e.g. an Xvfb), run headed so the compositor
  // produces full-rate screencast frames for the watch panel — headless would
  // fall back to swiftshader (~1 fps). --headless still forces headless per run.
  // Windows always "has a display" (the desktop session; see ensureXDisplay's
  // win32 branch) — without this the post-#22 default flipped headed cold
  // starts into an Xvfb lookup that can never succeed there.
  const hasDisplay =
    process.platform === "win32" || (process.env.DISPLAY || "").trim() !== "";
  // An explicit EGO_LINUX_HEADLESS=1 always wins — even on Windows, where
  // hasDisplay is hard-coded true (issue #35: the variable used to be silently
  // ignored there). The display probe only decides when the variable is unset.
  const headlessEnv = (process.env.EGO_LINUX_HEADLESS ?? "").toLowerCase();
  const envHeadless = ["1", "true", "yes", "on"].includes(headlessEnv)
    ? true
    : hasDisplay
      ? false
      : !["", "0", "false", "no"].includes(headlessEnv);
  const headless = argv.includes("--headless") || envHeadless;
  const rest = argv.filter((arg) => arg !== "--headless");

  // `--sdk-path <file>` selects which harness bundle to run. Upstream's real
  // browser e2e runner passes it to test a local build; here the local build is
  // the only harness there is, so honour the path it names.
  let harness = HARNESS.href;
  const sdkFlag = rest.indexOf("--sdk-path");
  if (sdkFlag !== -1) {
    const path = rest[sdkFlag + 1];
    if (!path) {
      process.stderr.write("--sdk-path requires a path\n");
      return 2;
    }
    harness = pathToFileURL(path).href;
    rest.splice(sdkFlag, 2);
  }

  // Site skills and learnings live in the repo's skill directory.
  process.env.EGO_BROWSER_AGENT_WORKSPACE ||= SKILL_WORKSPACE.pathname;

  // `--serve` owns its own shim/import lifecycle (both are paid once, up front),
  // so it is dispatched here — after headless and the harness path are resolved,
  // and instead of the one-shot shim below. Handled before the one-shot path so
  // a serve process never opens two overlapping browser connections.
  if (rest[0] === "--serve") {
    return serve({ harness, headless });
  }

  const shim = await createEgoShim({ headless });
  globalThis.ego = shim.ego;

  const { runMain } = await import(harness);
  try {
    return await runMain({ argv: rest });
  } finally {
    shim.close();
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(1);
  });
