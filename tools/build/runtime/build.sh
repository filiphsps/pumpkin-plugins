#!/bin/sh
set -eu

runtime_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$runtime_dir/../../.." && pwd)

: "${QJS_SOURCE_DIR:?Set QJS_SOURCE_DIR to the pinned componentize-qjs checkout}"
: "${WASI_SDK_PATH:?Set WASI_SDK_PATH to wasi-sdk 34}"

QJS_SOURCE_DIR=$(CDPATH= cd -- "$QJS_SOURCE_DIR" && pwd)
WASI_SDK_PATH=$(CDPATH= cd -- "$WASI_SDK_PATH" && pwd)
target_dir=${CARGO_TARGET_DIR:-${TMPDIR:-/tmp}/componentize-qjs-bigint-target}
mkdir -p "$target_dir"
CARGO_TARGET_DIR=$(CDPATH= cd -- "$target_dir" && pwd)
export QJS_SOURCE_DIR WASI_SDK_PATH
export CARGO_TARGET_DIR

expected_commit=e563c6d6ae50b087980414015663ca9c948c09bb
actual_commit=$(git -C "$QJS_SOURCE_DIR" rev-parse HEAD)
if [ "$actual_commit" != "$expected_commit" ]; then
    printf 'Expected componentize-qjs at %s, got %s\n' "$expected_commit" "$actual_commit" >&2
    exit 1
fi

patch="$runtime_dir/componentize-qjs-bigint.patch"
if ! git -C "$QJS_SOURCE_DIR" apply --reverse --check "$patch" >/dev/null 2>&1; then
    git -C "$QJS_SOURCE_DIR" apply --check "$patch"
    git -C "$QJS_SOURCE_DIR" apply "$patch"
fi

export WASI_SDK="$WASI_SDK_PATH"
export CARGO_TARGET_WASM32_WASIP2_LINKER="$WASI_SDK_PATH/bin/wasm-ld"
export CARGO_TARGET_WASM32_WASIP2_RUSTFLAGS='-Clink-arg=--shared -Clink-arg=--no-entry -Clink-arg=--allow-undefined -Clto=fat -Copt-level=z'
export CFLAGS_wasm32_wasip2='-fPIC -Oz'
export CC_wasm32_wasip2="$WASI_SDK_PATH/bin/clang"
: "${RUST_MIN_STACK:=33554432}"
export RUST_MIN_STACK

if [ "$(uname -s)" = Darwin ]; then
    export DYLD_FALLBACK_LIBRARY_PATH="$WASI_SDK_PATH/lib${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
fi

cd "$QJS_SOURCE_DIR"
cargo build \
    --target wasm32-wasip2 \
    -p componentize-qjs-runtime \
    --no-default-features \
    --features component-model-async \
    --release

cp "$CARGO_TARGET_DIR/wasm32-wasip2/release/componentize_qjs_runtime.wasm" \
    "$repo_root/tools/build/runtime/quickjs-runtime-bigint.wasm"
chmod 644 "$repo_root/tools/build/runtime/quickjs-runtime-bigint.wasm"
