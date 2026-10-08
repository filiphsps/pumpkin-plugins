# Plugin kit

`@pumpkin-plugins/plugin-kit` contains shared lifecycle, scheduling, command, logging, data-folder,
plugin-message, and payload helpers used by Pumpkin plugins. It also provides in-memory fakes for
testing code that depends on host services.

## Plugin lifecycle

Extend `PluginBase` with the package's `PluginInfo` and version, implement the plugin load hook,
then register the instance. The shared registration adds the non-blocking Pumpkin Market update
check. Plugin entry points export `handleTask` so shared scheduled work is dispatched before the
Pumpkin API's task handler.

The scheduler helpers use whole, nonnegative tick counts and require repeating intervals of at
least one tick. Delayed callbacks are released before execution; failed scheduling does not retain
them. Tick delays and periods are sent to WIT as `bigint`; handler and task IDs remain `number`.

## Data and commands

The WASI data-folder adapter supplies file listing, random-access reads, directory creation, and
atomic file replacement. Paths are relative to the plugin data mount. The shared command helpers
register a typed command tree and derive the documented command paths from that same declaration.

Use the `MemoryFiles`, fake command registry, and logger helpers in unit tests. Their behavior
intentionally catches common host mismatches such as writing to a missing directory, conflicting
file and directory paths, or using a file handle after close. The generated API reference lists the
package's module entry points and exact types.
