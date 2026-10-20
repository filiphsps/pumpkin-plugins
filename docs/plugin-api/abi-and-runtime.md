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
They are separate pins, and each file below holds the current value:

| Pin | Source of truth |
| --- | --- |
| API package version | [`package.json`](../../tools/pumpkin-api/package.json) |
| Pumpkin plugin ABI (WIT subdirectory) | [`wit.lock.json`](../../tools/pumpkin-api/wit.lock.json) |
| Upstream WIT commit | [`wit.lock.json`](../../tools/pumpkin-api/wit.lock.json) |
| Pumpkin server release | [`pumpkin-version.ts`](../../tools/test-harness/src/pumpkin-version.ts) |

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

QuickJS and Static Hermes use different runtime paths and have different limits; the
[runtime caveats](../building.md#runtime-caveats) cover both. Static Hermes generates an adapter for
each Pumpkin API operation a plugin includes. When an operation has a WIT type the generator can't
convert, the build fails and names the operation, so it doesn't fail later at runtime. Static Hermes
also doesn't release resources during garbage collection, drops the resources passed to a callback
when it returns, and runs promise jobs only inside the callback that queued them. The
[Static Hermes caveats](../building.md#static-hermes) explain what to do about each.

Generated TypeScript declarations come from the WIT ABI, and a successful build means the engine
can call the operations it includes. What the server does with a call is a separate question. For
example, the pinned server does not start custom WASM AI goals, even though the Static Hermes
adapter can dispatch their callbacks. See the [Static Hermes Runtime guide](../../tools/static-hermes-runtime/docs/index.md)
for the host details and source link.
