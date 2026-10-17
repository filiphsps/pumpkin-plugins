---
navigation:
    category: Plugin development
title: "Testing"
description: "Unit tests and integration tests against a real Pumpkin server"
---

# Testing

Plugin packages use `definePluginVitestConfig()` from `@pumpkin-plugins/test-harness/vitest` to
define two Vitest projects:

| Project | Files | Runs |
| --- | --- | --- |
| `unit` | `src/**/*.test.ts` | `pnpm test`. No server needed. |
| `integration` | `test/**/*.itest.ts` | `pnpm test:integration`. Builds first, then runs against a real Pumpkin. Test files and up to four package suites run concurrently. |

From the repository root, `pnpm coverage` runs every package's unit tests with Vitest's V8 coverage
provider, then runs the GitHub Action tests with c8. Each package writes an LCOV report to
`coverage/lcov.info`; action coverage is written to `coverage/actions/lcov.info`. CI uploads these
reports to Codecov. Coverage measures source files executed in the test process. Integration tests
check compiled WASM behavior, but they don't collect coverage from guest code.

To run one plugin's integration tests, replace `my-plugin` with the package's folder name:

```sh
pnpm turbo run test:integration --filter=@pumpkin-plugins/my-plugin
```

To run only changed packages and their dependents, compare them with the base branch. For example:
`pnpm turbo run test:integration --filter='...[origin/master]'`.

CI selects real-server suites for changed plugins and the workspace packages their build or
integration tests depend on, along with those packages' dependents. Changes to workspace-wide build
configuration or shared integration setup run every suite. Unrelated script and workflow changes
skip the integration job.

## Integration tests

`@pumpkin-plugins/test-harness` starts a real server for each test file. It uses a temporary
directory and free ports, and turns off plugin permission prompts and telemetry. The harness sets
`RUST_LOG=info` for Pumpkin so readiness checks and assertions can see startup and plugin INFO logs,
even if your shell uses a stricter log filter:

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

If a test run crashes, the harness kills its servers on exit so they don't keep holding ports. Each
test file owns its server instances and temporary directories, which lets Vitest run files in
parallel. The root command runs up to four package suites at once to reduce startup time without
starting all package servers together. On hosted runners, CI limits this to two package suites at a
time and reuses the WASM files from its build job, so the integration job doesn't build plugins
again.

The harness chooses ports from 20000 to 30000, below the common default ephemeral-port ranges, which
start at 32768 on Linux and 49152 on macOS and Windows. Operating systems can reconfigure those
ranges, so they may still allocate a port from this range. Before returning a port, the harness
checks that TCP and UDP loopback binds are available and avoids handing out the same port twice
within its process. Another process could still claim a port before Pumpkin binds it. If startup
reports `Address already in use`, the harness tries up to three starts in total, choosing new ports
each time.

## Packed standalone consumer

Run `pnpm run test:external-consumer` with the Node, pnpm, and host-tool versions listed in the
[Static Hermes Runtime guide](../tools/static-hermes-runtime/README.md). This check packs the
internal production dependencies and installs them from a temporary local registry. It then runs
the packed creator binary and both real `pnpm create pumpkin-plugin` language flows, and typechecks
and builds both starter projects. By default, the check uses a temporary pnpm store and Static
Hermes cache outside the consumer project, then removes the temporary project when it finishes. To
keep caches between runs, set `PUMPKIN_EXTERNAL_CONSUMER_PNPM_STORE_DIR` and
`STATIC_HERMES_CACHE_DIR`. CI saves and restores both in the
[external-consumer workflow](../.github/workflows/external-consumer.yml).

The check also installs only the packed builder's production dependencies with pnpm hoisting
disabled, then runs its CLI without an ambient TypeScript installation. To check that packaging
boundary without compiling the starter projects, run
`pnpm run test:external-consumer --build-cli-only`.

## The server binary

The release is pinned in [`pumpkin-version.ts`](../tools/test-harness/src/pumpkin-version.ts). Its
plugin ABI should match the WIT ABI carried by `@pumpkin-plugins/pumpkin-api` in
`pnpm-workspace.yaml`. The harness chooses the server binary in this order:

1. `PUMPKIN_BIN`, if set.
2. If `PUMPKIN_BIN` isn't set, the pinned release, downloaded once into `.cache/pumpkin` and checked
   against the release's `checksums.sha256`.

| Variable | Effect |
| --- | --- |
| `PUMPKIN_BIN` | Use this binary instead of downloading |
| `PUMPKIN_CACHE_DIR` | Where downloaded binaries are cached |
| `PUMPKIN_KEEP_DIR=1` | Keep each test server directory for inspection |
| `PUMPKIN_TEST_LOG_DIR` | Save each test server's full log here |
