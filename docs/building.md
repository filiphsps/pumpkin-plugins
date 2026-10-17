---
navigation:
    category: Plugin development
title: "Building"
description: "The shared build tool, Turborepo setup, and runtime caveats"
---

# Building

This guide shows you how to build a plugin, run the workspace's plugins on a local Pumpkin server,
and understand the runtime limits that affect your build. The final sections explain how the shared
Turborepo tasks fit together and what to check when you change `turbo.json`.

## Build a plugin

From the workspace root, run `pnpm build` to build every plugin package. To build one package, pass
its workspace name as a filter. For example, to build AppleSkinPumpkin:

```sh
pnpm build --filter @pumpkin-plugins/apple-skin-pumpkin
```

Both commands use `pumpkin-plugins-build` from `tools/build`. To build a `.wasm` component, set the
plugin's entry file and output path in the `pumpkinPlugin` field of its `package.json`. You can also
list WASI capabilities and choose an engine there:

```json
"pumpkinPlugin": { "entry": "src/plugin.ts", "output": "build/my-plugin.wasm", "wasi": [] }
```

The engine defaults to `static-hermes`, which current plugin packages use. Set `"engine": "quickjs"`
to choose QuickJS. Both engines are supported, but they have different runtime limits; see [Runtime
caveats](#runtime-caveats) before choosing one. The [Static Hermes Runtime guide](../tools/static-hermes-runtime/README.md)
covers its toolchain and supported API calls. Development, integration, and release builds all use
the engine you select.

The build tool resolves the plugin's declared `@pumpkin-plugins/pumpkin-api` dependency (including an
npm alias) and reads the WIT files from the subdirectory pinned in `wit.lock.json`. That lock must
match the Pumpkin server's WIT ABI. On first use, or whenever the lockfile changes, Git fetches the
pinned commit into `.cache/pumpkin-api-wit/<lock-digest>/`; a populated cache entry can be reused
without network access. Set `PUMPKIN_PLUGINS_CACHE_DIR` to put this cache elsewhere.

The tool also resolves esbuild and the selected engine. Static Hermes uses generated WASI C bindings
and a component linker; the build provisions the pinned WASI SDK and `wit-bindgen` under
`.cache/hermes/` when needed, then prepares Hermes automatically. QuickJS uses the Wasmtime 48 CLI
fork of `componentize-qjs`. The fork is needed because the upstream Wasmtime 47 CLI can't link the
WASI HTTP types used by plugins. The pinned release's own build script uses a componentizer that
produces 55 MB plugins and can't run the WASI socket code.

Production builds are minified. When you build a plugin inside this repository, a component larger
than 5 MiB (5,242,880 bytes) fails before the build replaces the existing `.wasm` output. If you use
the published build package outside this repository, it warns above the same limit but still writes
the component. Development bundles stay readable and skip the size check. Static Hermes development
components optimize native code for size while retaining Hermes source locations and native line
tables for backtraces.

### Choose build outputs and options

Use these options when you need declarations for your editor, or when you want to try Static Hermes's
TypeScript parser:

| Command | Result |
| --- | --- |
| `pumpkin-plugins-build` | Writes the component to its configured output path. If the plugin declares WASI capabilities, it also writes the latest combined WIT snapshot to `build/wit/`. |
| `pumpkin-plugins-build --types-only` | Writes guest declarations to `build/types/bindings/` for `tsc` and your editor. |
| `pumpkin-plugins-build --parse-ts` | Opts Static Hermes into its partial, unstable TypeScript parser. This option isn't available with QuickJS. |

To use that parser across the repository's plugin packages, run `pnpm build:parse-ts`. For the dev
server, run `pnpm dev -- --parse-ts`; it applies the option to both the initial build and watch
builds.

Static Hermes uses Hades garbage collection by default. To use malloc-managed GC instead, set
`"staticHermesGc": "malloc"` in `pumpkinPlugin`. This setting only applies to Static Hermes.

Set `PUMPKIN_PLUGINS_VERBOSE_BUILD=1` to include Static Hermes tool output and show the selected
`--wasi-imports`, `--wasi-methods`, `--api-methods`, and `--event-types` for each component. A root
build normally hides logs for cached tasks, so pass `--force` to show the selections for every
plugin:

```sh
PUMPKIN_PLUGINS_VERBOSE_BUILD=1 pnpm build -- --force
```

If a method or event filter is omitted, the build keeps all available operations or event variants.

### Generate and use TypeScript declarations

Only declarations persist under `build/types/`, so `build` and `typecheck` can run in parallel
without writing to the same files or retaining a second WIT tree. When a plugin requests WASI imports,
its build uses a private WIT snapshot and publishes a copy to `build/wit/` for inspection. Type
generation prepares WIT in a temporary directory and removes it afterward. After a fresh checkout,
run `pnpm typecheck` once so your editor can find the generated types.

The shared `plugin-kit` package follows the same approach for its source: it writes declarations for
filesystem imports under its ignored `build/types/` directory. The API package ships
`wit.lock.json`, not a vendored WIT tree. The build command generates guest declarations from the
fetched source in `build/types/bindings/`; each plugin's `tsconfig.json` includes those declarations
before its source files, and keeps WIT `u64` and `s64` values typed as `bigint`.

