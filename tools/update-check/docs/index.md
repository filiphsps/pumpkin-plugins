# Pumpkin Market update checks

`@pumpkin-plugins/update-check` compares a plugin's version with its Pumpkin Market listing using
Pumpkin's WASI HTTP host. The registration helper schedules the request so plugin loading and game
ticks are not blocked.

## Register an automatic check

```ts
import { registerPluginWithUpdates } from '@pumpkin-plugins/update-check';

registerPluginWithUpdates(plugin, info, { schedule });
```

The plugin must declare the HTTP WASI capability and request the `http.outbound` permission. The
scheduler must run its callback in a later task, not inline. Export and dispatch the scheduled task
handler as part of the plugin entry point so follow-up polling can proceed.

## Failure behavior and direct checks

Automatic checks do not block plugin startup. A failed request is logged and does not prevent the
plugin from loading. Requests stop after 15 seconds and response bodies larger than 64 KiB are
rejected. `marketplaceUrl` can override the Market base URL for tests or alternate environments.

`checkMarketUpdate` supports a synchronous injected JSON requester for deterministic code and tests.
`requestMarketJsonAsync` exposes the non-blocking transport directly. The synchronous
`requestMarketJson` blocks, so do not call it during plugin loading or a server tick.
