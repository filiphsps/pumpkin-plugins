# Pumpkin test harness

`@pumpkin-plugins/test-harness` starts a real Pumpkin server in a temporary directory for Vitest
integration tests. Use it to verify behavior that unit tests with fakes cannot establish, including
plugin loading, permissions, commands, network bindings, and runtime compatibility.

## Start a test server

Build the plugin first, then point the harness at its `.wasm` artifact and start Pumpkin from the
test. The harness resolves the pinned server release, creates a temporary server directory, waits
for the ready log, and exposes ports, plugin data paths, command input, and captured logs through
the returned instance.

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

The exact `StartOptions` fields and log helpers are in the generated API reference. `stop()` asks
Pumpkin to exit, saves logs when configured, and removes the temporary directory unless
`PUMPKIN_KEEP_DIR` is set. `PUMPKIN_BIN` can select a local server binary; `PUMPKIN_TEST_LOG_DIR`
can retain test logs outside the temporary server directory.
