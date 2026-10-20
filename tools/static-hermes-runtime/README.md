# Static Hermes Runtime

[![npm downloads](https://img.shields.io/npm/dt/%40pumpkin-plugins%2Fstatic-hermes-runtime)](https://www.npmjs.com/package/@pumpkin-plugins/static-hermes-runtime)
[![latest npm release](https://img.shields.io/npm/v/%40pumpkin-plugins%2Fstatic-hermes-runtime?label=latest%20release)](https://www.npmjs.com/package/@pumpkin-plugins/static-hermes-runtime)
[![npm license](https://img.shields.io/npm/l/%40pumpkin-plugins%2Fstatic-hermes-runtime)](https://www.npmjs.com/package/@pumpkin-plugins/static-hermes-runtime)

This package supplies the Static Hermes backend for Pumpkin plugin components. It compiles bundled
JavaScript to Hermes bytecode by default. Pass `--parse-ts` to parse a TypeScript bundle; Hermes
marks that parser partial and unstable. The compiler links the bytecode with Hermes, the JSI shim,
and generated Pumpkin/WASI bindings into a WebAssembly component. Static Hermes is the default
engine, with QuickJS available as an alternative.

Start with the [runtime documentation](docs/index.md). This README covers toolchain setup, build
profiles, compiler and linker flags, and API coverage. The
[benchmarking guide](../../docs/benchmarking.md) compares the engines.

## Prepare Hermes

`prepare-hermes` prebuilds Hermes and its WASI runtime libraries. It needs Git, CMake, Ninja, a
host C/C++ compiler, and a WASI SDK. The command resolves the pinned WASI SDK automatically unless
`STATIC_HERMES_WASI_SDK_PATH`, `WASI_SDK_PATH`, or `WASI_SDK` points to a valid installation. It
reuses a valid cached SDK when no path is configured; an incomplete cached SDK is replaced
automatically. Concurrent setup processes share one SDK installation. If no valid cache exists,
`curl` and `tar` must be available to download and extract the pinned SDK. It does not install `wit-bindgen` or
`wasm-tools`, so Rust/Cargo is not needed for this preparation command.

```sh
pnpm --filter @pumpkin-plugins/static-hermes-runtime prepare-hermes
```

Preparation uses the SDK release and platform SHA-256 pins in `wasi-sdk.lock.json`. Release metadata
must report the same digest before download, and the downloaded archive is checked against the local
pin. It caches the SDK under `.cache/hermes/` by default. It checks out the source commit in
`hermes-source.lock.json`, applies the ordered patches in `hermes-patches/`, then builds host
`hermesc` and the full and lean WASI 2 Hermes/JSI libraries.

The cache is reused while its source pin, patches, toolchain, and build settings match. A changed
input triggers a rebuild. Preparation refreshes the managed checkout when the source pin changes and
rejects local Hermes source changes outside the managed patch set. Concurrent preparations lock the
cache, source checkout, host build directory, and WASI build directory by resolved path, so separate
workspaces that share any of those directories serialize. Toolchain setup takes its own lock on
`toolchain/` inside the cache and reuses valid cached tools without locking, so it does not wait for a
Hermes build.

Plugin builds prepare Hermes automatically when `engine` is omitted or set to `"static-hermes"`.
Run the command above to prewarm Hermes or prepare it explicitly before a build. A full component
build also resolves the pinned `wit-bindgen` and `wasm-tools` versions from
`toolchain-versions.json` and sets them up automatically. If `WASM_TOOLS` is unset and no valid
cached binary is available, setup downloads the platform archive pinned in `wasm-tools.lock.json`,
checks its SHA-256 digest, and replaces an invalid cache entry. A valid `WIT_BINDGEN` override,
shared-cache binary, or `~/.cargo/bin/wit-bindgen` is reused. Without a `WIT_BINDGEN` override, setup
skips a `~/.cargo/bin/wit-bindgen` that reports another version. With no matching cached or
user-installed executable, it installs the pinned `wit-bindgen` into the shared cache and needs
Rust/Cargo (using the pinned Rust toolchain through `rustup` when available). A `WIT_BINDGEN` or
`WASM_TOOLS` override that reports the wrong version fails setup.

The WASI SDK, Hermes source, and toolchain version pins follow the
[WASI SDK release pin schema](https://raw.githubusercontent.com/filiphsps/pumpkin-plugins/master/schemas/wasi-sdk-release-pin.schema.json),
[upstream Git pin schema](https://raw.githubusercontent.com/filiphsps/pumpkin-plugins/master/schemas/upstream-git-pin.schema.json), and
[toolchain versions schema](https://raw.githubusercontent.com/filiphsps/pumpkin-plugins/master/schemas/toolchain-versions.schema.json).
The package also carries the WASI Preview 2 CMake toolchain adjustment required by Hermes. Optional
paths and build settings are listed under [Build flags](#build-flags).

The external-consumer CI check uses these tool versions:

<!-- docs:begin external-consumer-toolchain -->
<!-- Generated from .node-version, package.json, toolchain-versions.json, wasi-sdk.lock.json and Static Hermes CI pins. Run `pnpm readme`. -->

| Tool | Version |
| --- | --- |
| Node.js | `24.21.0` |
| pnpm | `12.11.2` |
| CMake | `4.4.4` |
| Ninja | `1.13.2` |
| Rust and Cargo | `1.99.0` |
| wit-bindgen | `0.62.0` |
| wasm-tools | `1.261.0` |
| WASI SDK | `34` |
| Windows x64 MSVC toolset | `14.44` |
<!-- docs:end external-consumer-toolchain -->

Set `STATIC_HERMES_CACHE_DIR` to change the default `.cache/hermes/` location. The packed-consumer
check keeps its pnpm store in a temporary directory outside the consumer's `node_modules`.

## CLI and package API

The package CLI is compiled from `src/cli.ts` to `dist/cli.js` and registered as
`static-hermes-runtime`. Run it from this monorepo with:

```sh
pnpm --filter @pumpkin-plugins/static-hermes-runtime build
pnpm --filter @pumpkin-plugins/static-hermes-runtime exec static-hermes-runtime --help
```

Package consumers can import `buildStaticHermesComponent`, `prepareHermes`, and the other public
runtime functions directly from `@pumpkin-plugins/static-hermes-runtime`. The `codegen analyze` and
`codegen generate` commands take prepared WIT inputs and do not read a JavaScript bundle. Use
`--api-methods` and `--wasi-methods` to select operation identifiers; when omitted, codegen includes
all operations in the selected interfaces. `--event-types` selects event variants the same way it
does for `component build`, so codegen output matches a build's event selection. `component build`
accepts a JavaScript bundle by default; pass `--parse-ts` with a TypeScript bundle, or set
`parseTypeScript: true` in `buildStaticHermesComponent`. Hermes marks TypeScript parser support partial and unstable. Set
`quietOutput: true` on `buildStaticHermesComponent` when a caller owns the console format; runtime
stdout is suppressed, while command failures retain stderr diagnostics.

## Engine and runtime profiles

Omitting `engine` selects Static Hermes. Set `"engine": "quickjs"` in the package's
`pumpkinPlugin` configuration to select QuickJS.

```json
"pumpkinPlugin": {
  "entry": "src/plugin.ts",
  "output": "build/plugin.wasm",
  "wasi": [],
  "staticHermesRuntime": "full",
  "staticHermesGc": "malloc"
}
```

Static Hermes defaults to the lean profile and Hades garbage collection. Both profiles execute
precompiled Hermes bytecode; full also retains runtime source compilation, including `eval` and the
`Function` constructor. Set `staticHermesRuntime` to `"full"` to use it. Set `staticHermesGc` to
`"malloc"` to use malloc-managed GC. Both settings require the Static Hermes engine and cannot be
combined with QuickJS. The wasm32 WASI build has threads disabled, so Hades uses incremental
collection.

To build your plugin, replace `my-plugin` with its package name from `package.json`:

```sh
pnpm --filter @pumpkin-plugins/my-plugin build
```

Static Hermes builds prepare the toolchain automatically when required.

## Production and development builds

Production builds minify the JavaScript bundle, compile it to optimized Hermes bytecode with
function names and debug information stripped, and compile the native WASI code with `-Oz`.
Function/data sections allow unused code to be removed at link time. The linker strips symbols from
the production component. The shared build tool warns when the component is larger than 5 MiB
(5,242,880 bytes) and fails the build instead when `PUMPKIN_PLUGINS_FAIL_ON_SIZE_LIMIT=1` is set.

Development builds keep the JavaScript bundle readable and retain Hermes source locations and native
line tables for backtraces. Native code remains size optimized. The specific compiler and linker
flags are listed below.

## Build flags

These settings cover the build tools and paths, Hermes library configuration, Hermes bytecode
compilation, and WASI C/C++ compilation and linking.

### Toolchain paths

| Setting | Effect |
| --- | --- |
| `STATIC_HERMES_WASI_SDK_PATH` | Optional WASI SDK path override. Otherwise setup reuses `WASI_SDK_PATH` or `WASI_SDK`, or selects the matching archive from `wasi-sdk.lock.json`, checks its published digest against the lock, verifies the downloaded archive, and caches it under `.cache/hermes/toolchain/`. |
| `STATIC_HERMES_CACHE_DIR` | Cache root override. By default, Static Hermes uses `.cache/hermes/` under the nearest pnpm workspace containing the consumer project directory, or under that directory for standalone projects. |
| `STATIC_HERMES_SOURCE_DIR` | Hermes checkout; defaults to `source/` under the cache root. |
| `STATIC_HERMES_HOST_BUILD_DIR` | Host build directory; defaults to `build-host/` under the cache root. |
| `STATIC_HERMES_WASI_BUILD_DIR` | Hades WASI build directory; defaults to `build-wasip2/` under the cache root. The malloc build uses a sibling directory with the `-malloc` suffix. |
| `WIT_BINDGEN` | Optional `wit-bindgen` path override. The override must report the pinned `tools.wit-bindgen` version from `toolchain-versions.json`; a mismatch fails setup. Without it, setup reuses a matching cached or `~/.cargo/bin/wit-bindgen` executable, or installs the pinned version into the shared cache. |
| `WASM_TOOLS` | Optional `wasm-tools` path override for component builds and WIT analysis. It must report the pinned `tools.wasm-tools` version from `toolchain-versions.json`; otherwise setup reuses a valid cache or downloads and replaces an invalid cached executable. |

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
| `HERMESVM_GCKIND=HADES` | Default collector. With threads disabled on this wasm32 WASI target, Hades uses incremental collection. |
| `HERMESVM_GCKIND=MALLOC` | Selects malloc-managed GC for WASI. Set `pumpkinPlugin.staticHermesGc` to `"malloc"` to choose it. |
| `STATIC_HERMES_ENABLE_LEAN_ARCHIVE=0` | Links the full runtime profile instead of lean. In plugin builds it overrides `pumpkinPlugin.staticHermesRuntime`; `buildStaticHermesComponent` uses it only when `runtimeVariant` is omitted. |

### JavaScript-to-C compiler

Production runs `hermesc -color -O4 -fstrip-function-names -g0 -emit-binary`:

| Flag | Effect |
| --- | --- |
| `-color` | Prints colored compiler diagnostics in build logs. The build always passes this flag, including development builds. |
| `-parse-ts` | Optional. Parses supported TypeScript syntax in a TypeScript bundle by converting it to Flow; upstream support is partial and unstable. |
| `-Og` | Applies Hermes optimizations intended to remain suitable for debugging; used in development. |
| `-O4` | Optimizes Hermes bytecode. |
| `-fstrip-function-names` | Removes function names from the generated string table. |
| `-g0` | Omits compiler debug information. |
| `-g1` | Keeps Hermes source locations for JavaScript backtraces without per-instruction debug data. |
| `-emit-binary` | Emits Hermes bytecode embedded in the component. |

Development uses `hermesc -color -Og -g1 -emit-binary`: the bundle stays non-minified, function
names remain, and Hermes keeps source locations for JavaScript backtraces. Native C/C++ compilation uses
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
| `-mllvm -wasm-use-legacy-eh=false` | Emits standard WebAssembly exception-handling instructions instead of the legacy ones. Every native compile and link step passes it, including the Hermes WASI library build. |
| `-D_WASI_EMULATED_MMAN`, `-D_WASI_EMULATED_PROCESS_CLOCKS` | Enables wasi-libc emulation for the POSIX calls Hermes needs. |
| `-lwasi-emulated-mman`, `-lwasi-emulated-process-clocks` | Links those wasi-libc emulation implementations. |
| `-fwasm-exceptions` | Keeps C++ exceptions for error handling in the JSI shim. |
| `-w` | Suppresses compiler diagnostics from the generated WIT C glue; used only when compiling `plugin.c`. |
| `-mexec-model=reactor` | Builds a reactor module whose plugin lifecycle is controlled by the component host. |
| `-Wl,--gc-sections` | Removes unreferenced sections from the final component. |
| `-Wl,--strip-all` | Removes symbol and debug tables from production components. |
| `-Wl,--stack-first` | Places the stack before static data so stack overflow is trapped. |
| `-Wl,-z,stack-size=262144` | Reserves the default 256 KiB WASI stack; `STATIC_HERMES_STACK_SIZE` changes it (a multiple of 16 bytes from 131072 through 4294967280, the largest 16-byte-aligned size below wasm32's 4 GiB address-space limit). |
| `-lc++abi -lunwind` | Links C++ ABI and unwinding support used by the JSI shim. |

See [Benchmarking](../../docs/benchmarking.md) for the comparison command, workload coverage, and report interpretation.

## API and platform coverage

### Pumpkin API

`@pumpkin-plugins/build` resolves the Pumpkin API WIT from the installed API package's
`wit.lock.json`, then supplies the pinned WIT directory alongside the WASI definitions. The first
use of a lock digest fetches its upstream commit into the consumer's ignored cache. Each build
generates the component ABI and the ignored `generated/api-enums.generated.h`. Component builds use
the build package's source analysis to select API operations when it can determine the full set;
direct codegen can select operations with `--api-methods`, and omission includes all imported API
operations. Event conversion keeps complete payload fields for statically registered event types;
dynamic or unresolved registrations retain every event case and payload field.

The runtime generator emits a JSI host function and a JavaScript facade for every operation in the
pinned Pumpkin API WIT. A component includes the operations that source analysis selects, or all of
them when the selection is unknown. If a selected operation uses a WIT type that has no adapter, the
build fails and the error names the operation. Limits on the host side are documented separately;
for example, the pinned Pumpkin host does not start custom AI goals, as the
[runtime documentation](docs/index.md) explains.

The generated Pumpkin API facades reject host calls during `on_unload`, except
`scheduler.cancel-task`, which plugins need to stop scheduled callbacks. Cancel scheduled tasks and
perform local cleanup during unload; other host calls remain unavailable. This guard prevents calls
from re-entering the WASM store during shutdown.

### WASI

Static Hermes reads the WIT directory prepared by `@pumpkin-plugins/build`. It validates every
operation in an imported WASI interface, including operations the plugin does not use, and emits
native adapters for selected operations. Component builds use the build package's source analysis
when it can determine the full set; direct codegen can select operations with `--wasi-methods`, and
omission includes all operations in the selected WASI imports. The imported interfaces are listed in the
[WASI guide](docs/wasi.md#capability-bundles). The build enables a
feature-gated WIT operation when it is selected.

See the [WASI guide](docs/wasi.md) for supported imports and runtime limits.

<!-- docs:begin reference -->
<!-- Generated by pumpkin-plugins-docs from package, action, extension, and component docs metadata. Run `pnpm readme`. -->

See the [tool guide](https://filiphsps.github.io/pumpkin-plugins/tools/static-hermes-runtime/docs/) and [API reference](https://filiphsps.github.io/pumpkin-plugins/api/tools/@pumpkin-plugins/static-hermes-runtime/) on the documentation site.
<!-- docs:end reference -->
