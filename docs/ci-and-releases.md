# CI and releases

The plugin and release jobs are in `.github/workflows/ci.yml`; action tests have their own
`.github/workflows/actions.yml`, scoped to changes under `actions/`. The shared setup (pnpm, Node,
install, Turborepo cache) is the composite action in `.github/common/bootstrap`. Workflow jobs use
`ubuntu-24.04` to keep their runner image stable as `ubuntu-latest` migrates to Ubuntu 26.

## Jobs

| Job | Runs | What |
| --- | --- | --- |
| 🔍 Changed files | always | Separates plugin/repository code from changed action directories and documentation |
| 💬 Commit messages | PRs | Lints every commit with `commitlint.config.mjs` |
| 📋 Lint | code changes | `pnpm lint`: Biome, then the JSDoc check (see [Code style](code-style.md)) |
| ✅ Typecheck | code changes | `pnpm typecheck` |
| 🧪 Test | plugin or repository code changes | Unit tests with V8 coverage uploaded to Codecov; project coverage may drop by up to 1 percentage point, and tests for repo scripts and agent hooks (`pnpm test:scripts`) |
| 🧪 Action tests | action code changes | `.github/workflows/actions.yml` tests only the changed action, with `*.test.*` files co-located in `actions/{name}/src/` |
| 📝 Docs and config | always | Generated READMEs are current, and `pnpm check` passes: release config, package metadata, docs against the code |
| 🔨 Build | code changes, after lint and typecheck | Builds and collects every plugin, then signs and verifies them with the reusable action before upload |
| 🎃 Integration | code changes, after build | Runs affected package suites against the pinned Pumpkin release, or the full suite for repo-level changes; reuses WASM files from the build job |
| 🧬 Generator | code changes, after lint | Generates a throwaway plugin and action, checks release registration and READMEs, tests the action, then typechecks, builds and integration-tests the plugin |
| 🚢 Release | plugin or action release changes, on `master` pushes | Runs release-please; action releases create a versioned tag and GitHub release without a plugin artifact |
| 📝 Prepare release PR | all open release PRs on release runs | Keeps plugin READMEs, action README examples and first-release pins for plugins and actions current |
| 🔏 Sign, 📎 Attach, 🛒 Market | per released plugin | Checks the tag is the commit this run built, signs the exact build artifact, uploads it, then updates an existing Market listing |
| 🧹 Cleanup artifacts | after successful consumers | Deletes integration and release handoff artifacts after their last use |

The signed `plugins` build artifact remains available in the run summary, with a direct download
link in the build job summary, for one day. Successful runs delete the integration fixture and
per-release handoff artifacts after all consumers finish. If an artifact consumer fails, cleanup is
skipped so its handoff artifacts remain available for a rerun. Fork and Dependabot pull requests use
read-only tokens, so their temporary artifacts expire after one day instead of being deleted by the
workflow.

## Running only what a change needs

