# Testing

Each plugin has two vitest projects, set up by `definePluginVitestConfig()` from
`@pumpkin-plugins/test-harness/vitest`:

| Project | Files | Runs |
| --- | --- | --- |
| `unit` | `src/**/*.test.ts` | `pnpm test`. No server needed. |
| `integration` | `test/**/*.itest.ts` | `pnpm test:integration`. Builds first, then runs against a real Pumpkin. Test files and up to four package suites run concurrently. |

Run `pnpm coverage` from the repository root to run every package's unit tests with Vitest's V8
coverage provider, then the GitHub Action tests with c8. Each package writes an LCOV report to
`coverage/lcov.info`; action coverage is combined under `coverage/actions/lcov.info`. CI uploads
these reports to Codecov. Coverage measures source files executed in the test process; integration
tests verify compiled WASM behavior but do not collect guest-code coverage. The Actions workflow
also tests changed actions under c8 and uploads their coverage to Codecov.

Run one plugin's integration tests with
`pnpm exec turbo run test:integration --filter=@pumpkin-plugins/<folder>`. To run only changed
packages and their dependents locally, compare with the base branch, for example
`pnpm exec turbo run test:integration --filter='...[origin/master]'`.

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
Each test file owns its server instances and temporary directories, so Vitest can run files in
parallel. The root command runs up to four package suites at a time to reduce total server startup
time without starting every package's servers simultaneously. CI also reuses the WASM files from its
build job, avoiding a second plugin build in the integration job.

Ports come from 20000 to 30000, below the range the operating system hands out for connections
(32768 up on Linux, 49152 on macOS and Windows), so nothing that connects while a server is starting
can take the port a test was given. A server that still finds one of its ports taken is started again
on ports of its own, three times over, before the start is failed.

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
