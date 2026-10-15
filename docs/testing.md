---
navigation:
    category: Plugin development
---

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
`pnpm turbo run test:integration --filter=@pumpkin-plugins/<folder>`. To run only changed
packages and their dependents locally, compare with the base branch, for example
`pnpm turbo run test:integration --filter='...[origin/master]'`.

## Integration tests

`@pumpkin-plugins/test-harness` starts the real server binary per test file, in a temp directory, on
free ports, with plugin permission prompts and telemetry off. The harness sets `RUST_LOG=info` for
Pumpkin so startup and plugin INFO logs remain available to readiness checks and assertions even
when the calling shell uses a stricter filter:

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
| `server.errors()` | `ERROR` lines except the harness's baseline errors ([defined in `instance.ts`](../tools/test-harness/src/instance.ts)) |
| `server.waitForLog(pattern, timeoutMs?, fromIndex?)` | Resolves with the first matching line |
| `server.command(text)` | Runs a console command |
| `server.pluginDataDir(name)` | Path of `plugins/data/<name>/` |
| `server.stop()` | Stops the server and removes its directory |

Servers are killed on exit, so a crashed test run doesn't leave processes holding ports.
Each test file owns its server instances and temporary directories, so Vitest can run files in
parallel. The root command runs up to four package suites at a time to reduce total server startup
time without starting every package's servers simultaneously. CI limits that to two package suites
at a time on hosted runners. CI also reuses the WASM files from its build job, avoiding a second
plugin build in the integration job.

## Packed standalone consumer

Run `pnpm run test:external-consumer` with the Node, pnpm and host-tool versions listed in the
[Static Hermes Runtime guide](../tools/static-hermes-runtime/README.md). It packs the internal
production dependencies, installs them from a temporary local registry, invokes the packed creator
binary and both real `pnpm create pumpkin-plugin` language flows, then typecheck and build both
starters. By default, the check uses a temporary pnpm store and Static Hermes cache outside the
consumer and removes its temporary project when it finishes. Set
`PUMPKIN_EXTERNAL_CONSUMER_PNPM_STORE_DIR` and `STATIC_HERMES_CACHE_DIR` to use persistent caches;
CI saves and restores both in the [external-consumer workflow](../.github/workflows/external-consumer.yml).

The check also installs only the packed builder's production dependencies with pnpm hoisting disabled
and runs its CLI without an ambient TypeScript installation. Run
`pnpm run test:external-consumer --build-cli-only` to check that packaging boundary without compiling
the starter components.

Ports come from 20000 to 30000, below the common default ephemeral-port range starts (32768 on Linux
and 49152 on macOS and Windows). Operating systems let that range be reconfigured, so this is not a
guarantee that they will never allocate one of these ports. Before returning a port, the harness
probes whether TCP and UDP loopback binds are available and avoids handing out the same port twice
within its process. Another process can still claim a port before Pumpkin binds it. If Pumpkin
reports `Address already in use` during startup, the harness retries up to three total starts, each
with newly selected ports.

## The server binary

The release is pinned in [`pumpkin-version.ts`](../tools/test-harness/src/pumpkin-version.ts), and its plugin ABI should match
the WIT ABI carried by `@pumpkin-plugins/pumpkin-api` in `pnpm-workspace.yaml`. Which binary runs:

1. `PUMPKIN_BIN`, if set.
2. Otherwise the pinned release, downloaded once into `.cache/pumpkin` and verified against the
   release's `checksums.sha256`.

| Variable | Effect |
| --- | --- |
| `PUMPKIN_BIN` | Use this binary instead of downloading |
| `PUMPKIN_CACHE_DIR` | Where downloaded binaries are cached |
| `PUMPKIN_KEEP_DIR=1` | Keep each test server directory for inspection |
| `PUMPKIN_TEST_LOG_DIR` | Save each test server's full log here |
