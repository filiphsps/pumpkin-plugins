# Static Hermes runtime

Static Hermes is the default runtime for Pumpkin plugin components. The build compiles bundled
JavaScript to Hermes bytecode with `hermesc`, embeds that bytecode, and links it with Hermes, the JSI
shim and generated Pumpkin/WASI bindings.

## Prepare the toolchain

Requirements: Git, CMake, Ninja, and Rust/Cargo if the configured `wit-bindgen` version is not
already installed.
The first Hermes build discovers the host archive and its published checksum from the configured
WASI SDK GitHub release, installs `wit-bindgen` when needed, and prepares the toolchain in
`.cache/hermes/`. The SDK repository and version are configured in `wasi-sdk.json`; Rust and
`wit-bindgen` versions are in `toolchain-versions.json`. The WASI SDK release pin follows the
[upstream release pin schema](../../schemas/upstream-release-pin.schema.json), and the Hermes source
pin follows the [upstream Git pin schema](../../schemas/upstream-git-pin.schema.json). Tool versions
follow the [toolchain versions schema](../../schemas/toolchain-versions.schema.json). These schemas
describe reusable config formats rather than package-specific files. The package includes the WASI 2
CMake toolchain adjustment Hermes needs.

```sh
pnpm --filter @pumpkin-plugins/static-hermes-runtime prepare-hermes
```

