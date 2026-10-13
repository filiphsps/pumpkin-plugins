---
navigation:
    category: Plugin API
---

# ABI and runtime support

The npm package version identifies the TypeScript facade release. The WIT package version identifies the host ABI. Package `@pumpkin-plugins/pumpkin-api` `0.1.0` carries `pumpkin:plugin@0.1.0`, aligned with Pumpkin server `0.2.0+26.3-26.51`.

The API package includes `wit.lock.json`, which pins the upstream WIT commit. The build tool fetches that immutable commit into the consumer project's ignored `.cache/pumpkin-api-wit/<lock-digest>/` directory on first use and whenever the lock changes, then generates guest declarations from the fetched source. Keep the package's WIT ABI and `tools/test-harness/src/pumpkin-version.ts` aligned when upgrading the pinned server.

QuickJS and Static Hermes do not have identical runtime internals. The [Static Hermes Runtime guide](../../tools/static-hermes-runtime/README.md) documents current support and its conformance status. Do not infer that an operation is supported by Static Hermes solely because it appears in generated declarations or has a generated adapter.