If you're building from the published tools, the [Static Hermes Runtime guide](../tools/static-hermes-runtime/README.md)
lists the Node, pnpm, and host-tool versions used by packed consumer builds. Set
`STATIC_HERMES_CACHE_DIR` to move Hermes source and build artifacts out of the default workspace
cache. Run `pnpm run test:external-consumer` to pack the public tool packages and their workspace
dependencies, check their public metadata and starter dependency ranges, install them from a
temporary registry, and typecheck and build both generated standalone starters from a temporary
consumer.

## Run all plugins on Pumpkin

Run `pnpm dev` to build every plugin and start the latest stable Pumpkin release. To use Pumpkin's
latest nightly build, run `pnpm dev --nightly` or `pnpm dev:nightly`. Stable release metadata is
cached in `.cache/pumpkin` for 24 hours; set `PUMPKIN_REFRESH_RELEASE=1` to refresh it for one run.
Nightly metadata refreshes at every start because the `nightly` tag is reused, and the binary cache
uses the uploaded asset ID to detect replaced builds. Stable binaries are checked against
`checksums.sha256`; nightly binaries are checked against their GitHub release asset SHA-256 digest.

Pass `--release` to use release settings for the initial build and hot-reload rebuilds. For example,
run `pnpm dev -- --release`.

To build once and run without plugin hot reload or build watchers, run `pnpm dev:no-hot-reload`. Add
`--nightly` or use `pnpm dev:nightly:no-hot-reload` to start the latest nightly build. You can also
pass `--release`, as in `pnpm dev:no-hot-reload -- --release`. Restart the command after changing a
plugin.

The dev server lives in `.cache/pumpkin-dev`, so its world and settings remain between runs. Each
command configures Pumpkin's plugin hot reload to match the mode you chose. In hot-reload mode,
`pnpm dev` watches workspace packages, rebuilds affected plugins, and copies each completed `.wasm`
file into the server's `plugins/` directory. Pumpkin watches that directory, while build output lives
inside each package; copying the file ensures Pumpkin sees changes because a link to the build output
would not notify it when the target changes. Automatic Market update checks are disabled in the
default development builds and included in `--release` builds. Plugins that request permissions
still need those permissions granted on their initial load; a hot reload can't prompt for them.

To use a local server binary instead of downloading the latest release, set `PUMPKIN_BIN`. Set
`PUMPKIN_CACHE_DIR` to change the binary cache directory. To reset the dev server's world, config,
and plugins, stop the server and remove `.cache/pumpkin-dev`.

The build executable is `tools/build/dist/cli.js`. Turbo builds it and its Static Hermes runtime
dependency before plugin builds or typechecks. If you run package commands directly after a fresh
checkout, build both dependencies first:

```sh
pnpm --filter @pumpkin-plugins/static-hermes-runtime build
pnpm --filter @pumpkin-plugins/build build
```

An interactive build may show a notice when a newer `@pumpkin-plugins/build` release is available
on npm. The lookup is skipped for help and version commands, CI, development mode
(`PUMPKIN_DEV_MODE=1`), and non-interactive output. Registry failures don't affect the build. To
disable notices, use `--no-update-notifier` or set `PUMPKIN_PLUGINS_NO_UPDATE_NOTIFIER=1`. To preview
a suggested migration, run this from a plugin's root:

```sh
pnpm dlx @pumpkin-plugins/codemod update-build .
```

## Runtime caveats

### QuickJS runtime

QuickJS plugins run inside the server's WebAssembly runtime, which has a few limits to account for:

- There is no global `TextEncoder`, `TextDecoder`, or `fetch`. Use `fflate`'s `strToU8` and
  `strFromU8` for text encoding. If your plugin needs HTTP, import `wasi:http` by declaring the
  `http` capability; the update-check tool is one example.
- WIT `u64` and `s64` values are JavaScript `bigint` in both directions. Keep the generated
  `bigint` types, and convert to `number` only when the value is within JavaScript's safe integer
  range.
- Scheduler delays and periods are `u64` (`bigint`); handler and task IDs are `u32` (`number`). The
  plugin-kit scheduler helpers accept safe integer tick counts and pass them as `BigInt`.
- The first time a plugin requests permissions, the server prompts for them in its console. A hot
  reload can't show that prompt and denies the permissions, so restart the server for the first
  load.
- Two builds of the same source produce different bytes. If you sign or upload a build, use the
  artifact from the build job instead of rebuilding it.

### Static Hermes

Static Hermes plugins use the WASI 2 C API path in `tools/static-hermes-runtime`. Its native JSI shim
implements only part of the Pumpkin API. The runtime reads the prepared WIT directory from
`@pumpkin-plugins/build`, which owns the WASI version and WIT files. It validates every operation in
an imported WASI interface, including operations your plugin doesn't use, and generates native
adapters for operations selected by build analysis. The imported WASI 0.2.3 operations cover
filesystem, HTTP, streams, clocks, TCP, UDP, and sockets. Selecting a feature-gated operation also
enables its WIT feature. Event converters keep complete payload fields for statically registered
event types; dynamic or unresolved registrations retain every event case and payload field. Static
Hermes development builds disable the shared automatic update check. WASI 3 support is deferred.

