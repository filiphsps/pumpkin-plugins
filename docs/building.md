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
covers its toolchain and how it generates API adapters. Development, integration, and release
builds all use the engine you select.

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

Production builds are minified. A component larger than 5 MiB (5,242,880 bytes) produces a warning,
but the build still writes it. Set `PUMPKIN_PLUGINS_FAIL_ON_SIZE_LIMIT=1` to make an oversized
component fail the build before it replaces the existing `.wasm` output; CI sets it for the
production build. Development bundles stay readable and skip the size check. Static Hermes
development components optimize native code for size while retaining Hermes source locations and
native line tables for backtraces.

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

Run `pnpm dev` to build every plugin and start the Pumpkin release pinned in
[`pumpkin-version.ts`](../tools/test-harness/src/pumpkin-version.ts), the same one the integration
tests use, so the server matches the plugins' WIT ABI. It's downloaded once into `.cache/pumpkin`
and checked against the SHA-256 pinned beside the release.

To try a newer server, run `pnpm dev --latest` for the latest stable release, or run
`pnpm dev --nightly` (or `pnpm dev:nightly`) for the latest nightly build. Plugins may fail to load
there if that server's ABI differs from the pin. Latest-release metadata is cached in
`.cache/pumpkin` for 24 hours; set `PUMPKIN_REFRESH_RELEASE=1` to refresh it for one run. Nightly
metadata refreshes at every start because the `nightly` tag is reused, and the binary cache uses the
uploaded asset ID to detect replaced builds. Stable binaries are checked against `checksums.sha256`;
nightly binaries are checked against their GitHub release asset SHA-256 digest.

Pass `--release` to use release settings for the initial build and hot-reload rebuilds. For example,
run `pnpm dev -- --release`.

To build once and run without plugin hot reload or build watchers, run `pnpm dev:no-hot-reload`. Add
`--latest` or `--nightly`, or use `pnpm dev:nightly:no-hot-reload`, to start a newer server. You can
also pass `--release`, as in `pnpm dev:no-hot-reload -- --release`. Restart the command after
changing a plugin.

The dev server lives in `.cache/pumpkin-dev`, so its world and settings remain between runs. Each
command configures Pumpkin's plugin hot reload to match the mode you chose. In hot-reload mode,
`pnpm dev` watches workspace packages, rebuilds affected plugins, and copies each completed `.wasm`
file into the server's `plugins/` directory. Pumpkin watches that directory, while build output lives
inside each package; copying the file ensures Pumpkin sees changes because a link to the build output
would not notify it when the target changes. Automatic Market update checks are disabled in the
default development builds and included in `--release` builds. Each rebuild changes the `.wasm`
file, so a hot reload denies a plugin's permissions until you restart the server or pre-allow them
in the dev server's `pumpkin.toml`; see [Runtime caveats](#runtime-caveats).

To use a local server binary instead of downloading one, set `PUMPKIN_BIN`. Set
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
on npm. Results are cached for three hours. Pass `--no-update-cache` to check npm without reading or
writing the cache. The lookup is skipped for help and version commands, CI, development mode
(`PUMPKIN_DEV_MODE=1`), and non-interactive output. Registry failures don't affect the build. To
disable notices, use `--no-update-notifier` or set `PUMPKIN_PLUGINS_NO_UPDATE_NOTIFIER=1`. To preview
a suggested migration, run this from a plugin's root:

```sh
pnpm dlx @pumpkin-plugins/codemod update-build .
```

## Runtime caveats

Pumpkin handles plugin permissions the same way for both engines. It asks the operator to approve
them on the server console unless every requested permission is listed in `allowed_permissions`
under `[plugins]` in `pumpkin.toml`, or `ask_permission_confirmation` is off. Pumpkin remembers the answer for
that exact `.wasm` file and permission list, so it asks again after either one changes. A hot reload
can't show the prompt and denies the permissions, so restart the server to answer it.

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
- Two builds of the same source produce different bytes. If you sign or upload a build, use the
  artifact from the build job instead of rebuilding it.

### Static Hermes

Static Hermes plugins use the WASI 2 C API path in `tools/static-hermes-runtime`. The build generates
a native adapter for each Pumpkin API operation the plugin uses, or for every operation when build
analysis can't tell which ones it uses. If an operation has a WIT input or result type the generator
can't convert, the build fails and names that operation, so a component that builds can call every
operation it includes.

