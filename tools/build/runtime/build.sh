#!/bin/sh
set -eu

runtime_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

: "${QJS_SOURCE_DIR:?Set QJS_SOURCE_DIR to the pinned componentize-qjs checkout}"
: "${WASI_SDK_PATH:?Set WASI_SDK_PATH to wasi-sdk 34}"

QJS_SOURCE_DIR=$(CDPATH= cd -- "$QJS_SOURCE_DIR" && pwd)
WASI_SDK_PATH=$(CDPATH= cd -- "$WASI_SDK_PATH" && pwd)
target_dir=${CARGO_TARGET_DIR:-${TMPDIR:-/tmp}/componentize-qjs-bigint-target}
mkdir -p "$target_dir"
CARGO_TARGET_DIR=$(CDPATH= cd -- "$target_dir" && pwd)
export QJS_SOURCE_DIR WASI_SDK_PATH
export CARGO_TARGET_DIR

node "$runtime_dir/provenance.mjs" inputs "$QJS_SOURCE_DIR" "$WASI_SDK_PATH"

patch="$runtime_dir/componentize-qjs-bigint.patch"
if ! git -C "$QJS_SOURCE_DIR" apply --reverse --check "$patch" >/dev/null 2>&1; then
    git -C "$QJS_SOURCE_DIR" apply --check "$patch"
    git -C "$QJS_SOURCE_DIR" apply "$patch"
fi

unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER
RUSTC=$(command -v rustc)
export RUSTC

export WASI_SDK="$WASI_SDK_PATH"
export CARGO_TARGET_WASM32_WASIP2_LINKER="$WASI_SDK_PATH/bin/wasm-ld"
CARGO_TARGET_WASM32_WASIP2_RUSTFLAGS=$(node "$runtime_dir/provenance.mjs" value rustFlags)
export CARGO_TARGET_WASM32_WASIP2_RUSTFLAGS
CFLAGS_wasm32_wasip2=$(node "$runtime_dir/provenance.mjs" value cFlags)
export CFLAGS_wasm32_wasip2
export CC_wasm32_wasip2="$WASI_SDK_PATH/bin/clang"
: "${RUST_MIN_STACK:=33554432}"
export RUST_MIN_STACK

if [ "$(uname -s)" = Darwin ]; then
    export DYLD_FALLBACK_LIBRARY_PATH="$WASI_SDK_PATH/lib${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
fi

cd "$QJS_SOURCE_DIR"
cargo build --locked \
    --target "$(node "$runtime_dir/provenance.mjs" value target)" \
    -p componentize-qjs-runtime \
    --no-default-features \
    --features "$(node "$runtime_dir/provenance.mjs" value features)" \
    --release

output_dir=${RUNTIME_OUTPUT_DIR:-$CARGO_TARGET_DIR/runtime-artifact}
mkdir -p "$output_dir"
output_dir=$(CDPATH= cd -- "$output_dir" && pwd)
# Candidate output is separate from the vendored artifact; publication needs explicit review.
if [ "$output_dir" = "$runtime_dir" ]; then
    printf 'RUNTIME_OUTPUT_DIR must not replace the vendored runtime\n' >&2
    exit 1
fi
candidate_dir=$(mktemp -d "$output_dir/.runtime-candidate.XXXXXX")
trap 'rm -rf "$candidate_dir"' EXIT HUP INT TERM
cp "$CARGO_TARGET_DIR/wasm32-wasip2/release/componentize_qjs_runtime.wasm" \
    "$candidate_dir/quickjs-runtime-bigint.wasm"
chmod 644 "$candidate_dir/quickjs-runtime-bigint.wasm"
node "$runtime_dir/provenance.mjs" record "$QJS_SOURCE_DIR" "$WASI_SDK_PATH" "$candidate_dir"
node "$runtime_dir/provenance.mjs" verify-candidate "$candidate_dir"
mv -f "$candidate_dir/quickjs-runtime-bigint.wasm" "$output_dir/quickjs-runtime-bigint.wasm"
mv -f "$candidate_dir/provenance.json" "$output_dir/provenance.json"
printf 'Verified runtime candidate: %s\n' "$output_dir"
