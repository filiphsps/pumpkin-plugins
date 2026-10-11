---
navigation:
    category: Plugin development
---

# Building

## The build tool

`pumpkin-plugins-build` (`tools/build`) turns a plugin into a `.wasm` component. It is configured
by the `pumpkinPlugin` key in each plugin's `package.json`:

```json
"pumpkinPlugin": { "entry": "src/plugin.ts", "output": "build/my-plugin.wasm", "wasi": [] }
```

It uses the API code and WIT selected by `pumpkin-api-targets.json` (the default release keeps the
`catalog:` dependency in `pnpm-workspace.yaml`, paired with its pinned Pumpkin server), esbuild and the
Wasmtime 48 CLI fork of `componentize-qjs`. The fork is needed because the upstream Wasmtime 47 CLI
fails to link the WASI HTTP types used by plugins. The pinned release's own build script uses a
componentizer that produces 55 MB plugins and can't run the WASI socket code.

| Command | Result |
| --- | --- |
| `pumpkin-plugins-build` | `build/<plugin>.wasm`, with the WIT it was built from in `build/wit/` (a copy, since the WASI imports are added) |
| `pumpkin-plugins-build --types-only` | Guest types in `build/types/` for `tsc` and your editor |

Types go to a separate directory so `build` and `typecheck` can run in parallel without touching the
same files. Run `pnpm typecheck` once after a fresh checkout so your editor finds the types.
The shared `plugin-kit` package does the same for its own source, generating declarations for its
filesystem imports in its ignored `build/types/` directory.

## API targets

`pumpkin-api-targets.json` records named API/WIT/server tuples. `release` is the default; `nightly`
is a pinned compatibility snapshot. Set `PUMPKIN_API_TARGET` for root commands:

```sh
PUMPKIN_API_TARGET=nightly pnpm typecheck
PUMPKIN_API_TARGET=nightly pnpm build
PUMPKIN_API_TARGET=nightly pnpm test:integration
```

The root task runner resolves Git sources at their full commits and caches them under
`.cache/api-sources`. It sets source paths and content hashes before invoking Turbo. API imports
use that source in esbuild and through a generated `build/types/api.ts` forwarding module in
TypeScript. Git checkouts that omit the API's referenced generated bindings are copied to
`.cache/api-prepared` and given declarations from the selected WIT; local source trees are never
modified. The generated WIT bindings are listed first in `tsconfig.json` so their `bigint`
declarations take precedence over the API package's bundled declarations.

Use one target at a time in a checkout: targets share `build/**`. CI matrix jobs have separate
checkouts. `pnpm package` requires `release` and rejects local API/WIT overrides; CI signing and release artifacts use that target.

For local API changes, set `PUMPKIN_API_DIR` to the package root. `PUMPKIN_WIT_DIR` points directly
to the WIT folder containing `plugin.wit` and can select a separate host checkout:

```sh
PUMPKIN_API_DIR=/path/to/pumpkin-api-ts \
PUMPKIN_WIT_DIR=/path/to/Pumpkin/crates/pumpkin-plugin-wit/v0.1 \
PUMPKIN_API_TARGET=nightly pnpm build
```

Root commands hash the local files on every invocation, including uncommitted changes. Direct
`pnpm exec turbo run` calls with local overrides must supply updated `PUMPKIN_API_REVISION` and
`PUMPKIN_WIT_REVISION` values or use `--force` to bypass cached task results. Package-local build
commands run directly and do not use Turbo's cache.

To add another release line, add a named profile and optionally include it in `compatibility`.
Profiles require full Git commits for API, WIT, and server, plus server platform digests or a stable
release's `checksums.sha256`. A profile with `api.installedVersion` uses the installed catalog
package and verifies its version; other profiles fetch their API source. `wit.installedPath` selects a WIT folder in the installed catalog
package independently of any API code override; without it the WIT repository/ref/path is resolved independently. API source and WIT are
independent: use the pinned server's embedded WIT when the standalone WIT repo lags behind it.
Advance nightly by reviewing and changing the complete tuple, then run both profiles' typechecks,
builds, and real-server suites. The `nightly` download URL is rolling; if upstream replaces the
binary, a digest mismatch fails rather than accepting the new ABI. Refresh the profile after
verifying its new source/binary pairing.

A downstream `pumpkin-api-ts` fork fits the same repository/ref fields. Keep upstreamable patches
as isolated commits or branches for upstream PRs, and local extensions as separate downstream
commits. Retain the upstream remote, sync it regularly, and remove equivalent downstream patches
when accepted upstream. Publish immutable commit-addressed fork artifacts if distributing packages;
the upstream rolling `CI` tarball deletes old assets and is unsuitable for durable pins.

## Runtime caveats

Plugins run on QuickJS inside the server's WebAssembly runtime:

- There is no global `TextEncoder`, `TextDecoder` or `fetch`. `fflate` provides `strToU8` and `strFromU8`. Plugins that need HTTP can import `wasi:http` by declaring the `http` capability; the update-check tool already does this.
- WIT `u64`/`s64` values are JavaScript `bigint` in both directions. Keep generated `bigint` types;
  convert explicitly to `number` only when the value is within JavaScript's safe integer range.
- Scheduler delays and periods are `u64` (`bigint`); handler and task IDs are `u32` (`number`).
  The plugin-kit scheduler helpers accept safe integer tick counts and pass them as `BigInt`.
- Plugins that request permissions are prompted for on the server console the first time they
  load. Hot reload can't prompt and denies them, so the first load needs a restart.
