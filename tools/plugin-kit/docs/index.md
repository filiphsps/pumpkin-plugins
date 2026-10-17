# Plugin kit

`@pumpkin-plugins/plugin-kit` gives Pumpkin plugins shared building blocks for lifecycle hooks,
commands, scheduled work, logging, data folders, plugin messages, and binary payloads. Its testing
helpers provide in-memory replacements for host services, so you can exercise plugin behavior
without starting a server.

## Plugin lifecycle

Build your plugin on `PluginBase`, passing its `PluginInfo` and package version to the constructor.
Implement `onPluginLoad` for setup and, when needed, `onPluginUnload` for cleanup. Register the
instance with `registerPlugin` to enable the non-blocking Pumpkin Market update check. Export
`handleTask` from your plugin entry point as well; it dispatches the kit's scheduled work and then
passes other task IDs to the Pumpkin API handler.

The scheduling helpers accept whole, nonnegative tick counts. Repeating tasks must run at least
once per tick, while delayed tasks may run immediately with a delay of zero. If scheduling fails,
the kit releases the callback; when a delayed callback runs, it releases it before execution.

## Data, commands, and tests

When the plugin has the `fs.*.data` permission, the WASI data-folder adapter provides access to its
mounted `data` directory. Its paths are relative to that directory. You can list entries, inspect
files, read them in full or at chosen offsets, create directories, replace files atomically, and
remove files or empty directories.

The command helpers build a typed command tree and register its handlers. The same tree supplies
the documented command paths, so the registered commands and their documentation stay aligned.
The generated API reference lists the kit's module entry points and exact types.

For unit tests, use `MemoryFiles`, the fake command host, and the in-memory logger to stand in for
filesystem, command, and logging services. These fakes also expose common mistakes: for example,
`MemoryFiles` rejects file and directory conflicts and operations on missing directories, and its
file handles reject reads after they are closed.
