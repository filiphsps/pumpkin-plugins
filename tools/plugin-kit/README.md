# @pumpkin-plugins/plugin-kit

Shared building blocks for plugins: a common plugin base and registration wrapper, data folders, logging, scheduled tasks, command registration, plugin messages and binary payload encoders, plus in-memory fakes for tests. `PluginBase` derives Pumpkin metadata from `src/info.ts`, runs common lifecycle behavior, and `registerPlugin` starts the nonblocking Market update check after loading. Plugin entry points export `handleTask` from the shared plugin module to dispatch the check's polling tasks.

The scheduling helpers accept whole, nonnegative tick counts; repeating periods must be at least
one tick. `cancelTask` cancels either delayed or repeating tasks and releases their callbacks.
Delayed callbacks are also released before they run, and failed scheduling retains no callback.

`WasiDataDir.writeFile` replaces files through an exclusively created temporary sibling. Failed
writes and renames clean up that sibling without replacing the original error. Directory creation
checks that existing entries are directories; removing a symlink removes the link itself.
Random-access file handles reject invalid read ranges and can be closed more than once.

The `MemoryFiles` test fake copies bytes at its boundaries, rejects file/directory conflicts and
nonempty directory removal, and enforces file-handle closure. Use `put` to seed fixtures with missing
parents; `writeFile` requires its parent directory to exist, matching the WASI adapter.

An internal package of [pumpkin-plugins](../../README.md): it is not published to npm, and the plugins in this repo use it as a workspace dependency. See [the docs](../../docs/code-style.md) for how it is used.
