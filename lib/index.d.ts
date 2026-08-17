/**
 * ego-browser — DSH integration plugin for the ego-lite browser
 * (https://github.com/CitroLabs/ego-lite, MIT).
 *
 * ego lite is a Chromium browser built for AI agents: agents work in isolated
 * "task spaces" that inherit your real login state without stealing your tabs.
 * The official connection layer is the `ego-browser` CLI: `ego-browser nodejs`
 * reads a JS heredoc on stdin and runs it in a Node runtime with page-driving
 * facades preloaded (page/browser/taskSpaces/site/fetch, raw cdp).
 *
 * This plugin turns that CLI into structured HARNESS tools. Every action tool
 * builds a small script from its arguments, pipes it to `ego-browser nodejs`
 * through ctx.subprocess, and parses the result payload. Scripts target the
 * shared harness facade surface (preloaded by the ego-browser runtime itself):
 * taskSpaces.useOrCreate / .complete, browser.openOrReuseTab, page.info(),
 * page.snapshot(), page.evaluate(), page.waitForTimeout(), page.screenshot(),
 * page.locator(...).click()/.fill(), page.mouse.click(x, y), and the raw cdp().
 * Output is reported through console.log with a sentinel payload.
 *
 * Runtime requirements:
 *   - the `ego-browser` command on PATH (ego lite app, or the
 *     `ego-browser-v2` npm package; Node >= 22), and
 *   - a reachable ego lite browser (the app is macOS-only today; Linux is on
 *     the ego-lite roadmap, PR #202).
 */
export declare const name = "ego-browser";
export declare const inject: readonly ["tools", "subprocess"];
interface LoggerLike {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
interface ToolsLike {
    register(tool: unknown): unknown;
}
interface CollectReader {
    readFrom(offset: number): {
        text: string;
        nextOffset: number;
        lossy: boolean;
        spillPath?: string;
    };
}
interface SubprocessHandleLike {
    readonly done: Promise<{
        exitCode: number | null;
        signal: NodeJS.Signals | null;
    }>;
    readonly collected: {
        stdout?: CollectReader;
        stderr?: CollectReader;
    };
}
/** Structural subset of the dsh-subprocess `SubprocessSpawnSpec`. */
interface SpawnSpecLike {
    argv: readonly string[];
    cwd: string;
    stdio: {
        stdin: {
            data: string;
        };
        stdout: {
            maxBytes: number;
            spill?: {
                maxBytes: number;
            };
        };
        stderr: {
            maxBytes: number;
            spill?: {
                maxBytes: number;
            };
        };
    };
    graceMs: number;
    signal?: AbortSignal;
}
interface SubprocessLike {
    spawn(spec: SpawnSpecLike): SubprocessHandleLike;
}
interface CtxLike {
    tools: ToolsLike;
    subprocess: SubprocessLike;
    logger?: LoggerLike;
    /** Cordis lifecycle: register a dispose callback (e.g. cleanup on unmount). */
    effect?: (fn: () => unknown) => unknown;
}
export interface Config {
    /**
     * Path to the Chrome/Chromium binary. Empty string = auto-detect
     * (scan PATH + common fixed locations). Set via the DSH settings UI
     * (ego-browser card) or the composition layer (cordis.patch.yml).
     */
    chromePath?: string;
    /**
     * Cap on live-frame fan-out (frames/sec) from the cast worker to the
     * watch panel. 0 = uncapped (full browser repaint cadence). >0 = at
     * most N frames/sec; the watched (active) tab is never throttled, only
     * background repainting tabs. Range 0–60; default 0.
     */
    castFpsCap?: number;
    /**
     * JPEG quality (1–100) for screencast frames and screenshot backstop.
     * Range 1–100; default 55.
     */
    screencastQuality?: number;
    /**
     * Max width (CSS px) of each pushed screencast frame. Range 320–1920;
     * default 960.
     */
    screencastMaxWidth?: number;
    /**
     * Path or command name of the ego-browser CLI.
     * Default: the vendored CLI bundled inside this plugin
     * (`runtime/ego-linux/bin/ego-browser.mjs`), so the plugin works with just
     * an installed Chrome. Set to `ego-browser` (or a path) to use an
     * official App / other host instead.
     */
    egoBin?: string;
    /** Task-space name action tools use when no `space` argument is given. */
    defaultSpace?: string;
    /** In-memory cap for collected stdout (snapshots / JS results) in bytes. */
    maxOutputBytes?: number;
    /** Process-tree termination grace in ms. */
    graceMs?: number;
}
export declare const Config: {};
/** Find a usable Chrome/Edge/Brave binary by scanning PATH + common fixed locations. */
export declare function findChromeBinary(): string | undefined;
/** Build the env handed to `ego-browser nodejs` spawns (platform-injectable for testing). */
export declare function resolveEgoEnv(cfg: Partial<Config>, opts?: {
    platform?: string;
    baseEnv?: Record<string, string | undefined>;
}): Record<string, string | undefined>;
export declare function apply(ctx: CtxLike, config?: Partial<Config>): void;
export {};
