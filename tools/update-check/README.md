# @pumpkin-plugins/update-check

Checks a plugin's current version against Pumpkin Market over Pumpkin's WASI HTTP host. The
registration helper starts a nonblocking request after plugin loading when given a scheduler.

```ts
import { registerPluginWithUpdates } from '@pumpkin-plugins/update-check';

registerPluginWithUpdates(plugin, info, { schedule });
```

The plugin must request the `http` WASI capability and the server must grant `http.outbound`. The
scheduler defers the initial request and dispatches follow-up polls through the plugin's task
handler. The scheduler must run callbacks in a later task, never inline. Automatic checks do not
block plugin startup or server ticks. Asynchronous requests stop after 15 seconds and reject bodies
larger than 64 KiB. A failed update request is logged and does not interrupt plugin loading. `checkMarketUpdate` remains available for direct
checks with an injected synchronous JSON request function, which is useful for deterministic tests.
`requestMarketJsonAsync` exposes the same nonblocking transport for direct use. The synchronous
`requestMarketJson` transport blocks and must not be called during plugin loading or server ticks.
`marketplaceUrl` overrides the Market base URL for registration and direct version checks.

An internal package of [pumpkin-plugins](../../README.md): it is not published to npm, and plugins
in this repo can use it as a workspace dependency.
