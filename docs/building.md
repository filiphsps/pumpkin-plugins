# Building

## The build tool

`pumpkin-plugins-build` (`tools/build`) turns a plugin into a `.wasm` component. It is configured
by the `pumpkinPlugin` key in each plugin's `package.json`:

```json
"pumpkinPlugin": { "entry": "src/plugin.ts", "output": "build/my-plugin.wasm", "wasi": [] }
```

It uses the WIT from the pinned `@pumpkinmc/pumpkin-api-ts` (the version is the `catalog:` entry in
`pnpm-workspace.yaml`, and it must match the Pumpkin server's plugin ABI) and the same bundler and
componentizer as upstream's `master`. It exists because the pinned release's own build script
uses a componentizer that produces 55 MB plugins and can't run the WASI socket code.

| Command | Result |
| --- | --- |
| `pumpkin-plugins-build` | `build/<plugin>.wasm`, with the WIT it was built from in `build/wit/` (a copy, since the WASI imports are added) |
| `pumpkin-plugins-build --types-only` | Guest types in `build/types/` for `tsc` and your editor |

Types go to a separate directory so `build` and `typecheck` can run in parallel without touching the
same files. Run `pnpm typecheck` once after a fresh checkout so your editor finds the types.

`PUMPKIN_API_DIR` points the tool at a different `pumpkin-api-ts` checkout.

A plugin is built against the API's WIT as `pumpkin-api-ts` ships it, plus the WASI imports it asks for.

`pumpkin-api-ts` ships its own declarations for `pumpkin:plugin/*`, and TypeScript keeps the first
declaration of a module it sees. So a plugin's `tsconfig.json` lists the generated
`build/types/bindings/**/*.d.ts` before `src` in `include` (the generator's template does), which
makes the generated declarations win (they use `number` for 64-bit values).

## Runtime caveats

Plugins run on QuickJS inside the server's WebAssembly runtime:

- There is no `TextEncoder`, `TextDecoder` or `fetch`. `fflate` provides `strToU8` and `strFromU8`.
- `u64`/`s64` values are plain JS numbers in both directions. Passing a `BigInt` panics the guest,
  so the build rewrites the generated types from `bigint` to `number`.
- The base `Plugin` class's `scheduleDelayedTask` and `scheduleRepeatingTask` pass `BigInt`, so
  they panic. Call `pumpkin:plugin/scheduler` directly with numbers and export your own
  `handleTask` that handles your task ids and falls back to the API's. A local export takes
  precedence over `export *`.
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

Things to know when changing `turbo.json`:

- **Cache invalidation.** The workspace packages are used as source (their `exports` point at
  `src/`), so nothing is built in between and Turborepo has no reason to look at a dependency's
  files. The `transit` task is the fix from the Turborepo docs ("transit nodes"): it has no script
  and depends on `^transit`, and `build`, `typecheck` and `test` depend on it, so a change in any
  package a package depends on (including `devDependencies` such as `tools/build`, whose
  `wasi-wit.lock.json` and `src/` decide what a plugin is built from) invalidates exactly its
  dependents. New tools need nothing added, as long as a plugin lists them in its `package.json`.
  `globalDependencies` is only for inputs outside any package: `tsconfig.base.json` and
  `pnpm-workspace.yaml` (the API version). The lockfile and the root `package.json` invalidate
  everything, and so do the packages the root `package.json` depends on (`tools/docs` and
  `tools/signing`), because Turborepo treats those as global.
- **Environment variables.** Turborepo runs tasks in strict env mode, so a variable a task reads
  has to be declared, or it never reaches the task. `PUMPKIN_API_DIR` (another `pumpkin-api-ts`
  checkout) changes what `build` and `typecheck` produce, so it is in their `env` and part of their
  cache key. The `PUMPKIN_*` variables the test harness and the build's download cache read are in
  `globalPassThroughEnv`; they don't affect cache keys, which is fine because they only say where
  things are or what to run in uncached tasks. `TMPDIR` isn't passed through, so tests run under Turborepo create their
  temp directories in `/tmp`.
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
