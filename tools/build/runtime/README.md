# BigInt QuickJS runtime

`quickjs-runtime-bigint.wasm` is the `componentize-qjs-runtime` built from the
`@di-framework/componentize-qjs` fork at commit
`50e5a140a1fbca35a01d0504b9807120100fc224`, with
`componentize-qjs-bigint.patch` applied. The patch converts WIT `u64` and `s64`
values to JavaScript `bigint` on push and reads them from JavaScript `bigint` on
pop. The fork is Apache-2.0; its license is included as
`LICENSE.componentize-qjs`.

The build tool passes this runtime to the componentizer through `--runtime`.
That option cannot be combined with the componentizer's `--opt-size` mode, so
the runtime itself is compiled with size optimization flags.

## Rebuild

Requirements: Rust 1.99.0 with the `wasm32-wasip2` target, and wasi-sdk 34.

```sh
git clone https://github.com/di-framework/componentize-qjs.git /tmp/componentize-qjs
git -C /tmp/componentize-qjs checkout --detach 50e5a140a1fbca35a01d0504b9807120100fc224
QJS_SOURCE_DIR=/tmp/componentize-qjs \
WASI_SDK_PATH=/path/to/wasi-sdk-34 \
  ./tools/build/runtime/build.sh
```

The script applies the patch if needed, builds the async WASI Preview 2 runtime,
and replaces `quickjs-runtime-bigint.wasm`.
