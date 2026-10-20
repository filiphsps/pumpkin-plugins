# Maintaining Static Hermes WASI support

Use this guide when you change the pinned WASI definitions, capability bundles, or Static Hermes
native adapters. If you're developing a plugin, see the [WASI guide](wasi.md) for imports,
permissions, resource ownership, and runtime limits.

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
| Hermes preparation stages | [`src/hermes/prepare.ts`](../src/hermes/prepare.ts) |
| Hermes source pin and checkout | [`src/hermes/source.ts`](../src/hermes/source.ts) |
| Hermes patch series | [`src/hermes/patch.ts`](../src/hermes/patch.ts) |
| Hermes build profiles, cache, and artifacts | [`src/hermes/build.ts`](../src/hermes/build.ts) |
| Component analysis, bindings, bytecode compilation, and linking | [`src/component/build.ts`](../src/component/build.ts) |

## Add or upgrade an interface

1. Check that the target Pumpkin runtime provides the interface and supports its WIT/API version.
   The locked definitions and a generated adapter do not establish host support.
2. Add or update the pinned files and hashes in `tools/build/wasi-wit.lock.json`. Put alternate
   source URLs in that lock too; for example, it records the `wasi-http` source for the WASI HTTP
   definitions.
3. Add the interface to the appropriate bundle in `tools/wasi-capabilities/src/index.ts`, including
   its dependencies. The bundle builder deduplicates shared imports, so list only the interfaces
   each capability requires.
4. Check feature-gated operations as well as their interfaces. Build analysis derives the required
   `wit-bindgen` features from the selected operations and passes them to code generation.
5. Confirm that Static Hermes can convert each WIT parameter and result type. If it cannot, adapter
   planning reports an unsupported-operation error; add the conversion and any required resource
   ownership cleanup.
6. Update adapter fixtures and coverage. The
   [`wit-api-coverage` test](../test/wit-api-coverage.test.mjs) checks planning and emission for every
   operation in the locked interfaces. The WASI WIT tests also cover imports, dependency resolution,
   resource handling, and feature selection.
7. Test the imports and permissions against the target Pumpkin server. Generation checks show that
   Static Hermes can prepare an adapter, but they do not show that the server provides the import or
   implements the operation as expected.

Keep the pinned `@pumpkin-plugins/pumpkin-api` version aligned with the Pumpkin server plugin ABI, as
described in [Building](../../../docs/building.md). WASI has its own lock and host compatibility
requirements.
