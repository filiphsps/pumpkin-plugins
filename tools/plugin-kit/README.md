# @pumpkin-plugins/plugin-kit

Shared building blocks for plugins: a common plugin base and registration wrapper, data folders, logging, scheduled tasks, command registration, plugin messages and binary payload encoders, plus in-memory fakes for tests. `PluginBase` derives Pumpkin metadata from `src/info.ts`, runs common lifecycle behavior, and `registerPlugin` starts the nonblocking Market update check after loading. Plugin entry points export `handleTask` from the shared plugin module to dispatch the check's polling tasks.

The scheduling helpers accept whole, nonnegative tick counts; repeating periods must be at least
one tick. `cancelTask` cancels either delayed or repeating tasks and releases their callbacks.
Delayed callbacks are also released before they run, and failed scheduling retains no callback.

An internal package of [pumpkin-plugins](../../README.md): it is not published to npm, and the plugins in this repo use it as a workspace dependency. See [the docs](../../docs/code-style.md) for how it is used.
