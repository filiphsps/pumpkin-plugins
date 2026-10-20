# BigInt QuickJS runtime

`quickjs-runtime-bigint.wasm` is built from the pinned upstream
`componentize-qjs` source with `componentize-qjs-bigint.patch` applied. The patch
converts WIT `u64` and `s64` values to JavaScript `bigint` on push and reads them
from JavaScript `bigint` on pop. The runtime is Apache-2.0; its license is
included as `LICENSE.componentize-qjs`.

The runtime tracks imported resource ownership, provides `drop()` and
`Symbol.dispose`, and releases unreachable owned handles after QuickJS evaluation.
Without those releases, handles can exhaust the component resource table even
when plugins request disposal. Event resources returned to Pumpkin must remain
alive until the return transfers ownership to the host.

The [build tool](../README.md) passes this runtime to its componentizer through
`--runtime`. That option cannot be combined with the componentizer's `--opt-size`
mode, so the runtime itself is compiled with the size optimization flags listed
in its generated provenance below.

## Pinned build provenance

The build script validates the source, patch, lockfile and toolchain against this
manifest before building. It reads the target, feature and compiler flags from
the same manifest, so the values below describe the inputs used by the script.

<!-- docs:begin provenance -->
<!-- Generated from runtime/provenance.json, runtime/build.sh, and package.json. Run `pnpm --filter @pumpkin-plugins/build readme`. -->

| Input | Pinned value |
| --- | --- |
| Node.js engine | `>=24.21.0` |
| QuickJS source | [`e563c6d6ae50b087980414015663ca9c948c09bb`](https://github.com/andreiltd/componentize-qjs/tree/e563c6d6ae50b087980414015663ca9c948c09bb) |
| Source repository | `https://github.com/andreiltd/componentize-qjs.git` |
| BigInt patch SHA-256 | `515a06e47c3c8eb819fb1ec464560cb66dfb9fe25c51ff560534da8de99b4a43` |
| Cargo.lock SHA-256 | `03e153b621bf6b830064d6b0931ebe98e28aa93bc833913397fb48720843d656` |
| Rust compiler | `rustc 1.99.0 (b940084d7 2026-09-28)` |
| Cargo | `cargo 1.99.0 (5f94df478 2026-08-27)` |
| WASI SDK | `34.0` (build script requires major `34`) |
| Clang | `clang version 23.1.0-wasi-sdk (https://github.com/llvm/llvm-project 895aa2c896ada719451be2e3673c83da8ddf1141)` |
| Target and feature | `wasm32-wasip2` / `component-model-async` |
| Rust flags | `-Clink-arg=--shared -Clink-arg=--no-entry -Clink-arg=--allow-undefined -Clto=fat -Copt-level=z` |
| C flags | `-fPIC -Oz` |
| Shipped runtime SHA-256 | `75219b89307011c7cd2bd6212e18a7d0ff1ba16d560c130d5173ccacb1880988` |
<!-- docs:end provenance -->

## Rebuild

Use the Node.js range and toolchain values shown above. Install the listed Rust
target and put the pinned Rust toolchain first on `PATH`.

<!-- docs:begin source-checkout -->
<!-- Generated from runtime/provenance.json, runtime/build.sh, and package.json. Run `pnpm --filter @pumpkin-plugins/build readme`. -->

```sh
git clone https://github.com/andreiltd/componentize-qjs.git /tmp/componentize-qjs
git -C /tmp/componentize-qjs checkout --detach e563c6d6ae50b087980414015663ca9c948c09bb
```
<!-- docs:end source-checkout -->

```sh
QJS_SOURCE_DIR=/tmp/componentize-qjs \
WASI_SDK_PATH=/path/to/wasi-sdk \
CARGO_TARGET_DIR=/tmp/componentize-qjs-target \
RUNTIME_OUTPUT_DIR=/tmp/componentize-qjs-candidate \
  ./tools/build/runtime/build.sh
```

The script accepts a clean pinned checkout or exactly the declared patch, rejects
other tracked, untracked and ignored inputs, checks the dependency lock and tool
versions, and builds with `cargo --locked`. It emits a candidate runtime and a
`provenance.json` manifest in `RUNTIME_OUTPUT_DIR` (default:
`$CARGO_TARGET_DIR/runtime-artifact`). It does not replace the vendored runtime.
A failure before publication leaves a previous candidate untouched. Each candidate
manifest records the artifact hash, operating system and architecture, and OS release.

```sh
node tools/build/runtime/provenance.mjs verify-candidate /tmp/componentize-qjs-candidate
node tools/build/runtime/provenance.mjs verify tools/build/runtime
```

The build script checks source and build inputs against the checked-in manifest
before building. `verify-candidate` checks the candidate manifest against the
pinned values and the artifact against its recorded hash. `verify` checks the
shipped artifact against the pinned hash. Neither command independently rebuilds
source.

CI does not rebuild the runtime. The build package's unit tests run
`src/runtime-provenance.test.ts`, which checks the vendored artifact against its
pinned hash and exercises `build.sh` and `provenance.mjs` with stub tools.
Comparing two clean builds and loading the candidate in real Pumpkin integration
tests are manual steps for a runtime update. Matching bytes across build
environments are not guaranteed.

Future runtime updates must review the source patch/license, refresh the manifest
and repeat clean builds plus bundle and real-server checks. Replacing the shipped
binary is a separate reviewed step.
