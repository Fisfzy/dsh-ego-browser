// lib/settings.js — host-side bridge between the `ego-browser` settings
// namespace and the plugin's other halves (tool registration + RPC gateway).
//
// The composition `Config` (cordis.patch.yml) is the first-boot seed; once the
// `ctx.settings` service mounts, the user-editable layer takes over and live
// re-registration follows every committed change. Headless assemblies without
// a settings provider fall back to the composition config (no persistence, no
// live reload).
//
// The bridge pattern mirrors `dsh-advisor/src/settings.ts` and
// `dsh-plugin-interpreters/src/settings.ts`: a `source()` thunk the gateway
// reads in-process, plus an `onChange()` subscription the host entry uses to
// react to live changes. This avoids any wire-layer allowlist (the DSH
// settings RPC domain only serves a fixed namespace set to browser
// configuration clients; the gateway bypasses it through a self-hosted HTTP
// route).
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { Config } from "./config.js";

/** Settings namespace under which ego-browser config persists. */
export const SETTINGS_NAMESPACE = settingsNamespace("ego-browser");

/**
 * Mirror of the dsh-settings internal `isUnloading` guard. The cordis const
 * enum for fiber state is erased at compile time, so the literal states are
 * matched numerically: 4 = DISPOSED, 5 = UNLOADING.
 */
function isUnloading(ctx) {
  const state = ctx?.fiber?.state;
  return state === 4 || state === 5;
}

/**
 * Install the `ego-browser` settings namespace and return the bridge.
 *
 * The settings service is reached through `ctx.inject(['settings'], ...)` so a
 * composition without a settings provider still loads the plugin (entry-source
 * fallback, no persistence). Multi-fiber dedupe is handled by catching the
 * `"already registered"` rejection — host composition may mount several
 * concurrent fibers of this plugin, and only the first registration owns the
 * namespace.
 * @param {import("@deepseek-ai/cordis").Context} ctx - host context.
 * @param {{ chromePath: string }} entry - composition-layer config (cordis.patch.yml seed).
 * @returns {{ source: () => { chromePath: string }, onChange: (cb: () => void) => void }}
 */
export function installEgoBrowserSettings(ctx, entry) {
  const listeners = new Set();
  let source = () => entry;
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  ctx.inject(["settings"], (sctx) => {
    let scope;
    try {
      scope = sctx.settings.register(SETTINGS_NAMESPACE, Config, {
        base: entry,
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("already registered")
      )
        throw error;
      ctx.logger("ego-browser")?.debug(
        "settings namespace already registered — entry-source fallback",
      );
      return;
    }
    source = () => scope.get();
    sctx.effect(() => () => {
      if (isUnloading(ctx)) return;
      source = () => entry;
      notify();
    });
    notify();
    scope.watch(() => {
      if (isUnloading(ctx)) return;
      notify();
    });
  });
  return {
    source: () => source(),
    onChange: (cb) => {
      listeners.add(cb);
    },
  };
}
