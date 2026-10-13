---
navigation:
    category: Repository maintenance
---

# Agent tooling

The repo keeps agent instructions, skills and executable checks separate:

- [AGENTS.md](https://github.com/filiphsps/pumpkin-plugins/blob/master/AGENTS.md) holds the shared rules and routes tasks to relevant docs and skills.
- `.agents/skills/` holds focused workflows. An agent can discover them or read the linked `SKILL.md`
  directly. They don't install hooks or grant permission for external actions.
- `.agents/hooks/` holds the client-neutral Node scripts and client adapters. Codex's
  `.codex/hooks.json` registers `.agents/hooks/codex.mjs`; other clients need their own adapters.

The portable runner inspects git status, so shell writes, deletions and renames are included alongside
edits made through dedicated tools.

## Run checks directly

From the repo root:

```sh
node .agents/hooks/check.mjs --plan
node .agents/hooks/check.mjs
node .agents/hooks/check.mjs packages/upnpumpkin/src/plugin.ts
```

`--plan` prints JSON with the files and commands without executing them. With no paths, the runner
checks all staged, unstaged and untracked files. Explicit paths scope the run to your work and may
include deleted files. Checks never apply lint fixes. Use scoped `pnpm exec biome check --write` and
`pnpm exec eslint --fix` only on files you own when fixes are needed.

| Change | Checks |
| --- | --- |
| Existing files | Biome; TypeScript files also get the JSDoc lint |
| Lint configuration | Whole-repo lint, to catch newly invalid existing code |
| Package code | Typecheck and unit tests for that package and workspace dependents |
| Shared root build inputs or lockfile | Typecheck and unit tests for all packages |
| Deleted package | All package typechecks and unit tests, to catch remaining imports |
| Scripts or hook code | `pnpm test:scripts` |
| Any relevant file | `pnpm check` and `pnpm readme:check` |
| Only generated output | No checks |

Markdown-only package edits skip package tests. `tools/build/src/` is source, not generated output.
Real-server tests are deliberately separate; see [Testing](testing.md) and
[the testing skill](https://github.com/filiphsps/pumpkin-plugins/blob/master/.agents/skills/pumpkin-testing/SKILL.md).

The direct no-path runner checks every dirty file in the checkout. Codex completion hooks instead
compare the working tree before and after each tool call, then check only files changed during that
agent's turn. Root agents and subagents get separate scopes, so concurrent work in the same checkout
does not add its failures to another agent's completion report. Passing these fast checks does not
prove runtime behavior, correct prose or the full CI workflow.

## Portable hook protocol

A client adapter can run `node .agents/hooks/run.mjs` with one JSON request on stdin. The script writes
one JSON response on stdout and exits `0` for success or `1` for refusal, check failure or invalid input.
Resolve the script from the repository root; it runs checks there regardless of the caller's directory.
A request's `cwd` only resolves its relative file paths and defaults to the repo root.

| Event | Request fields | Response |
| --- | --- | --- |
| `before-tool` | `tool`, `input`, optional `cwd` | `ok`, replacement `input` when allowed, or `reason` when refused |
| `plan` | Optional `files` array and `cwd` | `ok`, `files`, `steps`; executes no checks |
| `check` | Optional `files` array and `cwd` | `ok`, `files`, `failures`, readable `report` |

For example, stdin can contain:

```json
{ "event": "plan", "files": [".agents/hooks/run.mjs"] }
```

Shell tools accept `shell`, `bash` or `exec_command` and `input.command` or `input.cmd`. Edit tools
accept `edit` or `write`, `path` or `filePath`, and `oldString` or full `content` respectively. Patch
tools accept `patch` or `apply_patch`, with a string input or `patchText`, `patch` or `command` containing
an apply-patch formatted patch. Unknown tool names pass through; unsupported event names fail.
An adapter must translate its own tool names and payloads into this contract.

The optional before-tool guard catches common use of other package managers and direct edits to
lockfiles, release-owned files, build output and generated Markdown blocks in READMEs and custom guides. Shell matching is a
heuristic, not a shell parser or security boundary. Shell-based file writes bypass edit guards.
Patch edits to a Markdown file containing generated blocks are conservatively refused because the guard
doesn't reconstruct patch hunks; use a precise edit outside the blocks, or regenerate from source.
Plain Turbo runs receive `--output-logs=errors-only` unless they specify a log level or shell syntax.
Git authorization remains in AGENTS.md; the guard cannot infer what the user authorized.

## Integrating an agent client

Translate the client's before-tool callback into `before-tool`, refuse an operation when `ok` is false,
and use the returned input if the client supports rewriting. At completion, invoke `check`. Feed a
failure report back only when the client supports continuation, and cap automatic retries to avoid
loops. A hook failure must be visible; don't interpret malformed JSON, process errors or timeouts as a
successful check. A blocking check report should tell the agent to preserve unrelated work.

Client APIs, hook trust, discovery locations and continuation schemas differ. Keep those details in
an adapter owned by that client rather than baking them into shared repo checks. This repo includes a
Codex adapter in `.agents/hooks/codex.mjs` and project hook configuration in `.codex/hooks.json`.
Codex's `PreToolUse` hook translates shell and patch calls into the portable guard protocol. `PostToolUse`
records paths changed by each tool call, and `Stop` and `SubagentStop` run checks against that agent's
scope, asking it to continue once when checks fail. The per-turn scope uses Codex's `turn_id` together
with its session id. Project hooks load only for trusted projects, and Codex requires review and trust
for each non-managed hook definition before it runs. See the [Codex Hooks guide](https://learn.chatgpt.com/docs/hooks)
for the current trust flow and hook behavior.

For other clients, consult their hook documentation before writing a client-specific adapter.

## Verify the tooling

Run `pnpm test:scripts` to exercise scope selection, status parsing, guards and the JSON protocol.
Use `--plan` to confirm the expected packages are selected before a large run. For client integration,
test an allowed call, a refused call, a failing completion check, the retry limit and a clean completion
in a disposable checkout. Unit tests of the shared protocol don't prove a client loads an adapter.

`pnpm check` also checks links, commands and repo paths in AGENTS.md and the skill documents, so these
instructions don't silently drift away from the code they describe.
