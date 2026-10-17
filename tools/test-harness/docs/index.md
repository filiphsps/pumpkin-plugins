# Pumpkin test harness

Use `@pumpkin-plugins/test-harness` when an integration test needs to exercise a plugin inside a real
Pumpkin server. This can verify behavior that a unit test with fakes can't establish, such as plugin
loading, permissions, commands, network bindings, and runtime compatibility. The harness creates a
fresh temporary server directory for each instance, so tests don't share server state.

## Start a test server

Build the plugin first. `builtPluginPath()` reads the artifact path from the package's
`pumpkinPlugin.output` setting and gives you an error that points to `pnpm build` if the artifact is
missing. Pass that path to `startPumpkin()`; the harness resolves the pinned Pumpkin release, creates
a temporary server directory, and waits for the server's ready log before returning. The instance
then gives you the server ports, plugin data paths, command input, and captured logs.

```ts
import { builtPluginPath, startPumpkin } from '@pumpkin-plugins/test-harness';

const server = await startPumpkin({
    plugins: [builtPluginPath(process.cwd())]
});

try {
    const from = server.lines.length;
    server.command('list');
    await server.waitForLog(/players? online|There are/i, 10_000, from);
} finally {
    await server.stop();
}
```

Always stop the instance in a `finally` block so Pumpkin exits and the temporary directory is
removed, even when an assertion fails. Set `PUMPKIN_KEEP_DIR` to keep that directory for debugging;
set `PUMPKIN_TEST_LOG_DIR` to save a copy of each server log outside it. By default, the harness
downloads the pinned server binary into `.cache/pumpkin` and verifies its checksum. Set
`PUMPKIN_BIN` to use an existing local binary, or `PUMPKIN_CACHE_DIR` to change the download cache.

See the [testing guide](../../../docs/testing.md) for the repository's integration-test setup, and
the [generated API reference](/api/tools/@pumpkin-plugins/test-harness/) for `StartOptions` and the
instance's log helpers.
