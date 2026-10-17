# Maintaining Static Hermes WASI support

This guide is for maintainers who change the locked WASI definitions, capability bundles, or native
adapters. Plugin developers should use the [WASI guide](wasi.md) for imports, permissions, resource
ownership, and runtime limits.

## Source files

| Concern | Source |
| --- | --- |
| Capability names and interface expansion | [`tools/wasi-capabilities/src/index.ts`](../../wasi-capabilities/src/index.ts) |
| WASI version, WIT files, hashes, source URLs, and generated WIT files | [`tools/build/wasi-wit.lock.json`](../../build/wasi-wit.lock.json) |
| WIT download, SHA-256 verification, and versioned cache | [`tools/build/src/wasi-wit.ts`](../../build/src/wasi-wit.ts) |
| Plugin-world imports and WIT file preparation | [`tools/build/src/wit.ts`](../../build/src/wit.ts) |
| TypeScript declarations from the prepared world | [`tools/build/src/types.ts`](../../build/src/types.ts) |
| TypeScript call analysis for used Pumpkin and WASI methods | [`tools/build/src/wit-method-usage.ts`](../../build/src/wit-method-usage.ts) |
| `wasm-tools` input and WIT parser | [`src/wit/parser.ts`](../src/wit/parser.ts) |
| Dependency aliases and resolved WIT types | [`src/wit/resolver.ts`](../src/wit/resolver.ts) |
| Used methods, feature closure, event fields, and adapter plans | [`src/wit/analysis.ts`](../src/wit/analysis.ts) |
| JavaScript facades and native adapter emission | [`src/wit/emitters.ts`](../src/wit/emitters.ts) |
| Runtime shim and API enum generation | [`src/wit/generation.ts`](../src/wit/generation.ts) |
| Hermes source checkout, patches, build profiles, cache, and artifacts | [`src/hermes/prepare.ts`](../src/hermes/prepare.ts) |
| Component analysis, bindings, bytecode compilation, and linking | [`src/component/build.ts`](../src/component/build.ts) |

## Add or upgrade an interface

1. Confirm that the target Pumpkin runtime can provide the interface and that its WIT/API version is
   compatible.
2. Add or update the pinned files and hashes in `tools/build/wasi-wit.lock.json`. Keep alternate
   source URLs there; the WASI HTTP definitions use the `wasi-http` source recorded by the lock.
3. Add the interface to a bundle in `tools/wasi-capabilities/src/index.ts` with its required dependencies.
   Keep shared imports deduplicated.
4. Check that selected feature-gated operations enable their required `wit-bindgen` feature. The
   build derives these features from the selected operations.
5. Confirm that the Static Hermes converter supports the WIT parameter and result types. Unsupported
   operations fail with a missing-adapter diagnostic; extend conversion and ownership cleanup where
   needed.
6. Update adapter fixtures and coverage. The
   [`wit-api-coverage` test](../test/wit-api-coverage.test.mjs) checks that the generator can plan and
   emit adapters for every operation in the locked interfaces. The WASI WIT tests cover imports,
   dependency resolution, resource handling, and feature selection.
7. Verify the imports and permissions on the target Pumpkin server. Adapter-generation checks do not
   prove that a server provides an import or implements an operation as expected.

Keep the pinned `@pumpkin-plugins/pumpkin-api` version aligned with the Pumpkin server plugin ABI, as
described in [Building](../../../docs/building.md). WASI has its own lock and host compatibility
requirements.
