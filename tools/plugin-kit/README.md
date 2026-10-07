# @pumpkin-plugins/plugin-kit

Shared building blocks for plugins: a common plugin base and registration wrapper, data folders, logging, scheduled tasks, command registration, plugin messages and binary payload encoders, plus in-memory fakes for tests. `PluginBase` derives Pumpkin metadata from `src/info.ts`, runs common lifecycle behavior, and `registerPlugin` starts the nonblocking Market update check after loading. Plugin entry points export `handleTask` from the shared plugin module to dispatch the check's polling tasks.

The scheduling helpers accept whole, nonnegative tick counts; repeating periods must be at least
one tick. `cancelTask` cancels either delayed or repeating tasks and releases their callbacks.
Delayed callbacks are also released before they run, and failed scheduling retains no callback.

Use `ansi.named` from `@pumpkin-plugins/minecraft-colors` for log values worth scanning, such as
names, filenames, URLs, versions, UUIDs and ports. Pick the named role that fits the value and keep
the surrounding message plain. The `color.named` formatter emits Minecraft codes for chat replies.
See the [console color convention](../../docs/code-style.md#console-log-colors) for the palette source.

`WasiDataDir.writeFile` replaces files through an exclusively created temporary sibling. Failed
writes and renames clean up that sibling without replacing the original error. Directory creation
checks that existing entries are directories; removing a symlink removes the link itself.
Random-access file handles reject invalid read ranges and can be closed more than once.

The `MemoryFiles` test fake copies bytes at its boundaries, rejects file/directory conflicts and
nonempty directory removal, and enforces file-handle closure. Use `put` to seed fixtures with missing
parents; `writeFile` requires its parent directory to exist, matching the WASI adapter.

This package is internal to the repository and is not published to npm. See the
[code style guide](../../docs/code-style.md) and [API reference](https://filiphsps.github.io/pumpkin-plugins/api/tools/@pumpkin-plugins/plugin-kit/).
