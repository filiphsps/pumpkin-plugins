---
name: hermes-gc-safe-coding
description: Apply Hermes GC-safety rules when writing, reviewing, or debugging Pumpkin plugins and shared plugin libraries, especially Static Hermes native bridges.
---

# Hermes GC-safe coding

Use this skill for every task involving a plugin in `packages/` or a shared plugin library in `tools/`. Identify whether the change handles JavaScript values or Hermes GC internals before applying the rules.

## TypeScript and JavaScript plugins

Static Hermes manages JavaScript values through its tracing collector. Keep values in ordinary variables, object properties, or closures for as long as the program needs them; the VM manages roots. Do not add manual pinning, root registration, or C++ handle APIs to TypeScript plugin code.

Apply the plugin API's own ownership and lifetime rules to WIT resources and host objects. Those rules are separate from rooting ordinary JavaScript values. Do not apply Hermes-specific C++ rules to QuickJS builds.

## C++ that accesses Hermes GC internals

The [Hermes GC-safe coding guide](https://github.com/facebook/hermes/blob/static_h/doc/GCSafeCoding.md) describes native Hermes internals. Check the Hermes revision pinned in `tools/static-hermes-runtime/hermes-source.lock.json` and its local patches when the pinned implementation or API matters.

Treat a Hermes internal allocation or a call that may transitively allocate as a GC safepoint. An internal Hermes `Runtime &` or `PointerBase &` parameter may reach a safepoint unless documented otherwise or marked `_noalloc` / `_nogc`; an `_RJS` call may invoke JavaScript and reaches safepoints. Do not infer these rules from a JSI `Runtime &` alone.

Before a safepoint, store every live GC pointer in a root known to Hermes; reload it from that root afterward. Prefer `Locals` fields of `PinnedValue<T>` registered with `LocalsRAII` for new local roots. A `PinnedHermesValue` type by itself does not register a root. Do not introduce new `GCScope` instances or `makeHandle()` calls.

`PseudoHandle<T>` is unrooted. After checking a `CallResult` for `ExecutionStatus::EXCEPTION`, store its successful value in a root before the next safepoint. Never dereference a failed result. Keep every `Handle` within the lifetime of the `GCScope` or `Locals` that backs it; return a `PseudoHandle` or write into a caller-provided `MutableHandle` instead of returning a handle to a local root.

Use fixed `Locals` fields across loops. If existing APIs require temporary handles from a legacy `GCScope`, bound their lifetime with a marker or flush it each iteration, and keep long-lived values in `Locals`.

## Bridge boundaries and checks

For JSI bridge code, follow the JSI value and lifetime contract; do not treat `jsi::Value` as a raw Hermes pointer or manually wrap it in Hermes roots. Apply the native rules above only when code directly uses Hermes internal types or APIs.

Review each live native pointer or unrooted value across every possible safepoint, including allocations and recursive JavaScript calls. Where available, use a sanitizer build with `HERMESVM_SANITIZE_HANDLES` to expose stale handles; this mode moves the heap after allocations.
