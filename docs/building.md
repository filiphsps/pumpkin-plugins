---
navigation:
    category: Plugin development
---

# Building

## The build tool

`pumpkin-plugins-build` (`tools/build`) turns a plugin into a `.wasm` component. It is configured
by the `pumpkinPlugin` key in each plugin's `package.json`:

```json
"pumpkinPlugin": { "entry": "src/plugin.ts", "output": "build/my-plugin.wasm", "wasi": [] }
```

`engine` is optional and defaults to `static-hermes`. Set it to `quickjs` to build a QuickJS plugin;
both engines are supported. Current plugin packages use the Static Hermes default. See the
[Static Hermes Runtime guide](../tools/static-hermes-runtime/README.md) for toolchain setup and
supported API calls. Development, integration and release builds use the configured engine. The
build tool provisions Static Hermes's pinned WASI SDK and `wit-bindgen` under `.cache/hermes/` when
needed, then prepares Hermes automatically when Static Hermes is selected.

It resolves the plugin's declared `@pumpkin-plugins/pumpkin-api` dependency or npm alias and fetches the
WIT files from the subdirectory pinned by its `wit.lock.json` (the WIT ABI must match the Pumpkin server),
then resolves esbuild and the selected engine. On first use, and whenever the lockfile contents
change, Git fetches the pinned commit into `.cache/pumpkin-api-wit/<lock-digest>/`; existing cache
entries need no network access. Set `PUMPKIN_PLUGINS_CACHE_DIR` to move that cache. Static Hermes
uses its generated WASI C bindings and component linker. QuickJS uses the Wasmtime 48
CLI fork of `componentize-qjs`. The fork is needed because the upstream Wasmtime 47 CLI fails to link
the WASI HTTP types used by plugins. The pinned release's own build script uses a componentizer that
produces 55 MB plugins and can't run the WASI socket code.

Production bundles are minified. Components from both engines are limited to 5 MiB (5,242,880 bytes)
after componentization; an oversized build fails before replacing the existing `.wasm` output.
Development bundles stay readable and are exempt from the limit. Static Hermes dev components optimize
native code for size while keeping Hermes source locations and native line tables for backtraces.

| Command | Result |
| --- | --- |
| `pumpkin-plugins-build` | `build/<plugin>.wasm`, plus the latest combined WIT snapshot in `build/wit/` when WASI imports are added |
| `pumpkin-plugins-build --types-only` | Guest declarations in `build/types/bindings/` for `tsc` and your editor |
| `pumpkin-plugins-build --parse-ts` | Opts Static Hermes into its partial, unstable TypeScript parser; unavailable with QuickJS |

Set `PUMPKIN_PLUGINS_VERBOSE_BUILD=1` to include Static Hermes tool output and the selected
`--wasi-imports`, `--wasi-methods`, `--api-methods` and `--event-types` for each component. Root builds
normally hide cached task logs, so add `--force` to print the selections for every plugin:

```sh
PUMPKIN_PLUGINS_VERBOSE_BUILD=1 pnpm build -- --force
```

An omitted method or event filter means all available operations or event variants are retained.

Only declarations persist under `build/types/`, so `build` and `typecheck` can run in parallel
without touching the same files or keeping a second WIT tree. When a plugin requests WASI imports,
each build uses a private WIT snapshot while it runs, then publishes a copy to `build/wit/` for
inspection. Type generation prepares its WIT in a temporary directory and removes it afterward. Run
`pnpm typecheck` once after a fresh checkout so your editor finds the types.
The shared `plugin-kit` package does the same for its own source, generating declarations for its
filesystem imports in its ignored `build/types/` directory.

The API package ships `wit.lock.json`, not a vendored WIT tree. The build command generates guest
declarations from the fetched source into `build/types/bindings/`; a plugin's `tsconfig.json`
includes those declarations before its source files and preserves WIT `u64`/`s64` values as
`bigint`.

Packed consumer builds use Node `24.21.0` and pnpm `12.11.2`. The host toolchain pins are CMake
`4.4.4`, Ninja `1.13.2`, Rust/Cargo `1.99.0`, `wit-bindgen` `0.62.0`, and WASI SDK `34`; Windows
x64 uses Visual Studio 2022 MSVC toolset `14.44`. Set `STATIC_HERMES_CACHE_DIR` to move Hermes
source and build artifacts outside the default workspace cache. Run
`pnpm run test:external-consumer` to pack the public tool packages and their workspace dependencies,
verify the packed public metadata and starter dependency ranges, install them from a temporary
registry, and typecheck/build both generated standalone starters from a temporary consumer.

