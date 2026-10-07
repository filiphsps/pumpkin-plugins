# AGENTS.md

This pnpm and Turborepo monorepo builds TypeScript plugins for
[Pumpkin](https://github.com/Pumpkin-MC/Pumpkin) as WebAssembly components. Plugins run in
Pumpkin's QuickJS/WASI runtime. Plugins live in `packages/`; shared libraries and tooling live in
`tools/`. User instructions take precedence over this file.

## Before you work

- Inspect `git status --short` before editing and preserve existing work. Never stash, revert, stage
  or reformat someone else's changes; avoid `git checkout`, `git restore`, `git reset` and `git clean`
  when they could affect that work.
- Keep repository changes local until requested. Commit, push, tag, or create, change or review PRs
  and issues only on the user's request. When asked to commit, stage only your files, inspect the
  staged diff and use a Conventional Commit message.
- Use pnpm: `pnpm exec` for local binaries and `pnpm dlx` for one-offs. Pin dependency versions;
  put dependencies shared by packages in the `catalog:` of `pnpm-workspace.yaml`.
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

## Verify before finishing

1. Run `node .agents/hooks/check.mjs` from the repo root. Use `--plan` to inspect its scope; pass
   explicit file paths when unrelated changes are present. The runner checks without applying fixes.
   See [Agent tooling](docs/agent-tooling.md) for its scope, limitations and diagnostics.
2. Runtime changes also need affected integration tests against a real Pumpkin server; the fast
   runner does not start one. Use the testing skill to include shared-library dependents and
   cross-plugin scenarios.
3. Read your diff, shared callers and affected docs. Check behavior and failure paths; bug fixes need
   regression coverage. Unit tests sit beside code; server tests go in `test/`; generate fixtures in
   code.
4. Report what changed, what checks ran, and anything that failed or could not be checked. A
   configured automatic check is not evidence that it passed.