Preparation checks out the exact upstream commit in `hermes-source.json`, refreshes the managed
checkout when that pin changes, and applies the ordered patches in `hermes-patches/`. It then builds
host `hermesc` and both full and lean WASI 2 Hermes/JSI static libraries under `.cache/hermes/`. It
reuses that build while the pinned source, patches, toolchain, and build settings match; changes
invalidate the cache and trigger a rebuild. Concurrent plugin builds install the SDK into separate
temporary directories and publish the first valid cache entry without replacing it. Hermes preparation
uses one shared lock. The tool rejects local source changes outside the managed patch set. Plugin builds
prepare Hermes automatically
when `engine` is omitted (the default) or set to `"static-hermes"`; run this command to prewarm the
toolchain. Optional toolchain paths and build settings are listed under [Build flags](#build-flags).

## Static Hermes configuration

Static Hermes is the default engine. Omit `engine` to use it; set `"engine": "quickjs"` in
`package.json` to select the supported QuickJS engine. Current plugin packages use the default:

```json
"pumpkinPlugin": {
  "entry": "src/plugin.ts",
  "output": "build/plugin.wasm",
  "wasi": []
}
```

The lean archive is the default. It removes runtime source compilation, including `eval` and the
`Function` constructor. Set `"staticHermesRuntime": "full"` to retain those features; the full
archive remains available even when the lean archive is the default. Both profiles execute
precompiled Hermes bytecode. Builds use Static Hermes for development, integration and release when
it is the configured engine.

Then run the package build normally. It prepares the Hermes toolchain automatically when needed:

```sh
pnpm --filter <plugin-package-name> build
```

Production builds minify the JavaScript bundle, emit Hermes bytecode with stripped function names,
compile native WASI code with `-Oz`, and use section-level dead-code elimination and linker stripping.
Every production component must be at most 5 MiB (5,242,880 bytes). Development builds keep
JavaScript source locations and native line tables for backtraces; native code is size optimized,
and the JavaScript bundle stays non-minified.

## Build flags

The build separates Hermes configuration, JavaScript-to-C compilation, WASI C/C++ compilation, and
component linking.

### Toolchain paths

| Setting | Effect |
| --- | --- |
| `STATIC_HERMES_WASI_SDK_PATH` | Optional WASI SDK path override. Otherwise setup reuses `WASI_SDK_PATH` or `WASI_SDK`, or discovers the matching archive and SHA-256 digest from the release configured in `wasi-sdk.json` and caches it under `.cache/hermes/toolchain/`. |
| `STATIC_HERMES_CACHE_DIR` | Cache root; defaults to `.cache/hermes/` at the workspace root. |
| `STATIC_HERMES_SOURCE_DIR` | Hermes checkout; defaults to `source/` under the cache root. |
| `STATIC_HERMES_HOST_BUILD_DIR` | Host build directory; defaults to `build-host/` under the cache root. |
| `STATIC_HERMES_WASI_BUILD_DIR` | WASI build directory; defaults to `build-wasip2/` under the cache root. |
| `WIT_BINDGEN` | Optional `wit-bindgen` path override. Setup reuses the configured version from `.cache/hermes/toolchain/` or `~/.cargo/bin/wit-bindgen`, then installs it if needed. |

### Hermes configuration

| Setting | Effect |
| --- | --- |
| `HERMES_ENABLE_TOOLS=ON` on the host build | Builds `shermes`; the host executable is not included in plugins. |
| Host C/C++ Release flags `-Os -DNDEBUG` | Reduces local compiler-tool size and removes assertions; it does not change plugin components. |
| `-Wno-unused-template` in host Release and WASI MinSizeRel C++ flags | Suppresses unused function template warnings from upstream Hermes sources; it does not affect compiled output. |
| `HERMES_ENABLE_TOOLS=OFF` on the WASI build | Excludes build tools from the runtime. |
| `HERMES_ENABLE_NAPI=OFF` | Excludes the Node API. |
| `HERMES_ENABLE_TEST_SUITE=OFF` | Skips test targets in the runtime build. |
| `HERMES_ENABLE_DEBUGGER=OFF` | Excludes debugger support. |
| `HERMES_ENABLE_INTL=OFF` | Excludes Intl APIs and their locale data. |
| `HERMES_BUILD_SHARED_JSI=OFF` | Keeps JSI in the static link. |
| `HERMESVM_ALLOW_JIT=0` | Disables the JIT, which is not used by WASI components. |
| `HERMES_UNICODE_LITE=ON` | Uses Hermes's reduced Unicode implementation. |
| `HERMES_ENABLE_CORE_EXTENSIONS=OFF`, `HERMES_ENABLE_CONTRIB_EXTENSIONS=OFF` | Omits optional JSI extensions. Enabling both added 44,254 bytes (1.21%) in the measured full component. `STATIC_HERMES_ENABLE_JSI_EXTENSIONS=1` enables both. |
| `HERMES_ENABLE_UNICODE_REGEXP_PROPERTY_ESCAPES=ON` | Keeps `\p{...}` and `\P{...}` regexp support. `STATIC_HERMES_ENABLE_UNICODE_REGEXP_PROPERTY_ESCAPES=0` removes it; the earlier measurement saved 161,944 bytes (4.43%). |
| `HERMES_CHECK_NATIVE_STACK=ON` | Converts native recursion overflow into a catchable JavaScript `RangeError`; the comparison checks this for full and lean builds. |
| `HERMES_ALLOW_BOOST_CONTEXT=0` | Avoids Boost.Context, which is unavailable on this WASI target. |
| `HERMESVM_GCKIND=MALLOC` | Selects malloc-managed GC for WASI; this is not a size optimization and uses more memory. |

### JavaScript-to-C compiler

Production runs `hermesc -color -O4 -fstrip-function-names -g0 -emit-binary`:

| Flag | Effect |
| --- | --- |
| `-color` | Prints colored compiler diagnostics in build logs. The build always passes this flag, including development builds. |
| `-Og` | Applies Hermes optimizations intended to remain suitable for debugging; used in development. |
| `-O4` | Optimizes Hermes bytecode. |
| `-fstrip-function-names` | Removes function names from the generated string table. |
| `-g0` | Omits compiler debug information. |
| `-g1` | Keeps Hermes source locations for JavaScript backtraces without per-instruction debug data. |
| `-emit-binary` | Emits Hermes bytecode embedded in the component. |

Development uses `hermesc -Og -g1 -emit-binary`: the bundle stays non-minified, function names remain,
and Hermes keeps source locations for JavaScript backtraces. Native C/C++ compilation uses
`-Oz -gline-tables-only -DNDEBUG -ffunction-sections -fdata-sections`; this keeps native line tables
and function names while minimizing code and allowing unused sections to be removed. Development
components retain those line tables; the linker does not use `--strip-debug` or `--strip-all`.

### WASI C/C++ compilation and linking

| Flag | Effect |
| --- | --- |
| `-Oz` | Optimizes native WebAssembly for minimum size. |
| `-gline-tables-only` | Keeps native source-line mappings for backtraces without full variable/type debug data. |
| `-DNDEBUG` | Removes C/C++ assertions. |
| `-ffunction-sections -fdata-sections` | Separates code and data so unused sections can be removed. |
| `-DSTATIC_HERMES` | Selects the Static Hermes implementation in the native JSI shim. |
| `-mllvm -wasm-enable-sjlj` with `-lsetjmp` | Provides the setjmp/longjmp lowering Hermes uses for JavaScript exceptions. |
| `-D_WASI_EMULATED_MMAN`, `-D_WASI_EMULATED_PROCESS_CLOCKS` | Enables wasi-libc emulation for the POSIX calls Hermes needs. |
| `-lwasi-emulated-mman`, `-lwasi-emulated-process-clocks` | Links those wasi-libc emulation implementations. |
| `-fwasm-exceptions` | Keeps C++ exceptions for error handling in the JSI shim. |
| `-w` | Suppresses compiler diagnostics from the generated WIT C glue; used only when compiling `plugin.c`. |
| `-mexec-model=reactor` | Builds a reactor module whose plugin lifecycle is controlled by the component host. |
| `-Wl,--gc-sections` | Removes unreferenced sections from the final component. |
| `-Wl,--strip-all` | Removes symbol and debug tables from production components. |
| `-Wl,--stack-first` | Places the stack before static data so stack overflow is trapped. |
| `-Wl,-z,stack-size=262144` | Reserves the default 256 KiB WASI stack; `STATIC_HERMES_STACK_SIZE` changes it (a multiple of 16 bytes, at least 131072). |
| `-lc++abi -lunwind` | Links C++ ABI and unwinding support used by the JSI shim. |

## Compare runtime size and speed

With the Hermes toolchain prepared, run the shared-engine comparison against a real Pumpkin server:

```sh
pnpm --filter @pumpkin-plugins/static-hermes-runtime compare-engines
```

The test builds one plugin for each engine and compares matching workloads for command tokenization,
alias and route-map lookup, permission inheritance, player and home lookup, lifecycle caches, chat
formatting, scoreboards, region protection, block-edit planning, economy transfers, inventory
stacking, cooldowns, scheduled tasks, audit history, player-state JSON, packet encoding, configuration
validation, numeric arithmetic, object allocation and traversal, and string handling. The `strings`
row retains the combined 25,000-part construction and join workload. `string-construction` measures
building those parts, while `string-join` joins the same prebuilt dense array. The combined
`command-routing` row remains available alongside separate tokenization and alias/route-map lookup
workloads.

The report labels these guest rows **synthetic guest fixture**. They are deterministic representative
algorithms implemented by the benchmark, not runs of the named Minecraft plugins or Pumpkin's host
command router. The `command-routing` fixture times guest-side tokenization, alias resolution and a
private route map. The test separately registers and dispatches one real command through Pumpkin; that
single `server.command()` dispatch is API behavior coverage, not a timed routing sample. The
**real Pumpkin API** workload times 10,000 `server.getAllPlayers()` calls per sample. Player-oriented
guest workloads use deterministic fixtures because the comparison server has no connected players.

Each workload has one warm-up and five measured samples. The report includes input counts, component
sizes, medians and each engine's minimum-to-maximum sample range. Timings are informational and have
no pass thresholds. In GitHub Actions, the report is added to the job summary.

## API and platform coverage

Each build generates the component ABI and ignored `generated/api-enums.generated.h` from the WIT
directory prepared by `@pumpkin-plugins/build`, which owns the pinned API and WASI definitions. The
generator runs on every build and owns that file. It emits event payload converters only for event
variants and fields used by the bundled plugin. The current native JSI shim implements part of the
Pumpkin API, including plugin lifecycle and metadata, command and task dispatch, event registration
and dispatch, selected server/player/world methods, logging, scheduling, and Java custom payloads.
Calls outside that subset are not yet supported.
The generated Pumpkin API facades reject host calls while `on_unload` runs, except
`scheduler.cancel-task`, which plugins need to stop scheduled callbacks. Consumers should cancel
their tasks and perform local cleanup there; other host calls remain unavailable. This runtime guard
is a fallback against re-entering the WASM store during shutdown.

Static Hermes reads the prepared WIT directory passed by `@pumpkin-plugins/build`; that package owns
the WASI version and WIT files. It validates every operation in imported WASI interfaces, including
currently unused operations, and emits adapters only for operations used by the plugin. The current
imported WASI 0.2.3 surface covers filesystem, HTTP, streams, clocks, TCP, UDP and sockets. The build
enables a feature-gated WIT operation when the plugin uses it. It also generates event converters for
WIT variants and fields used by the bundled plugin. The native JSI shim implements only part of the
Pumpkin API. Development builds still bypass the shared automatic Market update check. WASI 3 support
is deferred.

<!-- docs:begin reference -->
<!-- Generated by pumpkin-plugins-docs from package, action, and component docs metadata. Run `pnpm readme`. -->

See the [API reference](https://filiphsps.github.io/pumpkin-plugins/api/tools/@pumpkin-plugins/static-hermes-runtime/) on the documentation site.
<!-- docs:end reference -->
