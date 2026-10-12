# Static Hermes Runtime

This package supplies the Static Hermes backend for Pumpkin plugin components. It compiles bundled
JavaScript to Hermes bytecode with `hermesc`, then links the bytecode, Hermes, the JSI shim, and
generated Pumpkin/WASI bindings into a WebAssembly component. Static Hermes is the default engine;
QuickJS remains available as an alternative.

Start with the [runtime documentation](docs/index.md). It links to the
[benchmarking guide](../../docs/benchmarking.md); this README covers toolchain setup, build profiles,
compiler and linker flags, and API coverage.

## Prepare the toolchain

Requirements: Git, CMake, and Ninja. Rust/Cargo is needed only if the configured `wit-bindgen`
version is not already installed.

```sh
pnpm --filter @pumpkin-plugins/static-hermes-runtime prepare-hermes
```

Preparation uses the SDK release configured in `wasi-sdk.json`, verifies its published checksum,
installs the configured `wit-bindgen` version if needed, and caches the toolchain under
`.cache/hermes/` by default. It checks out the source commit in `hermes-source.json`, applies the ordered
patches in `hermes-patches/`, then builds host `hermesc` and the full and lean WASI 2 Hermes/JSI
libraries.

The cache is reused while its source pin, patches, toolchain, and build settings match. A changed
input triggers a rebuild. Preparation refreshes the managed checkout when the source pin changes and
rejects local Hermes source changes outside the managed patch set. Concurrent builds share a
preparation lock.

Plugin builds prepare Hermes automatically when `engine` is omitted or set to `"static-hermes"`.
Run the command above to prewarm the toolchain or prepare it explicitly before a build. Toolchain
versions are pinned in `toolchain-versions.json`; the files follow the
[upstream release pin schema](../../schemas/upstream-release-pin.schema.json),
[upstream Git pin schema](../../schemas/upstream-git-pin.schema.json), and
[toolchain versions schema](../../schemas/toolchain-versions.schema.json). The package also carries
the WASI 2 CMake toolchain adjustment required by Hermes. Optional paths and build settings are
listed under [Build flags](#build-flags).

## CLI and package API

The package CLI is compiled from `src/cli.ts` to `dist/cli.js` and registered as
`static-hermes-runtime`. Run it from this monorepo with:

```sh
pnpm --filter @pumpkin-plugins/static-hermes-runtime build
pnpm --filter @pumpkin-plugins/static-hermes-runtime exec static-hermes-runtime --help
```

Package consumers can import `buildStaticHermesComponent`, `prepareHermes`, and the other public
runtime functions directly from `@pumpkin-plugins/static-hermes-runtime`. Use the CLI for WIT
analysis and code generation.

## Engine and runtime profiles

Omitting `engine` selects Static Hermes. Set `"engine": "quickjs"` in the package's
`pumpkinPlugin` configuration to select QuickJS.

```json
"pumpkinPlugin": {
  "entry": "src/plugin.ts",
  "output": "build/plugin.wasm",
  "wasi": [],
  "staticHermesRuntime": "full"
}
```

Static Hermes defaults to the lean profile. Both profiles execute precompiled Hermes bytecode; full
also retains runtime source compilation, including `eval` and the `Function` constructor. Set
`staticHermesRuntime` to `"full"` to use it. This setting requires the Static Hermes engine and
cannot be combined with QuickJS.

Build the plugin with:

```sh
pnpm --filter <plugin-package-name> build
```

Static Hermes builds prepare the toolchain automatically when required.

## Production and development builds

Production builds minify the JavaScript bundle, compile it to optimized Hermes bytecode with
function names and debug information stripped, and compile the native WASI code with `-Oz`.
Function/data sections allow unused code to be removed at link time. The linker strips symbols from
the production component. Each production component must be no larger than 5 MiB (5,242,880 bytes).

Development builds keep the JavaScript bundle readable and retain Hermes source locations and native
line tables for backtraces. Native code remains size optimized. The specific compiler and linker
flags are listed below.

## Build flags

These settings cover the build tools and paths, Hermes library configuration, Hermes bytecode
compilation, and WASI C/C++ compilation and linking.

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
| `HERMES_ENABLE_CORE_EXTENSIONS=OFF`, `HERMES_ENABLE_CONTRIB_EXTENSIONS=OFF` | Omits optional JSI extensions. `STATIC_HERMES_ENABLE_JSI_EXTENSIONS=1` enables both and changes component size; measure the production component after changing it. |
| `HERMES_ENABLE_UNICODE_REGEXP_PROPERTY_ESCAPES=ON` | Keeps `\p{...}` and `\P{...}` regexp support. `STATIC_HERMES_ENABLE_UNICODE_REGEXP_PROPERTY_ESCAPES=0` removes that support and can reduce component size. |
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

See [Benchmarking](../../docs/benchmarking.md) for the comparison command, workload coverage, and report interpretation.

## API and platform coverage

### Pumpkin API

`@pumpkin-plugins/build` supplies the pinned WIT directory and owns the Pumpkin API version and WASI
definitions. Each build generates the component ABI and the ignored
`generated/api-enums.generated.h`. It also generates event payload converters only for the WIT
variants and fields used by the bundled plugin.

The native JSI shim implements part of the Pumpkin API: plugin lifecycle and metadata, command and
task dispatch, event registration and dispatch, selected server/player/world methods, logging,
scheduling, and Java custom payloads. Calls outside that supported subset are not available through
Static Hermes.

The generated Pumpkin API facades reject host calls during `on_unload`, except
`scheduler.cancel-task`, which plugins need to stop scheduled callbacks. Cancel scheduled tasks and
perform local cleanup during unload; other host calls remain unavailable. This guard prevents calls
from re-entering the WASM store during shutdown.

### WASI

Static Hermes reads the WIT directory prepared by `@pumpkin-plugins/build`. It validates every
operation in an imported WASI interface, including operations the plugin does not use, and emits
native adapters only for operations used by the bundle. The current imported WASI 0.2.3 surface
covers filesystem, HTTP, streams, clocks, TCP, UDP, and sockets. The build enables a feature-gated WIT
operation when the bundle uses it.

Static Hermes development builds bypass the shared automatic Market update check. WASI 3 support is
deferred.

<!-- docs:begin reference -->
<!-- Generated by pumpkin-plugins-docs from package, action, and component docs metadata. Run `pnpm readme`. -->

See the [tool guide](https://filiphsps.github.io/pumpkin-plugins/tools/static-hermes-runtime/docs/) and [API reference](https://filiphsps.github.io/pumpkin-plugins/api/tools/@pumpkin-plugins/static-hermes-runtime/) on the documentation site.
<!-- docs:end reference -->