The runtime reads the WIT directory that `@pumpkin-plugins/build` prepares from the WASI files
pinned in its `wasi-wit.lock.json`. The WASI version itself belongs to
`@pumpkin-plugins/wasi-capabilities`, and the lock has to match it. The runtime validates every
operation in an imported WASI interface, including operations your plugin doesn't use, and generates
native adapters for operations selected by build analysis. The imported WASI operations cover
filesystem, HTTP, streams, clocks, TCP, UDP, and sockets. Selecting a feature-gated operation also
enables its WIT feature. Event converters keep complete payload fields for statically registered
event types; dynamic or unresolved registrations retain every event case and payload field. WASI 3
support is deferred.

Resources and promises behave differently from QuickJS, so keep these rules in mind when you write a
plugin for Static Hermes:

- Garbage collection doesn't release Pumpkin or WASI resources, such as players, worlds, text
  components and streams. Call `drop()` on a resource you own once you're done with it, including on
  error paths.
- Resources passed into a callback belong to that callback. The load context is dropped when
  `onLoad` returns, the server, command sender and arguments when their handler returns, and an
  event's resources go back to Pumpkin with the returned event. Using one later throws `Cannot use a
  disposed or transferred resource`, so keep the values you need rather than the resource.
- Promise jobs run only before the callback that queued them returns. There's no event loop between
  callbacks, so code after an `await` that waits for a later tick, task or event never runs. Use the
  scheduler for work that has to happen later.

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
| `typecheck` | Caches the `build/types/**` declarations of packages whose typecheck generates them; other packages' typechecks produce no outputs. |
| `test` | Caches `dist/**` for the `static-hermes-runtime` package's test build. |
| `test:integration` | Depends on `build` and is never cached because it starts a real server. |
| `readme`, `readme:check` | Never cached because they write or inspect files. |

Most tool packages typecheck with plain `tsc --noEmit` and write nothing. Plugins, and tools such as
`plugin-kit` and `pumpkin-api` that generate declarations before running `tsc`, write the guest
declarations that builds and editors need, so their `build/types/**` output is cached.

The `@pumpkin-plugins/build` build and test tasks also build `@pumpkin-plugins/static-hermes-runtime`
and `@pumpkin-plugins/wasi-capabilities` first. The build tool imports their compiled package
entries, so both public tools declare their `dist/**` output for Turbo to restore when those builds
come from cache. Its typecheck builds `@pumpkin-plugins/static-hermes-runtime` first, because that
package's declarations come from `dist/`.

Run `pnpm clean` to remove workspace `node_modules`, root and workspace `build/` and `dist/` output,
and `.turbo/cache/`. It preserves `.cache/`.

When you run `pnpm build`, Turbo checks the selected task graph and prepares Static Hermes once
before plugin builds start. A QuickJS-only filter skips that setup. Direct package builds still
prepare Hermes when needed.

### When you change `turbo.json`

#### Keep cache keys tied to dependencies

Most workspace packages are used as source because their `exports` point at `src/`; nothing is built
before a dependent task runs, so Turborepo has no reason to look at a dependency's files. Tools with
a `build` script that writes `dist/`, such as `@pumpkin-plugins/build`,
`@pumpkin-plugins/static-hermes-runtime` and `@pumpkin-plugins/wasi-capabilities`, are compiled so
Node can load them from `node_modules`; the tasks that import them depend on their builds.

The `transit` task is Turborepo's "transit nodes" pattern. It has no script and depends on
`^transit`. The `build`, `typecheck`, and `test` tasks depend on it, so changes in a package's
dependencies invalidate exactly the affected tasks. This includes `devDependencies` such as
`tools/build`, whose `wasi-wit.lock.json` and `src/` determine what a plugin is built from. You don't
need to add new tools to a central list as long as a plugin declares them in its `package.json`.

Use `globalDependencies` only for inputs outside packages: `.node-version` (the Node version CI
selects; Turborepo doesn't hash `process.version`), `tsconfig.base.json`, and `pnpm-workspace.yaml`
(the shared dependency catalog). The lockfile and root `package.json` invalidate everything.
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
