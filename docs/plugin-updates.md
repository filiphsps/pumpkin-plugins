---
navigation:
    category: Server operations
---

# Checking for plugin updates

Every plugin in this repository checks Pumpkin Market after it loads. Its existing `info.name` and
metadata version identify the listing and the installed version. `PluginBase` and `registerPlugin`
from `@pumpkin-plugins/plugin-kit/plugin` add the update check to the common plugin lifecycle:

```ts
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import { PluginBase, registerPlugin } from '@pumpkin-plugins/plugin-kit/plugin';
import { info } from './info.ts';

class MyPlugin extends PluginBase {
    constructor() {
        super(info, __PLUGIN_VERSION__);
    }

    protected onPluginLoad(ctx: Context): void {
        // Plugin-specific setup.
    }
}

registerPlugin(new MyPlugin());
```

The helper uses Pumpkin's `wasi:http` outgoing handler to call the Market update API over HTTP or
HTTPS. It starts the request after plugin loading, then polls the WASI future and response stream
across scheduled tasks so the request does not block other plugins or server ticks. Plugin entry
points export the shared `handleTask` dispatcher for this work. `PluginBase` metadata automatically
adds the required `http.outbound` permission, and the generated README lists it. A failed request
is logged as a warning and does not prevent the plugin from loading. See the
[package README](../tools/update-check/README.md) for direct checks and request overrides.
