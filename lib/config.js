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
   * Cap on live-frame fan-out (frames/sec) from the cast worker to the watch
   * panel. 0 = uncapped (full browser repaint cadence). >0 = at most N
   * frames/sec; the watched (active) tab is never throttled, only background
   * repainting tabs. Lower this to save bandwidth/CPU on dynamic pages.
   * Range 0–60; default 0.
   */
  castFpsCap: z.number().min(0).max(60).step(1).default(0).description(
    "Max frames/sec to push (0 = uncapped, active tab never throttled). Default 0.",
  ),
  /**
   * JPEG quality (1–100) for screencast frames and screenshot backstop.
   * Lower = smaller payload, more compression artifacts. Range 1–100;
   * default 55.
   */
  screencastQuality: z.number().min(1).max(100).step(1).default(55).description(
    "JPEG quality for screencast frames (1-100). Default 55.",
  ),
  /**
   * Max width (CSS px) of each pushed screencast frame. The browser scales
   * down to fit. Lower = smaller payload, less detail. Range 320–1920;
   * default 960.
   */
  screencastMaxWidth: z.number().min(320).max(1920).step(40).default(960).description(
    "Max width of screencast frames in px (320-1920). Default 960.",
  ),
});

/**
 * Resolve config with fallbacks for missing / invalid values.
 * @param {Partial<ReturnType<typeof Config>>} config - raw config from cordis.yml or settings scope.
 * @returns {{ chromePath: string, castFpsCap: number, screencastQuality: number, screencastMaxWidth: number }} a fully-populated config view.
 */
export function resolveConfig(config) {
  const chromePath =
    typeof config?.chromePath === "string" ? config.chromePath : "";
  const castFpsCap =
    typeof config?.castFpsCap === "number" &&
    Number.isFinite(config.castFpsCap) &&
    config.castFpsCap >= 0 && config.castFpsCap <= 60
      ? config.castFpsCap
      : 0;
  const screencastQuality =
    typeof config?.screencastQuality === "number" &&
    Number.isFinite(config.screencastQuality) &&
    config.screencastQuality >= 1 && config.screencastQuality <= 100
      ? config.screencastQuality
      : 55;
  const screencastMaxWidth =
    typeof config?.screencastMaxWidth === "number" &&
    Number.isFinite(config.screencastMaxWidth) &&
    config.screencastMaxWidth >= 320 && config.screencastMaxWidth <= 1920
      ? config.screencastMaxWidth
      : 960;
  return { chromePath, castFpsCap, screencastQuality, screencastMaxWidth };
}
