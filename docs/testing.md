---
navigation:
    category: Plugin development
title: "Testing"
description: "Unit tests and integration tests against a real Pumpkin server"
---

# Testing

This guide explains how to run the two kinds of tests and what the harness does. Which kind to write
for a change, and when, is set by the repository's
[testing policy](https://github.com/filiphsps/pumpkin-plugins/blob/master/AGENTS.md#testing-policy).

Plugin packages use `definePluginVitestConfig()` from `@pumpkin-plugins/test-harness/vitest` to
define two Vitest projects:

| Project | Files | Runs |
| --- | --- | --- |
| `unit` | `src/**/*.test.ts` | `pnpm test`. No server needed. |
| `integration` | `test/**/*.itest.ts` | `pnpm test:integration`. Builds first, then runs against a real Pumpkin. Test files and up to four package suites run concurrently. |

From the repository root, `pnpm coverage` runs workspace coverage suites, including the creator's
CLI integration tests, then repository-script, agent-hook and GitHub Action tests. Vitest writes
each package's `coverage/lcov.info`. An outer c8 collector also measures Node child processes,
including documentation and build CLIs, and writes `coverage/process/lcov.info`. Codecov merges
these reports so subprocess execution contributes alongside in-process tests. Coverage tasks run
fresh because cached reports cannot supply their child processes' raw V8 data. The command runs
every suite even after one fails and exits with the first failure's code; Turborepo skips only a
package whose own dependencies failed to build.

CI runs each package's `test:coverage` script, so add one to every package with unit tests.
`scripts/workflows.test.mjs` fails when a package outside `extensions/` has none, or when the Test
job's coverage evidence leaves out the package's `coverage/lcov.info`.

The existing `codecov/project` gate covers tooling: `tools/`, `scripts/`, `actions/` and
`.agents/hooks/`. It compares against the base commit with a 1 percentage-point tolerance.
CI runs the complete coverage job for action-only changes too, so a partial action-matrix upload
cannot stand in for the full tooling report.
The separate `guest` status covers `packages/` and is informational: its Node coverage does not
measure plugin execution inside WASM. Shared libraries under `tools/` remain in the tooling gate;
their coverage describes measured Node execution, not their execution inside a server.

Unexecuted source remains in both collectors' denominators. The process collector covers the
host-side source and CLI directories; it excludes test/spec files, declarations, test fixtures,
snapshots and downloaded third-party caches. It does not pretend that Node instrumentation measures
compiled WASM. Add tests for uncovered failure scenarios, rather than to raise the reported percentage.

Open `coverage/process/index.html` to inspect process coverage. `coverage/process/run.json` records
the revision, Node version, repeat command, command exit statuses and report SHA-256 hashes. CI
retains these reports and regression evidence in the `coverage-evidence` artifact, including on
failure. Keep scenario inputs and observable outputs with new E2E evidence so another person can
repeat and verify it.

The coverage collector's regression scenario checks failures that ordinary behavior suites cannot
detect: lost child-process hits, dropped unexecuted TypeScript, stale hits from an earlier run,
third-party caches counted as repository source and swallowed nonzero process exits.
Run it with `pnpm exec node --test scripts/coverage.test.mjs`;
its evidence is written to `coverage/verification/process-coverage/`.

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
even if your shell uses a stricter log filter. Pass `logLevel: 'debug'` to `startPumpkin` when a test
waits on a plugin's debug logs:

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
plugin ABI should match the WIT pinned in the API package's
[`wit.lock.json`](../tools/pumpkin-api/wit.lock.json). The harness chooses the server binary in this order:

1. `PUMPKIN_BIN`, if set.
2. If `PUMPKIN_BIN` isn't set, the pinned release, downloaded once into `.cache/pumpkin`. The download
   and the cached file are checked against the SHA-256 pinned beside the release, so a cached binary
   needs no network. Update those checksums when you change the release.

| Variable | Effect |
| --- | --- |
| `PUMPKIN_BIN` | Use this binary instead of downloading |
| `PUMPKIN_CACHE_DIR` | Where downloaded binaries are cached |
| `PUMPKIN_KEEP_DIR=1` | Keep each test server directory for inspection |
| `PUMPKIN_TEST_LOG_DIR` | Save each test server's full log here |