## Runtime caveats

### QuickJS runtime

QuickJS plugins run inside the server's WebAssembly runtime:

- There is no global `TextEncoder`, `TextDecoder` or `fetch`. `fflate` provides `strToU8` and `strFromU8`. Plugins that need HTTP can import `wasi:http` by declaring the `http` capability; the update-check tool already does this.
- WIT `u64`/`s64` values are JavaScript `bigint` in both directions. Keep generated `bigint` types;
  convert explicitly to `number` only when the value is within JavaScript's safe integer range.
- Scheduler delays and periods are `u64` (`bigint`); handler and task IDs are `u32` (`number`).
  The plugin-kit scheduler helpers accept safe integer tick counts and pass them as `BigInt`.
- Plugins that request permissions are prompted for on the server console the first time they
  load. Hot reload can't prompt and denies them, so the first load needs a restart.
- Two builds of identical source produce different bytes. Anything that signs or uploads a build
  must use the artifact from the build job, never a rebuild.

### Static Hermes

Static Hermes plugins use the WASI 2 C API path in `tools/static-hermes-runtime`. Its native JSI shim
currently implements only part of the Pumpkin API. The runtime consumes the prepared WIT directory
from `@pumpkin-plugins/build`, which owns the WASI version and WIT files. It validates every operation
in imported WASI interfaces, including operations the plugin does not currently use, and generates
native adapters for the operations selected by build analysis. The imported WASI 0.2.3 operations
cover filesystem, HTTP, streams, clocks, TCP, UDP and sockets. Feature-gated operations enable their
WIT feature when selected. Event converters keep complete payload fields for statically registered
event types; dynamic or unresolved registrations retain every event case and payload field.
Static Hermes development builds disable the shared automatic update check. WASI 3 support is
deferred.

## Turborepo

Tasks are defined in `turbo.json` and run with the root scripts (`pnpm build`, `pnpm typecheck`,
`pnpm test`, `pnpm test:integration`, `pnpm readme`, `pnpm package`):

| Task | Notes |
| --- | --- |
| `transit` | Does nothing; it carries a package's dependencies' hashes (see below) |
| `build` | Caches `build/**` except `build/types/**`, plus package `dist/**` output |
| `typecheck` | Caches the generated `build/types/**`, so a cache hit restores them |
| `test` | Caches `dist/**` for the `static-hermes-runtime` package's test build |
| `test:integration` | Depends on `build`, never cached (it starts a real server) |
| `readme`, `readme:check` | Never cached, they write or inspect files |

The `@pumpkin-plugins/build` test tasks also build `@pumpkin-plugins/static-hermes-runtime` first because
the build tool imports its compiled package entry. Both public tools declare their `dist/**` output so
Turbo restores the compiled files when those builds come from cache.

Run `pnpm clean` to remove workspace `node_modules`, root and workspace `build/` and `dist/` output,
and `.turbo/cache/`. It preserves `.cache/`.

Run one plugin with `pnpm build --filter=@pumpkin-plugins/<folder>`.
`pnpm build` checks the selected Turbo task graph and prepares Static Hermes once before plugin
builds start. QuickJS-only filters skip that setup. Direct package builds still prepare Hermes when
needed.

## Run all plugins on Pumpkin

Run `pnpm dev` to build every plugin and start the latest stable Pumpkin release. Run
`pnpm dev --nightly` or `pnpm dev:nightly` to use Pumpkin's latest nightly build instead. Stable
release metadata is cached in `.cache/pumpkin` for 24 hours; set `PUMPKIN_REFRESH_RELEASE=1` to force
a one-run refresh. Nightly metadata refreshes on every start because the `nightly` tag is reused, and
the binary cache uses the uploaded asset ID to pick up replaced builds. Stable binaries are checked
against `checksums.sha256`; nightly binaries are checked against their GitHub release asset SHA-256
digest.

Run `pnpm dev:no-hot-reload` to build once and start the same server with plugin hot reload and
build watchers disabled. Add `--nightly` or run `pnpm dev:nightly:no-hot-reload` to use the latest
nightly build. Restart the command after changing a plugin.

