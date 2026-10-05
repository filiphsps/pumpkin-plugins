# @pumpkin-plugins/update-check

Checks a plugin's current version against Pumpkin Market over Pumpkin's WASI HTTP host. The
registration helper starts a nonblocking request after plugin loading when given a scheduler.

```ts
import { registerPluginWithUpdates } from '@pumpkin-plugins/update-check';

registerPluginWithUpdates(plugin, info, { schedule });
```

The plugin must request the `http` WASI capability and the server must grant `http.outbound`. The
scheduler defers the initial request and dispatches follow-up polls through the plugin's task
handler. Checking a version cannot block plugin startup or server ticks. A failed update request is
logged and does not interrupt plugin loading. `checkMarketUpdate` remains available for direct
checks; deterministic tests can inject a synchronous JSON request function.

An internal package of [pumpkin-plugins](../../README.md): it is not published to npm, and plugins
in this repo can use it as a workspace dependency.