## Turborepo

Turborepo defines the workspace task graph in `turbo.json`; the root scripts run those tasks. The
main commands are `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm readme`,
and `pnpm package`. The [Turborepo commands guide](turborepo.md) explains the `pnpm turbo` wrapper,
its log defaults, and how to override them.

These are the tasks and outputs Turbo caches:

| Task | What it does or caches |
| --- | --- |
| `transit` | Does no work itself; carries the hashes of a package's dependencies so their changes invalidate dependent tasks. |
| `build` | Caches `build/**` except `build/types/**`, plus package `dist/**` output. |
| `benchmark:build` | Caches the engine-comparison components and stack-guard fixtures, with a separate output path for each configuration. |
| `typecheck` | Caches generated `build/types/**` declarations and restores them on a cache hit. |
| `test` | Caches `dist/**` for the `static-hermes-runtime` package's test build. |
| `test:integration` | Depends on `build` and is never cached because it starts a real server. |
| `readme`, `readme:check` | Never cached because they write or inspect files. |

The build tool, signing tool, plugin creator, and test harness `typecheck` tasks run `tsc --noEmit`,
so their package-level Turbo configurations declare no outputs. Plugin typechecks keep the root
`build/types/**` outputs because they generate the guest declarations that builds and editors need.

The `@pumpkin-plugins/build` build and test tasks also build `@pumpkin-plugins/static-hermes-runtime`
and `@pumpkin-plugins/wasi-capabilities` first. The build tool imports their compiled package
entries, so both public tools declare their `dist/**` output for Turbo to restore when those builds
come from cache.

Run `pnpm clean` to remove workspace `node_modules`, root and workspace `build/` and `dist/` output,
and `.turbo/cache/`. It preserves `.cache/`.

When you run `pnpm build`, Turbo checks the selected task graph and prepares Static Hermes once
before plugin builds start. A QuickJS-only filter skips that setup. Direct package builds still
prepare Hermes when needed.

### When you change `turbo.json`

#### Keep cache keys tied to dependencies

Most workspace packages are used as source because their `exports` point at `src/`; nothing is built
before a dependent task runs, so Turborepo has no reason to look at a dependency's files. The public
`@pumpkin-plugins/wasi-capabilities` package is compiled to `dist/` so Node can load it from
`node_modules`, and its build runs before dependent package tasks.

The `transit` task is Turborepo's "transit nodes" pattern. It has no script and depends on
`^transit`. The `build`, `typecheck`, and `test` tasks depend on it, so changes in a package's
dependencies invalidate exactly the affected tasks. This includes `devDependencies` such as
`tools/build`, whose `wasi-wit.lock.json` and `src/` determine what a plugin is built from. You don't
need to add new tools to a central list as long as a plugin declares them in its `package.json`.

Use `globalDependencies` only for inputs outside packages: `.node-version` (the Node version CI
selects; Turborepo doesn't hash `process.version`), `tsconfig.base.json`, and `pnpm-workspace.yaml`
(which pins the API package and ABI). The lockfile and root `package.json` invalidate everything.
The packages that the root `package.json` depends on (`tools/docs` and `tools/signing`) also
invalidate everything because Turborepo treats them as global.

#### Pass task environment variables explicitly

Turborepo uses strict environment mode, so tasks only receive variables you declare. The
`PUMPKIN_*` variables read by the test harness and build download cache are in
`globalPassThroughEnv`. They don't affect cache keys because they only choose locations or affect
uncached tasks. `TMPDIR` isn't passed through, so tests run by Turbo create temporary directories
under `/tmp`.

Static Hermes toolchain paths pass through to the uncached `test:integration` task. Integration
fixtures can build plugins, so they should reuse the toolchain already prepared in CI.

#### Declare task dependencies carefully

The root package defines a `build` script (`"build": "node scripts/build.mjs"`), so adding
`dependsOn: ["^build"]` would make the root package a dependency of itself and fail or loop. The
`transit` task can use `^transit` because the root package doesn't have a `transit` script. Don't add
a root script with that name. See Turborepo's "Missing root task in turbo.json" documentation.

#### Keep simple checks outside Turborepo

`pnpm lint` runs Biome and ESLint directly. Both are fast, so caching them wouldn't save much.

#### Preserve repository settings

Keep `"agentGuidance": false`. Otherwise, Turborepo writes an `AGENTS.md` when it detects an AI
agent and adds it again if deleted.

The package manager version is declared with `devEngines.packageManager` in the root
`package.json`; Turborepo, pnpm, and `pnpm/action-setup` all read it.

Remote caching isn't configured. CI caches `.turbo` with `actions/cache`. To use a remote cache, set
`TURBO_TOKEN` and `TURBO_TEAM`.

For details about the exact installed Turborepo version, read the `docs/` directory inside the
`turbo` package. From the repository root, locate that package with:

```sh
node -p "require('path').dirname(require.resolve('turbo/package.json'))"
```
