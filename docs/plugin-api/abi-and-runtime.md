---
navigation:
    category: Plugin API
title: "Plugin API: ABI and runtime support"
description: "Match the Pumpkin server to the plugin ABI and check engine support"
---

# ABI and runtime compatibility

When a plugin will not load or an API call is unavailable, check two things: whether the plugin's
WIT ABI matches the Pumpkin server, and whether the chosen engine implements that operation. The
package version and generated TypeScript declarations cannot answer both questions on their own.

## Match the WIT ABI to the Pumpkin server

The npm version identifies the TypeScript facade release; the WIT version identifies the host ABI.
They are separate pins. The current alignment is:

| Pin | Current value | Source of truth |
| --- | --- | --- |
| API package | `@pumpkin-plugins/pumpkin-api` `0.1.0` | [`package.json`](../../tools/pumpkin-api/package.json) |
| Pumpkin plugin ABI | `pumpkin:plugin@0.1.0` from WIT subdirectory `v0.1` | [`wit.lock.json`](../../tools/pumpkin-api/wit.lock.json) |
| Pumpkin server | `0.2.0+26.3-26.51` | [`pumpkin-version.ts`](../../tools/test-harness/src/pumpkin-version.ts) |
| Upstream WIT source | Commit `4d7a501943bb99f0f02a339128833f58ed37d0cc` | [`wit.lock.json`](../../tools/pumpkin-api/wit.lock.json) |

The API package's `wit.lock.json` pins the upstream repository, commit, and WIT subdirectory. The
build tool fetches that exact commit on first use and when the lock changes, then stores it in the
consumer project's ignored `.cache/pumpkin-api-wit/<lock-digest>/` directory. It generates guest
declarations from that fetched WIT, so your declarations describe the pinned ABI rather than an
unlocked copy of the upstream branch. See [Setup and build](setup-and-build.md) for the commands.

Keep the API package's WIT pin aligned with the Pumpkin release in
[`tools/test-harness/src/pumpkin-version.ts`](../../tools/test-harness/src/pumpkin-version.ts). The
server must provide compatible component imports; if the pins drift, the server may be unable to
resolve the imports the plugin was built against. When changing the target server, verify its WIT
source first, then update the lock and server pin together.

## Check support in the selected engine

QuickJS and Static Hermes use different runtime paths and have different limits. For QuickJS
caveats, see [Building](../building.md#runtime-caveats). Static Hermes implements only a subset of
the Pumpkin API through its native JSI shim; check the [runtime coverage guide](../../tools/static-hermes-runtime/README.md#api-and-platform-coverage)
before relying on an operation there.

Generated TypeScript declarations come from the WIT ABI. They do not guarantee that every declared
operation is implemented by Static Hermes. The pinned server also has a separate limitation: it
does not start custom WASM AI goals, even though the Static Hermes adapter can dispatch their
callbacks. See the [Static Hermes Runtime guide](../../tools/static-hermes-runtime/docs/index.md)
for the host details and source link.
