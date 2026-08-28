/**
 * ego-browser build: three artifacts.
 *   1. host  — src/index.ts bundled to lib/index.js (Node ESM). Peers
 *      (dsh-tools / dsh-settings / cordis / client-*) are external; the
 *      Schemastery Config schema is bundled in (self-contained, like the
 *      yet-another-subagent host half).
 *   2. client — src/client/index.ts to lib/client.js wrapped in the DSH
 *      ModuleLoader factory (browser CJS). React + dsh-client-* external.
 *   3. worker — src/worker/ego-cast-worker.ts bundled to
 *      bin/ego-cast-worker.mjs (Node ESM, self-contained: only node: builtins).
 *      cast-server spawns this single file by path (../bin/ego-cast-worker.mjs).
 *
 * [0.1.2 client contract] the browser bundle MUST register the DECLARED
 * package name `dsh-ego-browser` — the boot manifest rows are keyed by the
 * package.json `name`, and the loader row specifier must equal it too
 * (nearestPackage name check). The previous `@dsh-external/ego-browser` alias
 * (junction install key) does NOT match the manifest name, so the 0.1.2
 * client scan permanently classifies the entry as "not a client row" and the
 * watch panel silently disappears. Load the package under its real name.
 */
import { defineConfig, type UserConfig } from 'tsdown'

const ID = 'dsh-ego-browser'

/** Host-provided singletons: never bundle, keep as runtime imports. */
const HOST_EXTERNALS = [
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-tools/invariant',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/cordis',
  /^@deepseek-ai\/dsh-client-/,
  'react',
  'react-dom',
  'react/jsx-runtime',
]

/** Browser-side peers the ModuleLoader resolves from profile node_modules. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  /^@deepseek-ai\/dsh-client-/,
]

const host: UserConfig = {
  name: ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: true,
  external: HOST_EXTERNALS,
}

const client: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  external: CLIENT_EXTERNALS,
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

const worker: UserConfig = {
  name: `${ID}/worker`,
  entry: { 'ego-cast-worker': 'src/worker/ego-cast-worker.ts' },
  outDir: 'bin',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  outputOptions: {
    entryFileNames: 'ego-cast-worker.mjs',
  },
}

export default defineConfig([host, client, worker])