- Two builds of identical source produce different bytes. Anything that signs or uploads a build
  must use the artifact from the build job, never a rebuild.

## Turborepo

Tasks are defined in `turbo.json` and run with the root scripts (`pnpm build`, `pnpm typecheck`,
`pnpm test`, `pnpm test:integration`, `pnpm readme`, `pnpm package`):

| Task | Notes |
| --- | --- |
| `transit` | Does nothing; it carries a package's dependencies' hashes (see below) |
| `build` | Caches `build/**` except `build/types/**` |
| `typecheck` | Caches the generated `build/types/**`, so a cache hit restores them |
| `test` | Cached on inputs only |
| `test:integration` | Depends on `build`, never cached (it starts a real server) |
| `readme`, `readme:check` | Never cached, they write or inspect files |

Run one plugin with `pnpm exec turbo run build --filter=@pumpkin-plugins/<folder>`.

## Run all plugins on Pumpkin

Run `pnpm dev` to build every plugin and start the server paired with the default API profile.
Run `pnpm dev --nightly`, `pnpm dev:nightly`, or `pnpm dev --api-target nightly` to select the pinned
nightly API/WIT/server tuple. Other configured profile names work with `--api-target` or
`PUMPKIN_API_TARGET`. Binaries use the same resolver and checksum verification as integration tests.

Run `pnpm dev:no-hot-reload` to build once with plugin hot reload and watchers disabled. Add
`--nightly` or run `pnpm dev:nightly:no-hot-reload` for the nightly tuple. Restart after changing a
local API/WIT checkout: Turbo watches workspace plugin sources. Watch builds bypass task caches to
avoid reusing artifacts after API source changes during a running session.

The dev server lives in `.cache/pumpkin-dev`, so its world and settings remain between runs. Each
command sets Pumpkin's plugin hot reload to match the selected mode. In hot-reload mode, `pnpm dev`
uses `turbo watch` to rebuild plugins as workspace packages change and copies each completed `.wasm`
into the server's `plugins/` directory. This copy is needed because Pumpkin watches that directory,
while build outputs live under each package. A file linked to a build output would not notify Pumpkin
when the target changes. Automatic Market update checks are disabled for these development builds.
Reloading plugins that request permissions still requires granting permissions on their initial load.

Set `PUMPKIN_BIN` to use a local server binary instead of downloading the selected profile's server. Set
`PUMPKIN_CACHE_DIR` to change the binary cache directory. To reset the dev server's world, config and
plugins, stop the server and remove `.cache/pumpkin-dev`.

The build tool and test harness `typecheck` tasks run `tsc --noEmit`, so their package-level Turbo
configurations declare no outputs. Plugin typechecks keep the root `build/types/**` outputs because
they generate guest declarations needed by builds and editors.

Things to know when changing `turbo.json`:

- **Cache invalidation.** The workspace packages are used as source (their `exports` point at
  `src/`), so nothing is built in between and Turborepo has no reason to look at a dependency's
  files. The `transit` task is the fix from the Turborepo docs ("transit nodes"): it has no script
  and depends on `^transit`, and `build`, `typecheck` and `test` depend on it, so a change in any
  package a package depends on (including `devDependencies` such as `tools/build`, whose
  `wasi-wit.lock.json` and `src/` decide what a plugin is built from) invalidates exactly its
  dependents. New tools need nothing added, as long as a plugin lists them in its `package.json`.
  `globalDependencies` covers shared root inputs: `tsconfig.base.json`, `pnpm-workspace.yaml`,
  `pumpkin-api-targets.json`, and the shared target resolver. The lockfile and the root `package.json` invalidate
  everything, and so do the packages the root `package.json` depends on (`tools/docs` and
  `tools/signing`), because Turborepo treats those as global.
- **Environment variables.** Turbo's strict mode requires declaring every task input. Build and
  typecheck keys include `PUMPKIN_API_TARGET`, `PUMPKIN_API_DIR`, `PUMPKIN_API_ENTRY`, `PUMPKIN_WIT_DIR`,
  `PUMPKIN_API_REVISION`, and `PUMPKIN_WIT_REVISION`; integration receives the same selection.
  Root commands compute the revision hashes before task caching. Server/cache/log overrides are
  passed through to uncached server tasks. `TMPDIR` is not passed through.
- **`^` dependencies need a task the root doesn't have.** The root scripts share names with tasks
  (`"build": "turbo run build"`), so `dependsOn: ["^build"]` would make the root package a
  dependency of itself and fail or loop. `transit` is not a root script, which is why it can use
  `^transit`. Don't add a root script of that name. See the Turborepo docs page "Missing root task
  in turbo.json".
- **Linting runs outside Turborepo.** `pnpm lint` calls Biome and ESLint directly. Both are fast,
  so caching them wouldn't gain anything.
- **`agentGuidance` is off.** By default Turborepo writes an `AGENTS.md` when it detects an AI
  agent and re-adds it if it is deleted. `"agentGuidance": false` is the opt-out.
- **Package manager.** Declared with `devEngines.packageManager` in the root `package.json`, which
  Turborepo, pnpm and `pnpm/action-setup` all read.
- **Remote cache** isn't configured. CI caches `.turbo` with `actions/cache`. Set `TURBO_TOKEN`
  and `TURBO_TEAM` to use a remote cache instead.

The installed Turborepo ships its own docs for the exact version: `docs/` inside the `turbo`
package (`node -p "require('path').dirname(require.resolve('turbo/package.json'))"` from the repo
root).
