# BigInt QuickJS runtime

`quickjs-runtime-bigint.wasm` is the `componentize-qjs-runtime` built from the
upstream `componentize-qjs` 0.4.5 at commit
`e563c6d6ae50b087980414015663ca9c948c09bb`, with
`componentize-qjs-bigint.patch` applied. The patch converts WIT `u64` and `s64`
values to JavaScript `bigint` on push and reads them from JavaScript `bigint` on
pop. The runtime is Apache-2.0; its license is included as
`LICENSE.componentize-qjs`.

The 0.4.5 runtime tracks imported resource ownership, provides `drop()` and
`Symbol.dispose`, and releases unreachable owned handles after QuickJS evaluation.
Earlier runtimes leaked those handles even when plugins requested disposal,
eventually exhausting the component resource table. Event resources returned to
Pumpkin must remain alive until the return transfers their ownership to the host.

The build tool still uses the Wasmtime 48 componentizer fork and passes this
runtime to the componentizer through `--runtime`.
That option cannot be combined with the componentizer's `--opt-size` mode, so
the runtime itself is compiled with size optimization flags.

## Rebuild

Requirements: Node.js 24 or newer, Rust 1.99.0 with the `wasm32-wasip2` target,
and wasi-sdk 34. Put the pinned Rust toolchain first on `PATH`.

```sh
git clone https://github.com/andreiltd/componentize-qjs.git /tmp/componentize-qjs
git -C /tmp/componentize-qjs checkout --detach e563c6d6ae50b087980414015663ca9c948c09bb
QJS_SOURCE_DIR=/tmp/componentize-qjs \
WASI_SDK_PATH=/path/to/wasi-sdk-34 \
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

The checked-in manifest pins the source commit, patch and Cargo lock hashes,
compiler/SDK versions, build flags and shipped runtime hash. Candidate verification
checks those build inputs against the checked-in manifest and the artifact against
its candidate hash. Shipped verification checks the artifact against the pinned
hash. Verification does not independently rebuild source.

Two isolated local builds on macOS arm64 with Rust 1.99.0 and wasi-sdk 34 matched
the vendored runtime hash (`75219b89307011c7cd2bd6212e18a7d0ff1ba16d560c130d5173ccacb1880988`).
GitHub's macOS 15 runner produced a different hash, so CI compares two isolated
builds on the same runner and loads that candidate in real Pumpkin integration
tests before permitting a code release. This verifies same-runner repeatability
and behavior; it does not claim that bytes match across macOS environments.

Future runtime updates must review the source patch/license, refresh the manifest
and repeat clean builds plus bundle and real-server checks. Replacing the shipped
binary is a separate reviewed step.