The dev server lives in `.cache/pumpkin-dev`, so its world and settings remain between runs. Each
command sets Pumpkin's plugin hot reload to match the selected mode. In hot-reload mode, `pnpm dev`
uses `turbo watch` to rebuild plugins as workspace packages change and copies each completed `.wasm`
into the server's `plugins/` directory. This copy is needed because Pumpkin watches that directory,
while build outputs live under each package. A file linked to a build output would not notify Pumpkin
when the target changes. Automatic Market update checks are disabled for these development builds.
Reloading plugins that request permissions still requires granting permissions on their initial load.

Set `PUMPKIN_BIN` to use a local server binary instead of downloading the latest release. Set
`PUMPKIN_CACHE_DIR` to change the binary cache directory. To reset the dev server's world, config and
plugins, stop the server and remove `.cache/pumpkin-dev`.

The compiled build executable lives at `tools/build/dist/cli.js`. Turbo builds it and its Static
Hermes runtime dependency before plugin builds or typechecks. For direct package commands after a
fresh checkout, run `pnpm --filter @pumpkin-plugins/static-hermes-runtime build` and
`pnpm --filter @pumpkin-plugins/build build` first.

The build tool and test harness `typecheck` tasks run `tsc --noEmit`, so their package-level Turbo
configurations declare no outputs. Plugin typechecks keep the root `build/types/**` outputs because
they generate guest declarations needed by builds and editors.

Things to know when changing `turbo.json`:

- **Cache invalidation.** The workspace packages are used as source (their `exports` point at
  `src/`), so nothing is built in between and Turborepo has no reason to look at a dependency's
  files. The `transit` task is the fix from the Turborepo docs ("transit nodes"): it has no script
  and depends on `^transit`, and `build`, `typecheck` and `test` depend on it, so a change in any
  package a package depends on (including `devDependencies` such as `tools/build`, whose
  `wasi-wit.lock.json` and `src/` decide what a plugin is built from) invalidates exactly its
  dependents. New tools need nothing added, as long as a plugin lists them in its `package.json`.
  `globalDependencies` is only for inputs outside any package: `tsconfig.base.json` and
  `pnpm-workspace.yaml` (the API package and ABI pin). The lockfile and the root `package.json` invalidate
  everything, and so do the packages the root `package.json` depends on (`tools/docs` and
  `tools/signing`), because Turborepo treats those as global.
- **Environment variables.** Turborepo runs tasks in strict env mode, so a variable a task reads
  has to be declared, or it never reaches the task. The `PUMPKIN_*` variables the test harness and the build's download cache read are in
  `globalPassThroughEnv`; they don't affect cache keys, which is fine because they only say where
  things are or what to run in uncached tasks. `TMPDIR` isn't passed through, so tests run under Turborepo create their
  temp directories in `/tmp`. Static Hermes toolchain paths pass through to the uncached
  `test:integration` task because integration fixtures can build plugins and should reuse the prepared
  CI toolchain.
- **`^` dependencies need a task the root doesn't have.** The root package also defines a `build`
  script (`"build": "node scripts/build.mjs"`), so `dependsOn: ["^build"]` would make the root package a
  dependency of itself and fail or loop. `transit` is not a root script, which is why it can use
  `^transit`. Don't add a root script of that name. See the Turborepo docs page "Missing root task
  in turbo.json".
- **Linting runs outside Turborepo.** `pnpm lint` calls Biome and ESLint directly. Both are fast,
  so caching them wouldn't gain anything.
- **`agentGuidance` is off.** By default Turborepo writes an `AGENTS.md` when it detects an AI
  agent and re-adds it if it is deleted. `"agentGuidance": false` is the opt-out.
- **Package manager.** Declared with `devEngines.packageManager` in the root `package.json`, which
  Turborepo, pnpm and `pnpm/action-setup` all read.
- **Remote cache** isn't configured. CI caches `.turbo` with `actions/cache`. Set `TURBO_TOKEN`
  and `TURBO_TEAM` to use a remote cache instead.

The installed Turborepo ships its own docs for the exact version: `docs/` inside the `turbo`
package (`node -p "require('path').dirname(require.resolve('turbo/package.json'))"` from the repo
root).
