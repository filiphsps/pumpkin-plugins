# Static Hermes runtime

Experimental Static Hermes backend for Pumpkin plugin components. It compiles a bundled JavaScript
plugin to C with `shermes`, then links that unit with Hermes and the generated Pumpkin WASI 2
bindings.

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
host `shermes` and both full and lean WASI 2 Hermes/JSI static libraries under `.cache/hermes/`. It
reuses that build while the pinned source, patches, toolchain, and build settings match; changes
invalidate the cache and trigger a rebuild. Concurrent plugin builds share one preparation lock. It
rejects local source changes outside the managed patch set. Plugin builds prepare Hermes automatically
when `engine` is `"static-hermes"`; run this command to prewarm the toolchain. Optional toolchain
paths and build settings are listed under [Build flags](#build-flags).

## Select Static Hermes for a plugin

Set the plugin's build configuration in `package.json`:

```json
"pumpkinPlugin": {
  "entry": "src/plugin.ts",
  "output": "build/plugin.wasm",
  "engine": "static-hermes",
  "wasi": []
}
```

The lean archive is the default. It removes runtime source compilation, including `eval` and the
`Function` constructor. Set `"staticHermesRuntime": "full"` to retain those features; the full
archive remains available even when the lean archive is the default. Both profiles run precompiled
plugin code; `shermes` still compiles the bundle during the build. The selected `engine` applies to
development, integration and release builds.

Then run the package build normally. It prepares the Hermes toolchain automatically when needed:

```sh
pnpm --filter <plugin-package-name> build
```

Production builds minify the JavaScript bundle and use Hermes `-Os`, small-C output, stripped function
names, WASI `-Oz`, section-level dead-code elimination, and linker stripping. In the current engine
comparison, the lean profile was 1,513,144 bytes (41.43%) smaller than full Hermes: 2,139,412 bytes
versus 3,652,556 bytes. Development builds keep debug information and skip those size optimizations.
The backend currently has no component-size limit.

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

Production runs `shermes -color -Os -Xsmall-c -fstrip-function-names -g0 -emit-c`:

| Flag | Effect |
| --- | --- |
| `-color` | Prints colored compiler diagnostics in build logs. The build always passes this flag, including development builds. |
| `-Os` | Optimizes generated code for size. |
| `-Xsmall-c` | Prefers smaller generated C output. |
| `-fstrip-function-names` | Removes function names from the generated string table. |
| `-g0` | Omits compiler debug information. |
| `-emit-c` | Emits C source for the generated JavaScript unit. |
| `-exported-unit=plugin_bundle` | Names the generated unit entry point that the native runtime calls. |

Development uses `-Og -g2` to keep generated code debuggable. Its native C/C++ compilation uses
`-O0 -g -DNDEBUG`: no optimization, debug symbols, and assertions disabled.

### WASI C/C++ compilation and linking

| Flag | Effect |
| --- | --- |
| `-Oz` | Optimizes native WebAssembly for minimum size. |
| `-DNDEBUG` | Removes C/C++ assertions. |
| `-ffunction-sections -fdata-sections` | Separates code and data so unused sections can be removed. |
| `-DSTATIC_HERMES` | Selects the Static Hermes implementation in the native JSI shim. |
| `-mllvm -wasm-enable-sjlj` with `-lsetjmp` | Provides the setjmp/longjmp lowering Hermes uses for JavaScript exceptions. |
| `-mllvm -wasm-use-legacy-eh=false` | Keeps WASI SDK 34 output valid for Wasmtime. Removing it made the component fail validation (`function[76]: expected null not to be null`). |
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

WASI SDK 34 reports `-wasm-use-legacy-eh=false` as an unused command-line argument. Removing it
produced a component Wasmtime could not validate (`function[76]: expected null not to be null`), so it
stays enabled. No size gain from removing the flag was measured. The warning cannot safely be fixed by
deleting it; a replacement needs to pass component validation, the runtime comparison, and stack checks.

## Compare runtime size and speed

With the Hermes toolchain prepared, run the shared-engine comparison against a real Pumpkin server:

```sh
pnpm --filter @pumpkin-plugins/static-hermes-runtime compare-engines
```

The test builds one plugin for each engine, checks matching numeric, configuration, cache, packet,
string, object, and Pumpkin API workloads, records production component sizes, and reports median
execution times. It also registers a real server-tick event, schedules a task, and calls the server's
player-list API. Each workload has one warm-up and five measured samples. Timings are informational;
the comparison reports size and speed without enforcing thresholds. In GitHub Actions, the report is
added to the job summary.

## API and platform coverage

Each build generates the component ABI and ignored `generated/api-enums.generated.h` from the
plugin's pinned `pumpkin-api-ts` WIT. The generator runs on every build and owns that file. The
current native JSI shim only implements a subset of the Pumpkin API, including plugin lifecycle and
metadata, event registration and dispatch for join/leave/tick, selected server/player/world methods,
logging, scheduling, and Java custom payloads. Calls outside that subset are not yet supported.
Expanding the shim from the API definitions remains required for full API compatibility.

WASI HTTP, filesystem, TCP, UDP, and socket APIs are not yet exposed to JavaScript. Static Hermes
builds therefore bypass the shared automatic Market update check and reject unresolved `wasi:*`
JavaScript imports at build time. The WIT imports can be declared in a plugin world, but that alone
does not create the JS-to-WIT resource and stream adapters those APIs require. WASI 3 support is deferred.

<!-- docs:begin reference -->
<!-- Generated by pumpkin-plugins-docs from package, action, and component docs metadata. Run `pnpm readme`. -->

See the [API reference](https://filiphsps.github.io/pumpkin-plugins/api/tools/@pumpkin-plugins/static-hermes-runtime/) on the documentation site.
<!-- docs:end reference -->
