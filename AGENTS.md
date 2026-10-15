# `pumpkin-plugins`

`pumpkin-plugins` is a collection of plugins for PumpkinMC and an extensive developer toolkit for
building, testing, documenting, and releasing them. Plugin packages live in `packages/`; shared
libraries and developer tools live in `tools/`, re-usable GitHub actions live in `actions/`.

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
  (writing, reviewing, debugging, or testing).
- Before changing an area, read its relevant guide from [docs/README.md](docs/README.md) and load
  any skill whose description matches the task. Project skill files live in `.agents/skills/`.

When editing `turbo.json`, keep `agentGuidance: false`, declare task environment variables and shared
inputs, and follow the dependency and cache rules in [Building](docs/building.md#turborepo).

## Repository rules

- For runtime changes, use the pinned API WIT and generated guest types. Keep the API version in
  `pnpm-workspace.yaml` aligned with `tools/test-harness/src/pumpkin-version.ts`; follow the
  [runtime caveats](docs/building.md#runtime-caveats).
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
- Use tests to protect meaningful behavior and regression risks; do not optimize test counts or
  coverage for their own sake. Optimize effort, not rigor: trace dependencies, assess impact and
  validate the change.

## Verify before finishing

1. The configured completion hook checks your scoped changes and blocks completion on failure.
   Resolve any reported failures before finishing. See [Agent tooling](docs/agent-tooling.md) for its
   scope, limitations and diagnostics.
2. Runtime changes also need affected integration tests against a real Pumpkin server; the fast
   runner does not start one. Use the testing skill to include shared-library dependents and
   cross-plugin scenarios.
3. Trace affected callers, workspace dependents and runtime variants. Read your diff and affected
   docs; check behavior and failure paths. Bug fixes need regression coverage. Unit tests sit beside
   code; server tests go in `test/`; generate fixtures in code.
4. Report what changed, what checks ran, and anything that failed or could not be checked. A
   configured automatic check is not evidence that it passed.

## Agent skills

### Issue tracker

Issues and specs live in this repo’s GitHub Issues; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

`needs-triage` maps to `status: needs triage`; `needs-info` to `status: needs info`; `ready-for-agent` and `ready-for-human` use their default names; `wontfix` maps to `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

single-context. See `docs/agents/domain.md`.
