---
navigation:
    category: Repository maintenance
title: "Agent tooling"
description: "Agent guidance, skills, portable hooks and scoped check diagnostics"
---

# Agent tooling

Use this guide to run the repository's agent checks yourself or connect another agent client. The
instructions, workflows and executable checks each have a home:

- [AGENTS.md](https://github.com/filiphsps/pumpkin-plugins/blob/master/AGENTS.md) holds shared rules
  and points contributors to relevant guides and skills.
- `.agents/skills/` contains focused workflows. An agent can discover a skill or read its `SKILL.md`
  directly. Skills don't install hooks or authorize external actions.
- `.agents/hooks/` contains client-neutral Node scripts and client adapters. Codex registers
  `.agents/hooks/codex.mjs` in `.codex/hooks.json`; other clients need their own adapters.

## Run checks directly

From the repository root, use the portable runner:

```sh
node .agents/hooks/check.mjs --plan
node .agents/hooks/check.mjs
node .agents/hooks/check.mjs packages/upnpumpkin/src/plugin.ts
pnpm run lint:actions
```

`--plan` prints the selected files and commands as JSON without running them. With no file paths,
the runner collects all staged, unstaged and untracked paths from `git status`, including deletions
and renames, then checks the applicable files and packages and adds repository-wide metadata checks.
If you pass paths, it checks only those files and their packages; deleted paths are allowed, but
repository-wide checks are skipped. Either mode checks generated READMEs when the selected changes
include any non-generated files: only the affected plugins' READMEs when nothing but plugin source
changed, otherwise all of `pnpm readme:check`.

Checks don't apply fixes. If you need to fix lint issues, use the scoped `pnpm exec biome check
--write` and `pnpm exec eslint --fix` commands on files you own.

| Change | Checks |
| --- | --- |
| Existing files | Biome; TypeScript files also get the JSDoc lint |
| Lint configuration | Whole-repo lint, to catch newly invalid existing code |
| GitHub workflow or `.github/actionlint.yaml` | `pnpm run lint:actions` |
| Package code | Typecheck and unit tests for that package and workspace dependents |
| Shared root build inputs or lockfile | Typecheck and unit tests for all packages |
| Deleted package | All package typechecks and unit tests, to catch remaining imports |
| Scripts, hook code, generators, `.github/`, `.codex/`, root `package.json` or `turbo.json`, release-please config | `pnpm test:scripts` |
| Only plugin source (no `package.json` or Markdown) | Generated READMEs of those plugins and their workspace dependents |
| Any other non-generated change | `pnpm readme:check` |
| No-path run with non-generated changes | `pnpm check`, plus the applicable file and package checks |
| Only generated output | No checks |

Markdown-only package edits skip package tests. `tools/build/src/` is source code, not generated
output. Real-server tests run separately because they need a server; see [Testing](testing.md) and
[the testing skill](https://github.com/filiphsps/pumpkin-plugins/blob/master/.agents/skills/pumpkin-testing/SKILL.md).

## Run Actionlint locally

The Actionlint workflow installs actionlint `1.7.12` and checks every workflow unless the only
changed files are `.github/labels.yml` and/or `.coderabbit.yaml`. To run the same check locally,
install that version using the
[upstream installation guide](https://github.com/rhysd/actionlint/blob/v1.7.12/docs/install.md).
With Go installed, run:

```sh
go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.12
pnpm run lint:actions
```

`.github/actionlint.yaml` registers the `ubuntu-26.04` runner label because actionlint doesn't
include it in its built-in runner list.

## How Codex scopes automatic checks

When you run `check.mjs` without paths, Git status supplies the files to check. Codex's completion
hooks use a narrower scope: around each tool call they compare only the paths it explicitly
targets through `apply_patch` or a shell output redirection, and record the ones that changed. Codex
sends every file edit as `apply_patch`; `Edit` and `Write` are only matcher aliases for it. A shell
command that changes files as an implicit side effect has no attributable path. The root agent and
each subagent also have separate scopes, so one agent's completion report doesn't include another
agent's work.

Completion checks pass explicit paths, which means they skip repository-wide metadata checks. They
still check generated READMEs when the scoped changes include non-generated files. Passing these fast
checks doesn't prove runtime behavior, correct prose or the full CI workflow. See the
[Codex Hooks guide](https://learn.chatgpt.com/docs/hooks) for the current trust flow and hook
behavior: project hooks load only for trusted projects, and Codex requires review and trust for each
non-managed hook definition before it runs.

The Codex adapter in `.agents/hooks/codex.mjs`, registered by `.codex/hooks.json`, sends
`PreToolUse` shell and patch calls through the portable guard. `PostToolUse` records
changed paths. `Stop` and `SubagentStop` check that agent's recorded paths and request one
continuation when checks fail. The scope uses the Codex session ID and `turn_id`, with a separate
identity for each subagent.

## Portable hook protocol

A client adapter can run `node .agents/hooks/run.mjs` with one JSON request on stdin. The runner
writes one JSON response to stdout and exits with `0` for success or `1` for a refusal, failed check
or invalid request. Resolve the script from the repository root; it runs checks there regardless of
the caller's directory. A request's `cwd` only resolves relative file paths and defaults to the
repository root.

| Event | Request fields | Response |
| --- | --- | --- |
| `before-tool` | `tool`, `input`, optional `cwd` | `ok`, replacement `input` when allowed, or `reason` when refused |
| `plan` | Optional `files` array and `cwd` | `ok`, `files`, `steps`; runs no checks |
| `check` | Optional `files` array and `cwd` | `ok`, `files`, `failures`, readable `report` |

For `plan` and `check`, explicit `files` keep file and package checks scoped to those paths.
Generated READMEs are still checked when the selected files include a non-generated file. Omit
`files` to discover all dirty files and include repository-wide metadata checks.

For example, this request previews checks for the hook runner without running them:

```json
{ "event": "plan", "files": [".agents/hooks/run.mjs"] }
```

The adapter must map the client's tool names and payloads to the request fields the runner accepts:

| Tool type | Accepted names and inputs |
| --- | --- |
| Shell | `shell`, `bash` or `exec_command`; `input.command` or `input.cmd` |
| Edit or write | `edit` or `write`; `path` or `filePath`; `oldString` for edits or full `content` for writes |
| Patch | `patch` or `apply_patch`; a string input or `patchText`, `patch` or `command` containing an apply-patch formatted patch |

Unknown tool names pass through; unsupported event names fail. The adapter should refuse an
operation when `ok` is false and use a returned `input` when the runner rewrites one. At completion,
invoke `check`. Feed a failure report back only if the client supports continuation, and cap retries
to avoid loops. Make hook failures visible: malformed JSON, process errors and timeouts aren't
successful checks. Keep client-specific API, hook trust, discovery locations and continuation
formats in that client's adapter instead of adding them to the shared checks. For other clients,
consult their hook documentation before writing an adapter.

## What the before-tool guard protects

The optional guard catches common use of other package managers and direct edits to `pnpm-lock.yaml`,
Release Please changelogs and `.release-please-manifest.json`, build output, and generated Markdown
blocks in READMEs and custom guides. It doesn't parse shell commands or provide a security boundary:
shell matching is a heuristic, and shell-based file writes bypass the edit guard. Patches to a Markdown
file containing generated blocks are refused as a whole because the guard can't reconstruct their
hunks. Use a precise edit outside the generated block, or edit its source and regenerate the document.
Before `pnpm install`, the shell and path guards still work, but an edit to an existing Markdown file
is refused with a request to run `pnpm install`, since the block check needs workspace packages.

Plain Turbo runs receive `--output-logs=errors-only` unless they choose a log level or use shell
syntax. Git authorization remains in `AGENTS.md`; the guard can't infer what the user authorized.

## Verify the tooling

Run `pnpm test:scripts` to exercise scope selection, status parsing, guards and the JSON protocol.
Before a large run, use `--plan` to confirm which packages the runner will select. To test a client
integration, use a disposable checkout and check an allowed call, a refused call, a failing
completion check, the retry limit and a clean completion. Unit tests of the shared protocol don't
prove that a client loads its adapter.

`pnpm check` also checks links, commands and repository paths in `AGENTS.md` and the skill documents,
so those instructions don't silently drift away from the code they describe.
