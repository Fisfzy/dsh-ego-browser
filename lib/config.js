// lib/config.js — composition-layer schema, resolved config shape, and resolver.
//
// The composition `Config` (cordis.patch.yml) is the first-boot seed; the
// settings user layer composes on top of it at runtime. `resolveConfig`
// normalises any combination of partial source values (composition, user
// layer, or both) into a fully-populated shape the tool registration and
// gateway can consume.
import z from "schemastery";

/**
 * Schemastery schema for the composition entry and the `ego-browser` settings
 * namespace. Exposed as the plugin's `Config` export so cordis's loader
 * validates the composition layer and `ctx.settings.register()` validates the
 * user layer.
 */
export const Config = z.object({
  /**
   * Path to the Chrome/Chromium/Edge binary. Empty string means "auto-detect"
   * (scan PATH + common fixed locations via `findChromeBinary()`). Set this
   * when auto-detection fails or you want to pin a specific browser.
   */
  chromePath: z.string().default("").description(
    "Path to the Chrome/Chromium binary. Empty = auto-detect.",
  ),
  /**
   * Base refresh interval (ms) for the realtime watch panel: how often the
   * client polls /api/ego/spaces for live screenshots / tab list while the
   * agent is actively driving the browser. Idle cadence is
   * `refreshInterval × idleMultiplier`. Range 100–30000; default 2000.
   */
  refreshInterval: z.number().min(100).max(30000).step(100).default(2000).description(
    "Watch panel refresh interval in ms (active). Default 2000.",
  ),
  /**
   * Multiplier applied to `refreshInterval` to derive the idle poll cadence
   * (when no page has been touched recently). 1 = no slowdown; 4 = idle polls
   * every 4× the active interval. Range 1–20; default 4.
   */
  idleMultiplier: z.number().min(1).max(20).step(1).default(4).description(
    "Idle cadence multiplier (idle = refreshInterval × this). Default 4.",
  ),
});

/**
 * Resolve config with fallbacks for missing / invalid values.
 * @param {Partial<ReturnType<typeof Config>>} config - raw config from cordis.yml or settings scope.
 * @returns {{ chromePath: string, refreshInterval: number, idleMultiplier: number }} a fully-populated config view.
 */
export function resolveConfig(config) {
  const chromePath =
    typeof config?.chromePath === "string" ? config.chromePath : "";
  const refreshInterval =
    typeof config?.refreshInterval === "number" &&
    Number.isFinite(config.refreshInterval) &&
    config.refreshInterval >= 100 && config.refreshInterval <= 30000
      ? config.refreshInterval
      : 2000;
  const idleMultiplier =
    typeof config?.idleMultiplier === "number" &&
    Number.isFinite(config.idleMultiplier) &&
    config.idleMultiplier >= 1 && config.idleMultiplier <= 20
      ? config.idleMultiplier
      : 4;
  return { chromePath, refreshInterval, idleMultiplier };
}