`scripts/changed-areas.mjs` diffs the change against what came before it (the pull request base or
the push's `before` commit). Markdown, `docs/` and `LICENSE` changes are documentation. Changes
under `actions/{name}/` are reported separately from plugin and repository code. An action-only
change skips the plugin build, integration suites and repository test jobs; the Actions workflow
tests only that action when its code changes. Action tests live beside their implementation in
`actions/{name}/src/*.test.mjs`. README, changelog and version-file-only changes skip action tests.
A docs-only change skips the code jobs and action tests.

Everything else outside `actions/` is a change to repository code and runs the code jobs, including
changes under `tools/`, `scripts/` and `.github/`, and deletions. Integration tests narrow to changed plugin packages and
their dependents when all code changes are within plugin or runtime-tool packages; repo-level
changes run the full integration suite. Biome, the type checker and the tests read none of the
documentation files, so a docs-only change cannot fail them.

Two jobs never skip. `📝 Docs and config` is what keeps the docs true, so it has to run on the
commits that change them. `💬 Commit messages` is cheap and belongs on every pull request.

On a push, the release job waits for plugin checks when plugin/repository code changed, or for the
docs/config check when only actions changed. Release Please only releases a component with
releasable changes, so running it for changed action code does not create an empty release.

Know this before narrowing a job further: a skipped job takes every job that needs it with it, so no
job can be gated on less than the jobs below it. Gating `📋 Lint` without `🔨 Build` would leave a
release with no artifact to attach, and nothing would say so.

## Merging

Pull requests are **rebase-merged**, never squashed. Every commit lands on `master` as written, and
release-please reads each one, so every commit message must be a conventional commit:
`feat(scope): ...`, `fix: ...`, `feat!: ...` for breaking changes. The commit lint enforces it.

Commits touching a plugin or its bundled workspace dependencies release that plugin. This includes
transitive runtime dependencies such as `plugin-kit` and `update-check`, and the workspace build
tool. A shared fix appears in each affected plugin's changelog, starting at that plugin's own last
release. Tests, test helpers, generated build output and documentation do not count as shipped code.
Changes to the dependency catalog or shared TypeScript configuration count for every plugin.

## Releases

On `master`, once the checks pass, [release-please](https://github.com/googleapis/release-please)
keeps an independent release PR up to date for each plugin or action with releasable conventional
commits. Merging a plugin release PR:

- bumps each changed plugin's version and changelog,
- tags it `<folder>-v<version>` and creates its GitHub release,
- attaches `<folder>.wasm` and `<folder>.wasm.sha256`, taken from the artifact the build job made
  in the same run.

Merging an action release PR updates its `version.txt` and `CHANGELOG.md`, tags it
`<folder>-v<version>`, and creates a GitHub release. Action releases do not run plugin packaging,
attach WebAssembly files, or publish to Pumpkin Market.

The merge of a release PR is a commit of its own, so the push it triggers starts a run while the run
for the commit before the merge can still be going. Whichever reaches the release job first creates
the tag and the release, which is usually the older run, and the artifact it holds was built from an
earlier commit. The attach job therefore resolves the tag first and refuses to upload unless it
points at the commit that run built, which leaves the release to the run for the released commit.

Push workflow runs are not canceled when a newer commit arrives. This lets release-please finish
creating a tag and updating its release PR before the next push run reads that state. Pull request
runs are still canceled when superseded.

Release Please creates a tag immediately, including while a GitHub release is a draft. Without that,
a later release run can miss the previous release and recreate its changelog. The release config
keeps `force-tag-creation` enabled, and the repository check enforces it.

After each Release Please run, a separate matrix job finds every open component release PR and
prepares its branch, including branches Release Please did not return as changed. It regenerates
plugin READMEs and updates the versioned example tag in every action README from that action's
Release Please manifest entry. For an action that has not had its first release, the README uses its
`release-as` version instead of `0.0.0`. The job pushes a
`docs: update generated READMEs` commit to the PR branch, so examples are current when the release
merges. The same run retires the `release-as` pin of any plugin or action the PR releases (see below).
release-please rewrites its branch on every update, so those commits are re-added each time.

Release PRs refresh on every release run, even when their release notes are unchanged.
`always-update` keeps the remaining branches based on current `master` after another plugin's
release merges, preventing conflicts in the shared manifest and release configuration. Every
refreshed PR goes through the README and pin preparation job again. Separate PRs keep a plugin
that is not ready from being released with one that is.

`scripts/release.mjs` runs the pinned Release Please runtime through `pnpm dlx`.
`scripts/release-commits.mjs` supplies shared commits through its plugin hook before versions and
changelogs are calculated. Features, fixes and performance improvements appear in the notes.
After publishing, the runner reloads the manifest before generating PRs. Each plugin's commits
stop at its own latest release, so refreshing branches does not propose an empty follow-up release.
The generator fails if it cannot find a previous release or fetch enough history, rather than
publishing incomplete notes. Increase `commit-search-depth` in the release configuration if needed.
Changelogs stay generated; do not edit them by hand.

To preview without changing GitHub, set `GITHUB_REPOSITORY` and `RELEASE_PLEASE_TOKEN`, then run:

```sh
pnpm --package=release-please@17.11.2 dlx -c 'node scripts/release.mjs --dry-run "$(command -v release-please)"'
```

Add `--component=<name>` to preview one plugin or action. `--pull-requests-only` updates release PRs without
creating tags or GitHub releases.

## Signing

Pumpkin can check a plugin's integrity: a signed `.wasm` carries two custom sections,
`pumpkin.metadata` (plugin name, version, developer, issue time) and `wasm_signature` (an Ed25519
signature over the code plus the metadata, and the public key). Pumpkin loads unsigned plugins with
a warning unless `allow_unsigned = false` is set in its config. Signing is optional here.

`pnpm package` (`scripts/collect-plugins.mjs`) only copies built plugins into `dist/` and writes
checksums; it does not sign files or warn when they are unsigned. CI always prepares a key and uses
the reusable [`sign-pumpkin-plugin` action](../actions/sign-pumpkin-plugin/README.md) to sign every
collected plugin from a metadata manifest. Pushes use the repository secret when available, while
pull requests and pushes without the secret use an ephemeral key. CI verifies each signature and
uses the signed files for integration tests. The ephemeral key is only for checks; release jobs
never receive it. Release jobs use the same action to sign the exact build artifact after checking
that the release tag points to the commit that produced the build. It uploads the signed `.wasm`
and refreshed `.sha256` to the GitHub release and Pumpkin Market.

| Situation | Result |
| --- | --- |
| Local `pnpm package` | Always collects unsigned files without a warning, regardless of the key environment variable |
| CI push with a valid repository key | Signs the build and release artifacts with the repository key |
| CI pull request or push without a key | Signs build artifacts with a run-only key; release signing still requires the repository key |
| Signing action receives a malformed key | Fails rather than silently shipping unsigned files |

To set it up:

1. Generate a key: `node scripts/generate-signing-key.mjs`. It prints a secret and a public key and
   writes nothing.
2. Settings, Secrets and variables, Actions: add the secret as the repository secret
   `PLUGIN_SIGNING_KEY`. The public key is safe to publish.

To check a downloaded plugin: `node scripts/verify-plugin.mjs <file.wasm>`. It prints the plugin
name, version and public key, and exits with 1 when the file is unsigned or the signature doesn't
match.

The signature embeds its own public key, so Pumpkin 0.2.0 only checks that the file is intact; it
doesn't know whose key it is. A server admin decides whom to trust by comparing the public key
with the one you publish.

To rotate the key, generate a new one and replace the secret. Releases made with the old key stay
valid, since each file carries the key it was signed with. Only the published public key changes.

## Registering a plugin for releases

A plugin is only released if it is listed in **both** release-please files. `pnpm gen` adds it to
both automatically. If you ever create a plugin by hand, do these three things:

1. Add it to `release-please-config.json`, under `packages`. The `component` must be the folder
   name; it becomes the tag prefix (`my-plugin-v0.0.1`):

   ```json
   "packages/my-plugin": { "component": "my-plugin", "release-as": "0.0.1" }
   ```

   `release-as` makes the first release `0.0.1` whatever the first commits are (a breaking change
   would otherwise make it `0.1.0`). It pins every release until it is removed, so the release job
   removes it from the release PR (`scripts/unpin-release-as.mjs`). That has to happen **before** the
   release PR merges, not after: `master` fails the release config check while the pin is there, and
   the release and attach jobs both need that check, so a release merged with the pin still in place
   is never tagged and gets no `.wasm`. To do it by hand, delete the line from the PR branch.

2. Add it to `.release-please-manifest.json`, at the same version as the plugin's `package.json`:

   ```json
   "packages/my-plugin": "0.0.0"
   ```

3. Start the plugin at version `0.0.0` in its `package.json`. The release config also uses
   `bump-patch-for-minor-pre-major`, so after the first release a `feat` or `fix` bumps the patch
   while a plugin is below 1.0.0, and only a breaking change bumps the minor.

## Registering an action for releases

Each directory under `actions/` with an `action.yml` or `action.yaml` is an independent release
component. Use `pnpm gen:action` to create the standard action files and register the action. If you
create one by hand, register it under `packages` in `release-please-config.json` with its folder as the
component, the `simple` release strategy, and a first-release pin:

```json
"actions/my-action": {
  "component": "my-action",
  "release-type": "simple",
  "release-as": "0.0.1"
}
```

> [!IMPORTANT]
> **Preserve hyphens in GitHub Action input names.** The runner maps `plugin-name` to the environment
> variable `INPUT_PLUGIN-NAME`: it uppercases input names and replaces spaces with underscores, but
> keeps hyphens. In JavaScript actions, use the standard `getInput()` helper generated in
> `src/utils.mjs` and pass the input name exactly as declared, such as `getInput('plugin-name')`.
> Do not pass `PLUGIN_NAME` or normalize hyphens to underscores; required inputs will appear empty.
> Action tests must use the runner's hyphenated environment keys (for example,
> `'INPUT_PLUGIN-NAME'`) so this behavior stays covered.

Use a JavaScript action (`runs.using: node24`) when the implementation can run on GitHub's built-in
Node runtime. Consumers do not need `actions/setup-node` or a local Node installation for that
action. Use a composite action when it needs to orchestrate workflow steps or support other runner
steps.

Add `actions/my-action/version.txt` with `0.0.0`, a `CHANGELOG.md`, and the same path at version
`0.0.0` in `.release-please-manifest.json`. Release Please updates the version file and changelog;
the repository check enforces that the action version, manifest and config stay aligned. Its tag is
`my-action-v<version>`. The release PR job removes `release-as` after the first version is set,
just as it does for plugins.

## Repo checks

`pnpm check` runs three scripts, each of which says exactly what is wrong. CI runs it in the
`📝 Docs and config` job, and the `🧬 Generator` job runs it on a freshly generated plugin, so the
generator and the checks can't drift:

| Script | Fails when |
| --- | --- |
| `scripts/check-release-config.mjs` | a plugin or action is missing from either release-please file, an action is not using the `simple` strategy, `component` isn't the folder name, the manifest and package/version file disagree, an unreleased component lacks `release-as: 0.0.1`, or a released one still has it |
| `scripts/package-metadata.mjs` | a `package.json` lacks the license, author, contributors, homepage, repository, bugs, funding or a short description, or a library lacks `sideEffects`, `module`, `types`, `files` and `publishConfig`. `--fix` writes everything but the description |
| `scripts/check-docs.mjs` | a package has no README, a link, heading or path in the docs doesn't exist, a `pnpm` command isn't a script, a doc page isn't in the docs index, a root script isn't documented, or a CI job isn't in the table above |

`pnpm test:scripts` runs the tests of those three, `scripts/unpin-release-as.mjs`,
`scripts/update-action-readmes.mjs`, `scripts/changed-areas.mjs`, the bundled release commit selector,
and the agent hooks, using fixtures and throwaway repos. See "Docs match the code" in
[Code style](code-style.md).

## Publishing to market.pumpkinmc.org

The reusable JavaScript action lives in
[`actions/publish-to-pumpkin-market/`](../actions/publish-to-pumpkin-market/README.md); each action
in this monorepo has its own directory, metadata and README. Other repositories can use a published
version with
`uses: filiphsps/pumpkin-plugins/actions/publish-to-pumpkin-market@publish-to-pumpkin-market-v0.0.1`.
The action accepts the exact Pumpkin plugin name, version, `.wasm` path, optional track and release
notes, a Market API token, and an optional API URL. It calls `PUT /api/plugins/<id>` with bearer
authentication and multipart `wasm` and `metadata` fields, using the file it receives without
rebuilding it. It runs directly on GitHub Actions' Node 24 runtime.

In this repo, the `market` job downloads the `.wasm` produced by the build job, resolves the plugin's
canonical name from `src/info.ts`, and passes the per-plugin Release Please version and changelog to
the action using its local path. Builds aren't byte-reproducible, so the job must upload the artifact
rather than rebuild.

The action looks up the canonical plugin name using PPM's flow: try the direct plugin endpoint, then
search a limited result set and require an exact name match. It never creates a listing: listing
metadata and review happen in Market. If the plugin is not listed, has not yet been published there,
or the token is not configured, the action fails by default. Set `warn: true` to emit a warning and
continue; this repository opts into that mode so GitHub releases remain independent of Market
listing and credential availability. Other Market API failures always fail the job and can be
retried. See the
[action README](../actions/publish-to-pumpkin-market/README.md#inputs) for its complete input list.
The listing metadata API and its observed behavior are documented in
[Pumpkin Market API](pumpkin-market-api.md).

## GitHub settings

These aren't done by the workflows:

1. Settings, General, Pull Requests: enable **Allow rebase merging** only. Disable squash and merge
   commits.
2. Settings, Actions, General: enable **Allow GitHub Actions to create and approve pull requests**.
3. Optional: add a PAT or GitHub App token as the `RELEASE_PLEASE_TOKEN` secret. Without it, CI
   doesn't run on the release PR, because GitHub doesn't trigger workflows for events created with
   `GITHUB_TOKEN`. That includes the README commit.
4. Add the Ed25519 signing key as the `PLUGIN_SIGNING_KEY` secret (see [Signing](#signing)).
   Non-release checks use an ephemeral key, but the release workflow requires this secret to publish
   signed artifacts.
5. For market publishing: create a Market API key with the `plugins:update` and
   `plugins:versions:upload` scopes, then add it as the `MARKET_API_TOKEN` repository secret. Keep
   the key out of the repository and chat messages.
6. Optional: add the Codecov repository upload token as the `CODECOV_TOKEN` Actions secret to publish
   coverage from protected branches and same-repository runs. Public fork pull requests can use
   Codecov's tokenless upload setting. The `codecov.yml` project status compares coverage with the
   base commit and allows a drop of up to 1 percentage point to avoid failing on small fluctuations.
