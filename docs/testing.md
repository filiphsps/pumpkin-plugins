# Testing

Each plugin has two vitest projects, set up by `definePluginVitestConfig()` from
`@pumpkin-plugins/test-harness/vitest`:

| Project | Files | Runs |
| --- | --- | --- |
| `unit` | `src/**/*.test.ts` | `pnpm test`. No server needed. |
| `integration` | `test/**/*.itest.ts` | `pnpm test:integration`. Builds first, then runs against a real Pumpkin. |

Run one plugin's integration tests with
`pnpm exec turbo run test:integration --filter=@pumpkin-plugins/<folder>`.

## Integration tests

`@pumpkin-plugins/test-harness` starts the real server binary per test file, in a temp directory, on
free ports, with plugin permission prompts and telemetry off:

```ts
// packages/<folder>/test/my.itest.ts
import { builtPluginPath, startPumpkin } from '@pumpkin-plugins/test-harness';

const server = await startPumpkin({
    plugins: [builtPluginPath(process.cwd())],
    files: { 'plugins/data/MyPlugin/config.toml': '...' }, // seed files before start
    config: {
        /* overrides merged into pumpkin.toml */
    }
});
await server.waitForLog(/Loaded MyPlugin/);
server.command('list');
await server.stop();
```

| Member | |
| --- | --- |
| `server.javaPort`, `server.bedrockPort` | The free ports the server listens on |
| `server.logs()`, `server.lines` | Server output with color codes removed |
| `server.errors()` | `ERROR` lines, minus one Pumpkin 0.2.0 logs on every fresh start (`Failed to save level.dat`) |
| `server.waitForLog(pattern, timeoutMs?, fromIndex?)` | Resolves with the first matching line |
| `server.command(text)` | Runs a console command |
| `server.pluginDataDir(name)` | Path of `plugins/data/<name>/` |
| `server.stop()` | Stops the server and removes its directory |

Servers are killed on exit, so a crashed test run doesn't leave processes holding ports.

## The server binary

The release is pinned in `tools/test-harness/src/pumpkin-version.ts`, and it should match the
`pumpkin-api-ts` version in `pnpm-workspace.yaml`. Which binary runs:

1. `PUMPKIN_BIN`, if set.
2. Otherwise the pinned release, downloaded once into `.cache/pumpkin` and verified against the
   release's `checksums.sha256`.

| Variable | Effect |
| --- | --- |
| `PUMPKIN_BIN` | Use this binary instead of downloading |
| `PUMPKIN_CACHE_DIR` | Where downloaded binaries are cached |
| `PUMPKIN_KEEP_DIR=1` | Keep each test server directory for inspection |
| `PUMPKIN_TEST_LOG_DIR` | Save each test server's full log here |
