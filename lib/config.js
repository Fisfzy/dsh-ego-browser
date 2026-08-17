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
});

/**
 * Resolve config with fallbacks for missing / invalid values.
 * @param {Partial<ReturnType<typeof Config>>} config - raw config from cordis.yml or settings scope.
 * @returns {{ chromePath: string }} a fully-populated config view.
 */
export function resolveConfig(config) {
  const chromePath =
    typeof config?.chromePath === "string" ? config.chromePath : "";
  return { chromePath };
}
