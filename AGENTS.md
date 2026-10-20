# `pumpkin-plugins`

`pumpkin-plugins` is a collection of plugins for PumpkinMC and an extensive developer toolkit for
building, testing, documenting, and releasing them. Plugin packages live in `packages/`; shared
libraries and developer tools live in `tools/`, re-usable GitHub actions live in `actions/`.

## Project goals

The project exists to make useful, reliable Pumpkin plugins easy to build, test, release, and run.

- Players and server operators are co-primary beneficiaries. Plugin authors, including authors
  building in standalone repositories, are a core audience; maintainability keeps the project able
  to serve them.
- Plugins are the direct products. Tools, reusable actions, public npm packages, and extensions
  belong when they materially support plugin quality, authoring, or maintenance. Minecraft adjacency
  or personal usefulness alone is not enough.
- Treat each intentionally published npm package for external use as a product with compatibility
  and maintenance commitments. When package behavior is affected, validate its packed artifact at
  the consumer seam.

## Questions are read-only

- A question is a request for an answer, not for changes. If the message opens with "how hard would it be", "what are your thoughts", "why does", "should we", "is it possible", or otherwise asks rather than instructs: answer it, and do not edit files.
- If the answer to the question is obvious and the change is trivially easy, still answer first and then offer to change it.

## Match effort and orchestration to the task

- Do not spawn subagents (or multi-agent fleets) for work a single agent can finish in one pass. Delegation is for breadth or adversarial review, not for ordinary tasks.
- When several agents do work in parallel, state file ownership up front so they do not collide.

## Before you work

- At the start of every task in this repository, read [Commit discipline](.agents/skills/commit-discipline/SKILL.md).
- Inspect `git status --short` before editing and preserve existing work. Never stash, revert, stage
  or reformat someone else's changes; avoid `git checkout`, `git restore`, `git reset` and `git clean`
  when they could affect that work.
- Keep repository changes local until requested. For requested feature work, make small local commits
  as slices are completed, following [Commit discipline](.agents/skills/commit-discipline/SKILL.md).
  Push, tag, or create, change or review PRs and issues only on the user's request. Stage only your
  files, inspect the staged diff, and use a Conventional Commit message.
- Use pnpm: `pnpm exec` for local binaries and `pnpm dlx` for one-offs. Pin dependency versions;
  put dependencies shared by packages in the `catalog:` of `pnpm-workspace.yaml`.
- For every code-writing task, read [JSDoc TypeScript Documentation](.agents/skills/jsdoc-typescript-docs/SKILL.md)
  before editing and follow the repo-specific JSDoc contract in [Code style](docs/code-style.md).
- Before any work on a plugin in [packages](packages/) or a shared plugin library in [tools](tools/)
  (writing, reviewing, debugging, or testing), read the
  [Pumpkin plugin API skill](.agents/skills/pumpkin-plugin-api/SKILL.md). For test work, also read
  the [Pumpkin testing skill](.agents/skills/pumpkin-testing/SKILL.md).
- Before changing an area, read its relevant guide from [docs/README.md](docs/README.md) and load
  any skill whose description matches the task. Project skill files live in `.agents/skills/`.

When editing `turbo.json`, keep `agentGuidance: false`, declare task environment variables and shared
inputs, and follow the dependency and cache rules in [Building](docs/building.md#turborepo).

## Repository rules

- For runtime changes, use the pinned API WIT and generated guest types. Keep the WIT pin in
  `tools/pumpkin-api/wit.lock.json` and the API version in `tools/pumpkin-api/package.json` aligned
  with the server release in `tools/test-harness/src/pumpkin-version.ts`. Make compatibility
  claims only for pinned WIT and Pumpkin version pairs verified together; treat nightly compatibility
  as exploratory until verified. Static Hermes is primary; QuickJS is supported with engine-specific
  caveats and no parity promise. See [runtime caveats](docs/building.md#runtime-caveats) and
  [Plugin API runtime support](docs/plugin-api/abi-and-runtime.md).
- Treat generated files as output: edit their source and run the owning generator (usually
  `pnpm readme`). Let owning tools update `pnpm-lock.yaml`, changelogs,
  `.release-please-manifest.json` and build output.
- Do not hardcode values that can be inferred from the codebase. Derive them from their source of
  truth (manifests, config, declarations or repository layout) so duplicated lists cannot drift.

## Design principles

- Understand the real constraint and honor the request. Choose the simplest durable design that
  fully meets current requirements; avoid unnecessary scope, speculative machinery and stopgaps
  that will need replacement.
- Keep components modular and concerns clearly separated. Prefer established, well-maintained
  libraries when they reduce overall complexity or improve reliability.
- Plugins should provide useful intended behavior for both Java and Bedrock where the pinned
  Pumpkin API supports it. Feature parity isn't required. Document exceptions for mod-specific
  purposes or concrete Pumpkin API/client limitations, and treat client-unverified behavior as
  unverified. See [Creating a plugin](docs/creating-a-plugin.md#choose-edition-support).
- Use tests to protect meaningful behavior and regression risks; do not optimize test counts or
  coverage for their own sake. Optimize effort, not rigor: trace dependencies, assess impact and
  validate the change.

## Testing policy

- Prefer end-to-end tests against a real Pumpkin server or a CLI process. Use them to show that a
  feature works, and keep the command, inputs and outputs so someone else can repeat and verify the
  result.
- Write unit tests for logic you can run in isolation, such as parsers, ordering and state machines.
  Write them first: list the ways the logic can fail, write tests for those, then write the code.
- Add tests only for failure scenarios existing coverage misses, and assert observable outcomes.
  Every bug fix needs a regression test that fails without the fix.
- Unit tests (`*.test.ts`) sit beside the code they cover; real-server tests (`*.itest.ts`) go in the
  package's `test/` directory. Generate fixtures in code.
- Collect and merge coverage from CLI/process E2E tests where instrumentation supports it. Keep
  tooling coverage gated and plugin guest coverage informational until WASM execution is measurable.
  Keep unexecuted production source in coverage reports; never exclude it to raise the percentage.

## Verify before finishing

1. The configured completion hook checks your scoped changes and blocks completion on failure.
   Resolve any reported failures before finishing. See [Agent tooling](docs/agent-tooling.md) for its
   scope, limitations and diagnostics.
2. Runtime changes also need affected integration tests against a real Pumpkin server; the fast
   runner does not start one. Use the testing skill to include shared-library dependents and
   cross-plugin scenarios.
3. For public consumer packages, validate the packed artifact in a standalone consumer when package
   behavior is affected. Workspace-only resolution doesn't establish the published contract; see
   [Testing](docs/testing.md#packed-standalone-consumer).
4. Trace affected callers, workspace dependents and runtime variants. Read your diff and affected
   docs; check behavior and failure paths, with tests that follow the testing policy.
5. Report what changed, what checks ran, and anything that failed or could not be checked. A
   configured automatic check is not evidence that it passed.

## Agent skills

### Issue tracker

Issues and specs live in this repo’s GitHub Issues; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

`needs-triage` maps to `status: needs triage`; `needs-info` to `status: needs info`; `ready-for-agent` and `ready-for-human` use their default names; `wontfix` maps to `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

The repository is an ecosystem umbrella with multiple domain contexts; the root glossary covers only
the Pumpkin Plugin API. See [Agent domain docs](docs/agents/domain.md) and [GLOSSARY-MAP.md](GLOSSARY-MAP.md).
