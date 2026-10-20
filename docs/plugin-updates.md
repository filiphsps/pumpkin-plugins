---
navigation:
    category: Server operations
title: "Checking for plugin updates"
description: "How plugin update checks work and how to test them"
---

# Checking for plugin updates

Plugins built with `@pumpkin-plugins/plugin-kit` check Pumpkin Market once after a successful load.
The check runs in scheduled tasks, so waiting for Market does not hold up plugin startup or a server
tick. It logs when a newer stable version is available; it does not download or install that
version.

## Use the plugin-kit check

`PluginBase` and `registerPlugin` enable the check as part of the normal plugin lifecycle. Export
the kit's `handleTask` from your entry point so the plugin kit can dispatch the scheduled HTTP polls.
If the plugin registers commands with `registerCommands`, export `handleCommand` the same way:

```ts
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import { PluginBase, registerPlugin } from '@pumpkin-plugins/plugin-kit/plugin';
import { info } from './info.ts';

class MyPlugin extends PluginBase {
    constructor() {
        super(info, __PLUGIN_VERSION__);
    }

    protected onPluginLoad(_ctx: Context): void {
        // Set up the plugin.
    }
}

registerPlugin(new MyPlugin());

export { handleCommand, handleTask } from '@pumpkin-plugins/plugin-kit/plugin';
export * from '@pumpkin-plugins/pumpkin-api';
```

Add the `http` capability to `pumpkinPlugin.wasi` in `package.json`. The server must also grant the
plugin `http.outbound`; the capability lets the component make HTTP requests, while the permission
lets the server authorize them. The plugin kit adds `http.outbound` to the plugin metadata and
generated README, but the server still has to allow it. See [WASI capabilities](plugin-api/host-api.md#when-you-need-wasi)
for the package configuration, and [plugin info and READMEs](plugin-info-and-readmes.md) for how
the plugin kit adds the permission to metadata.

The default development builds made with `pnpm dev` or `pnpm dev:no-hot-reload` skip the automatic
check. Pass `--release` to either command to include it. In a normal build, registration schedules
the first request after the plugin's load hook returns. If the load hook throws, the check does not
run. The scheduled callback must run in a later task, and the exported `handleTask` dispatches the
polling work needed to finish the request.

## What the check sends

The default endpoint is
`https://market.pumpkinmc.org/api/v1/rest/check-update`. The request is a `GET` with an
`Accept: application/json` header. Its `plugin_name` and `current_version` query parameters contain
the plugin's `info.name` and installed metadata version, URL-encoded. The response must be JSON with
a string `latest_version` and boolean `update_available`; when no stable release exists,
`latest_version` is `null` and `update_available` is `false`. The checker validates both fields,
then compares the semantic versions itself to decide whether to log an update; it does not rely on
the response's `update_available` value for that decision. An optional `release_notes` string can
carry the update's Markdown changelog, which the checker converts to plain text for the server log.
The current Market check endpoint does not return this field yet, so displaying changelogs also
requires a Market API update.

The request includes the plugin name and version, not plugin data or configuration. The default
URL uses HTTPS. The lower-level `registerPluginWithUpdates` and `checkMarketUpdate` APIs accept a
`marketplaceUrl` for tests or alternate environments; `registerPlugin` uses the default. Point an
override at a service you trust. The transport also permits HTTP for local tests.

## Failures and request limits

A failed request, invalid response, or invalid version is logged as a warning and does not prevent
the plugin from loading. A response must have HTTP status `200`. The asynchronous request has a
15-second overall timeout and rejects response bodies larger than 64 KiB. The WASI host request
also sets a 2-second connection timeout, a 3-second first-byte timeout, and a 1-second timeout
between response bytes.

The automatic check does not cache a result or retry a failed Market request. It runs once after
each successful plugin load in a normal build; the scheduled polling only waits for the current
request to make progress. It does not check again while the plugin remains loaded.

## Test the check

For deterministic unit tests, call `checkMarketUpdate` with an injected `request` function. Set
`marketplaceUrl` when you need to verify URL construction against a test base URL. This avoids
depending on the live Market response. Run the package's unit tests with
`pnpm --filter @pumpkin-plugins/update-check test`.

To test the real WASI transport, use `requestMarketJsonAsync` with a scheduler that runs callbacks
in later tasks. The transport polls the HTTP response without blocking; a callback that runs inline
is not supported. `requestMarketJson` is synchronous and blocks, so keep it out of plugin loading
and server ticks. Run the transport integration test with
`pnpm --filter @pumpkin-plugins/update-check test:integration`. Against a local server, it runs the
scheduled check that registration starts after loading, and exercises delayed, chunked responses
and HTTP and JSON failures. The
[`@pumpkin-plugins/update-check` README](../tools/update-check/README.md) describes the direct APIs.
