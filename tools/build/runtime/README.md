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

Requirements: Rust 1.99.0 with the `wasm32-wasip2` target, and wasi-sdk 34.

```sh
git clone https://github.com/andreiltd/componentize-qjs.git /tmp/componentize-qjs
git -C /tmp/componentize-qjs checkout --detach e563c6d6ae50b087980414015663ca9c948c09bb
QJS_SOURCE_DIR=/tmp/componentize-qjs \
WASI_SDK_PATH=/path/to/wasi-sdk-34 \
  ./tools/build/runtime/build.sh
```

The script applies the patch if needed, builds the async WASI Preview 2 runtime,
and replaces `quickjs-runtime-bigint.wasm`.
