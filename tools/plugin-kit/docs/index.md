# Plugin kit

`@pumpkin-plugins/plugin-kit` gives Pumpkin plugins shared building blocks for lifecycle hooks,
commands, scheduled work, logging, data folders, plugin messages, and binary payloads. Its testing
helpers provide in-memory replacements for host services, so you can exercise plugin behavior
without starting a server.

## Plugin lifecycle

Build your plugin on `PluginBase`, passing its `PluginInfo` and package version to the constructor.
Implement `onPluginLoad` for setup and, when needed, `onPluginUnload` for cleanup. Register the
instance with `registerPlugin` to enable the non-blocking Pumpkin Market update check.

The kit gives scheduled tasks and commands its own handler IDs, which the Pumpkin API package
doesn't know about. Export the kit's `handleTask` and `handleCommand` from your plugin entry point
next to the API package's exports:

```ts
export { handleCommand, handleTask } from '@pumpkin-plugins/plugin-kit/plugin';
export * from '@pumpkin-plugins/pumpkin-api';
```

Each one runs the kit's handler for an ID it owns and passes other IDs to the Pumpkin API handler.
The named exports take the place of the API package's functions with the same names, which
`export *` would otherwise re-export. Without them, Pumpkin's calls reach the API handlers only:
commands registered with `registerCommands` fail with `No handler for command ID`, and the kit's
scheduled tasks, including the update check, never run.

The scheduling helpers accept whole, nonnegative tick counts. A repeating period must be at least
one tick; a delayed task may use a delay of zero. `cancelTask` stops either kind and releases its
callback. If scheduling fails, the kit releases the callback; when a delayed callback runs, it
releases it before execution.

Use `hostLogger` to write to the server log. Pumpkin prints a plugin's messages as
`[plugin] <message>` without saying which plugin wrote them, so wrap it with `taggedLogger` from
`/logger` and log through the result: ``taggedLogger(`${ansi.named.name(PLUGIN_NAME)}:`, hostLogger)``
starts every line with the plugin's name. Format values worth scanning, such as names, file
names, URLs and versions, with `ansi.named` from `@pumpkin-plugins/minecraft-colors`, as the
[console color convention](../../../docs/code-style.md#color-in-console-logs) describes.

## Data, commands, and tests

When the plugin has the `fs.*.data` permission, the WASI data-folder adapter provides access to its
mounted `data` directory. Its paths are relative to that directory. You can list entries, inspect
files, read them in full or at chosen offsets, create directories, replace files atomically, and
remove files or empty directories. `writeFile` writes to an exclusively created temporary sibling,
syncs its data to disk and renames it over the target, so readers never see half a file. If any of
those steps fails, the temporary file is removed and the original error is reported. Removing a
symlink removes the link, not its target.

The command helpers build a typed command tree and register its handlers. The same tree supplies
the documented command paths, so the registered commands and their documentation stay aligned.
The generated API reference lists the kit's module entry points and exact types.

For unit tests, use `MemoryFiles`, the fake command host, and the in-memory logger to stand in for
filesystem, command, and logging services. These fakes also expose common mistakes: for example,
`MemoryFiles` rejects file and directory conflicts and operations on missing directories, and its
file handles reject reads after they are closed. Seed fixtures with `put`, which creates missing
parent directories; `writeFile` requires the parent to exist, as the WASI adapter does.
