# AGENTS.md

This pnpm and Turborepo monorepo builds TypeScript plugins for
[Pumpkin](https://github.com/Pumpkin-MC/Pumpkin) as WebAssembly components. Plugins run on QuickJS,
not Node. Shared libraries and tooling live in `tools/`; plugins live in `packages/`.
User instructions take precedence over this file.

## Start here

- Inspect `git status --short` before editing. Preserve other people's changes. Don't revert, stash,
  reformat or stage their work, or run `git checkout`, `git restore`, `git reset` or `git clean` on it.
- Don't commit, push, tag, or open, comment on or review PRs and issues unless asked in this conversation.
  If asked to commit, stage only your files, inspect the staged diff, and use a Conventional Commit message.
- Use pnpm only: `pnpm exec` for local binaries and `pnpm dlx` for one-offs. Pin versions exactly;
  dependencies shared by packages go in the `catalog:` of `pnpm-workspace.yaml`.
- Read the relevant page in [docs](docs/README.md) and load matching skills below before changing an area.
  Follow nearby code; don't load every skill for every task.

## Task guidance

| Task | Skill to read | Documentation |
| --- | --- | --- |
| Create a plugin | [pumpkin-new-plugin](.agents/skills/pumpkin-new-plugin/SKILL.md) | [Creating a plugin](docs/creating-a-plugin.md) |
| Create a GitHub Action | [pumpkin-new-action](.agents/skills/pumpkin-new-action/SKILL.md) | [Creating an action](docs/creating-an-action.md) |
| Call Pumpkin or WASI, change permissions or lifecycle behavior | [pumpkin-plugin-api](.agents/skills/pumpkin-plugin-api/SKILL.md) | [Runtime caveats](docs/building.md#runtime-caveats) |
| Change settings, commands, metadata or generated READMEs | [pumpkin-plugin-contracts](.agents/skills/pumpkin-plugin-contracts/SKILL.md) | [Config](docs/plugin-config.md), [Plugin info](docs/plugin-info-and-readmes.md) |
| Add tests, choose affected suites, debug server failures | [pumpkin-testing](.agents/skills/pumpkin-testing/SKILL.md) | [Testing](docs/testing.md) |
| Change build or task orchestration | Read the docs directly | [Building](docs/building.md) |
| Change CI or release tooling | Read the docs directly | [CI and releases](docs/ci-and-releases.md) |
| Change agent guidance, skills or hooks | Read the docs directly | [Agent tooling](docs/agent-tooling.md) |

## Constraints that apply across tasks

- Guest code has no `fetch`, `TextEncoder` or `TextDecoder`; don't bundle Node APIs. Host 64-bit values
  are numbers, and passing `BigInt` panics. The SDK scheduling helpers also pass `BigInt`.
  Prefer the tested wrappers in `@pumpkin-plugins/plugin-kit`.
- Use the pinned API WIT and generated guest types, not Pumpkin master or remembered signatures.
  The API version in `pnpm-workspace.yaml` must match `tools/test-harness/src/pumpkin-version.ts`.
- Create plugins with `pnpm gen --args <folder> <PluginName> "<description>"`.
- Edit generated content at its source. README blocks come from `src/info.ts`, config and command
  declarations, and package metadata; refresh with `pnpm readme`. Don't hand-edit build output,
  `pnpm-lock.yaml`, changelogs or `.release-please-manifest.json`. Their owning tools may update them.
- Keep host and WASI adapters thin, behind interfaces. Pure logic takes dependencies as arguments.
  Share code needed by multiple plugins through `tools/`. See [Code style](docs/code-style.md).
- Exported code needs a JSDoc description; tags have no `{types}` and `@param` names must exist.
  Use `colorLogValue` from `@pumpkin-plugins/plugin-kit/logger` for console colors; follow the
  [palette](docs/code-style.md#console-log-colors).
- Declare plugin config with `@pumpkin-plugins/config`. Derive defaults, validation, upgrades and
  README content from its schema.
- Keep docs accurate. Search docs and READMEs for renamed concepts. Package descriptions are at most
  70 characters; `node scripts/package-metadata.mjs --fix` derives the shared metadata.
- For Turbo changes, preserve `agentGuidance: false`, declare task environment variables and shared
  inputs, and follow the [dependency and cache rules](docs/building.md#turborepo). `^transit` is valid;
  dependencies on root-script task names such as `^build` are not.

## Verify before finishing

1. Run `node .agents/hooks/check.mjs` from the repo root. It reads staged, unstaged and untracked files
   and runs scoped lint, typechecks, unit and script tests, repo checks and README checks without fixes.
   Use `--plan` to inspect the scope, or explicit file arguments to check only your work when the tree
   contains unrelated changes. Apply formatting fixes only to files you own.
2. Runtime changes also need affected integration tests. The fast runner never starts Pumpkin.
   Use the testing skill to include shared-library dependents and cross-plugin scenarios.
3. Read your diff, shared callers and affected docs. Test behavior and failure paths; a bug fix needs
   a regression test. Unit tests sit beside code; server tests go in `test/`; generate fixtures in code.
4. Report what changed, what ran, and anything that failed or could not be checked. Don't claim success
   based only on a hook being configured. Automatic checks may be disabled, untrusted or unsupported.

| Command | Use |
| --- | --- |
| `pnpm typecheck` | Generate guest types and check all packages on a fresh checkout |
| `pnpm exec turbo run typecheck test --filter=...@pumpkin-plugins/<folder> --output-logs=errors-only` | Check a package and its dependents |
| `pnpm exec turbo run test:integration --filter=@pumpkin-plugins/<folder> --output-logs=errors-only` | Build and test on a real server |
| `pnpm lint`, `pnpm lint:fix` | Whole-repo lint or explicit fixes, when appropriate for the working tree |
| `pnpm test:scripts` | Repo script and hook regression tests |
| `pnpm check`, `pnpm readme:check` | Validate metadata, releases, docs and generated content |
| `pnpm lint:commits` | Validate commit messages when commits are requested |

See [Agent tooling](docs/agent-tooling.md) for hook loading, limitations and diagnostics.
