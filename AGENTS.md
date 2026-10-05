# AGENTS.md

Notes for coding agents working in this repo. It's a pnpm and Turborepo monorepo of TypeScript plugins for
[Pumpkin](https://github.com/Pumpkin-MC/Pumpkin), compiled to WebAssembly components. The human docs are in
[docs/](docs/README.md). Read the page for the area you're changing before you change it. If the person you
work for tells you something different from this file, do what they say.

## Ground rules

- **Don't commit, push, tag, or open, comment on or review PRs and issues** unless the user asked for it in
  this conversation. Leave your work in the working tree and say what you changed. When asked to commit, stage
  only your own files, inspect the staged diff, and use a Conventional Commit message.
- The working tree can hold someone else's uncommitted work. Don't revert, stash, reformat or stage changes
  you didn't make, and don't run `git checkout`, `git restore`, `git reset` or `git clean` on them.
- Use pnpm only (`pnpm exec` for local binaries, `pnpm dlx` for one-offs). Versions are pinned exactly, and
  versions shared by several packages go in the `catalog:` of `pnpm-workspace.yaml`.
- Create plugins with `pnpm gen --args <folder> <PluginName> "<description>"`, never by hand. It registers the
  plugin for releases and writes metadata and READMEs that the checks require.

## Commands

| What | Command |
| --- | --- |
| Lint (Biome, then the JSDoc rule) | `pnpm lint`, `pnpm lint:fix` |
| Commit message against Conventional Commits, which CI lints on every PR | `pnpm lint:commits` |
| Typecheck. Run it once on a fresh checkout, since it generates the guest types | `pnpm typecheck` |
| Unit tests | `pnpm test` |
| Docs, package metadata and release config against the code | `pnpm check`, `pnpm readme:check` |
| One package | `pnpm exec turbo run typecheck test --filter=@pumpkin-plugins/<folder>` |
| Build, then run on a real Pumpkin server (slow) | `pnpm exec turbo run test:integration --filter=@pumpkin-plugins/<folder>` |
| Fast checks, scoped to what you changed (integration tests excluded) | `node .agents/hooks/check.mjs` |

## Things that will bite you

- **Plugins don't run on Node.** They run on QuickJS inside the server's WebAssembly runtime: there is no
  `fetch`, `TextEncoder` or `TextDecoder`, a `BigInt` passed to the host panics the guest (64-bit values are
  plain numbers), and the base `Plugin` class's scheduling helpers panic. The workarounds are in
  [Runtime caveats](docs/building.md#runtime-caveats). Node APIs are fine in tests, `tools/` and `scripts/`, but
  not in code a plugin bundles.
- **The plugin API is the pinned one**, not Pumpkin's `master` or what you remember: the WIT and types of the
  `@pumpkinmc/pumpkin-api-ts` version in the `catalog:`, which must match the server release in
  `tools/test-harness/src/pumpkin-version.ts`. Load the `pumpkin-plugin-api` skill before you call into the host.
- **Generated files.** Don't edit the README blocks between `<!-- docs:begin NAME -->` and
  `<!-- docs:end NAME -->`. They come from a plugin's `src/info.ts` and each `package.json`, so edit those and
  run `pnpm readme`. Also leave alone: `build/`, `dist/`, `pnpm-lock.yaml`, and the changelogs and
  `.release-please-manifest.json` that release-please owns.
- **Docs have to match the code.** A change that makes a doc wrong isn't finished. `pnpm check` fails on dead
  links, missing paths, unknown `pnpm` scripts and undocumented root scripts or CI jobs, in `docs/`, the READMEs,
  this file and `.agents/`. When you rename something, search `docs/` and the READMEs for the old name.
- **Exported code needs a JSDoc description** that says what it's for (`pnpm lint` checks it). Tags don't take
  `{types}`, and a `@param` must name a real parameter. See [JSDoc](docs/code-style.md#jsdoc).
- **Console log colors** should use `colorLogValue` from `@pumpkin-plugins/plugin-kit/logger` and follow
  [the documented palette and Pumpkin source references](docs/code-style.md#console-log-colors); don't add
  ANSI escape sequences directly at log call sites.
- **Every `package.json`** carries the same license, author, repository and funding fields, and a description of
  70 characters or fewer. `node scripts/package-metadata.mjs --fix` fills in all of it except the description.
- **Turborepo.** Don't use `^` in `dependsOn`, add new shared inputs to `globalDependencies`, and declare any
  environment variable a task reads. Keep `"agentGuidance": false`: it stops Turborepo from writing its own
  AGENTS.md. See [Turborepo](docs/building.md#turborepo); the installed version's own docs are in
  `node_modules/turbo/docs/`.
- **Releases come from commit messages.** Pull requests are rebase-merged and release-please reads every commit.
  A plugin releases for changes to its folder or bundled workspace dependencies. See
  [Merging](docs/ci-and-releases.md#merging).

## Writing code

- Keep files small, and group a plugin's `src/` by concern (`config/`, `commands/`, `platform/`). Pure logic
  takes its dependencies as arguments. Code that touches Pumpkin or WASI is a thin adapter behind an interface,
  so almost everything can be unit tested. Anything more than one plugin needs goes in a package in `tools/`. See
  [Structure](docs/code-style.md#structure).
- Unit tests (`*.test.ts`) sit beside the code and use the fakes from `@pumpkin-plugins/plugin-kit/testing`.
  Real-server tests (`*.itest.ts`) go in the package's `test/` folder. Build fixtures in code rather than
  committing binaries.
- Test behavior, including the failure paths. A bug fix comes with a test that fails without the fix. Don't
  write tests that only restate the implementation or check what the types already guarantee.
- Plugin config is declared as a schema with `@pumpkin-plugins/config`. The file, its validation, upgrades and
  docs all come from it ([Plugin config](docs/plugin-config.md)).
- Follow the code around you. Comment only what the code can't say. Write docs and messages in plain
  sentences, like the existing docs, without em dashes.

## Before you say you're done

1. Run `node .agents/hooks/check.mjs`. The optional OpenCode adapter in `.agents/hooks/opencode.mjs` runs the
   same checks only when it has been installed in that user's OpenCode configuration. A message starting with
   `[pumpkin-plugins checks]` is that run's report: fix the cause, not the check.
2. If you changed what a plugin does at runtime, run its integration tests. [Testing](docs/testing.md) explains
   how the server binary is selected and how to keep logs for failures.
3. Read your own diff: what each removed line did and where that went, the other callers of shared code you
   changed, and the docs that describe it.
4. Say what you ran, and what you couldn't check.

## Skills

Load these from `.agents/skills/` when the task matches:

| Skill | Use it when |
| --- | --- |
| `pumpkin-plugin-api` | Writing plugin code that calls the host: events, commands, scheduling, files, sockets |
