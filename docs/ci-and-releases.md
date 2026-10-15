---
navigation:
    category: Repository maintenance
---

# CI and releases

Plugin, action, extension and public tool checks are in `.github/workflows/ci.yml`; the external-consumer matrix is
in the reusable `.github/workflows/external-consumer.yml`. Release orchestration is in the reusable
`.github/workflows/release.yml`, called after the CI gates pass. Action tests run through
the reusable `.github/workflows/actions.yml`, scoped to action code. Extension checks run through
`.github/workflows/extensions.yml`, scoped to changed extensions. The documentation site has its own
`.github/workflows/docs.yml`, which checks and publishes the VitePress site and mirrors it to
`gh-pages`. GitHub workflow validation runs independently in `.github/workflows/actionlint.yml`. The
shared setup (pnpm, Node, install, Turborepo cache) is the composite action in
`.github/common/bootstrap`. Most CI jobs use
`ubuntu-26.04`; the external-consumer matrix also runs on `macos-15` and `windows-2025`.

## Jobs

| Job | Runs | What |
| --- | --- | --- |
| 🔍 Changed files | CI-triggering changes | Separates plugin/repository code, action directories, extension directories and documentation; selects the generator smoke test for scaffold-related changes and detects generated README refresh commits |
| 💬 Commit messages | code, action, extension, or generated README changes on PRs | Lints every commit with `commitlint.config.mjs` |
| 📋 Lint | code changes | `pnpm lint`: Biome, then the JSDoc check (see [Code style](code-style.md)) |
| ✅ Typecheck | code changes | `pnpm typecheck` |
| 🧪 Test | plugin or repository code changes | Package and action unit tests with V8 coverage uploaded to Codecov; project coverage may drop by up to 1 percentage point, and tests for repo scripts and agent hooks (`pnpm test:scripts`) |
| 📦 External consumer | code changes | Packs public tools and their workspace dependencies, checks packed metadata and starter dependency ranges, then installs and builds the creator's TypeScript and JavaScript starters and runs `pumpkin-codemod list` outside the repository on Linux, macOS arm64 and Windows x64 with the pinned Node and pnpm versions |
| 🧪 Action tests | action or shared helper code changes | `.github/workflows/actions.yml` lints and tests the changed action, or common plus all four public consumers for shared helper changes, then uploads c8 coverage to Codecov |
| 🛡️ Action test gate | every CI run, after classification and action tests | Requires every selected action suite to pass; accepts skipped tests only for an empty matrix |
| 🧪 Extension tests | extension implementation changes | `.github/workflows/extensions.yml` lints, typechecks, tests and packages each changed extension |
| 🛡️ Extension test gate | every CI run, after classification and extension tests | Requires every selected extension suite to pass; accepts skipped tests only for an empty matrix |
| 📝 Docs and config | code, action, extension, or generated README changes | Generated READMEs are current, and `pnpm check` passes: release config, package metadata, docs against the code |
| 🔨 Build | code changes, after change classification | Starts Static Hermes preparation while lint and typecheck run, then builds every production plugin with its configured engine (Static Hermes by default), runs integration checks, and rebuilds release artifacts with the same runtime before signing and verification |
| 📊 Engine comparison | code changes, after build | Calls `.github/workflows/engine-comparison.yml` through `workflow_call`; nine engine configurations run as parallel matrix jobs, then a report job validates and combines their real-Pumpkin results |
| 📈 Engine comparison comment | successful PR CI runs with a benchmark report | `.github/workflows/engine-comparison-comment.yml` compares with the latest matching default-branch report, updates one PR comment, and embeds an SVG timing-change chart |
| 🎃 Integration | code changes, after build | Runs affected package suites against the pinned Pumpkin release, or the full suite for repo-level changes; reuses WASM files from the build job |
| 🧬 Generator | scaffold, generator setup or generated plugin dependency changes, after lint and build | Reuses the Static Hermes cache saved by Build, then generates a throwaway plugin, action and extension; checks release registration and READMEs; tests the action and extension; and typechecks, builds and integration-tests the plugin |
| 🛡️ Generator gate | every CI run, after classification and the generator smoke test | Requires the smoke test when a scaffold, generator setup or generated plugin dependency changes; accepts a skipped test when none changed |
| 🚢 Release | plugin, action, extension or public tool release changes, on `master` pushes | Calls the reusable release workflow after CI gates pass; actions create GitHub releases, extensions attach VSIX packages, public tools publish npm tarballs, and plugins produce signed artifacts and Market listings |
| 📝 Prepare release PR | all open release PRs on release runs | Keeps plugin and extension READMEs, action README examples, starter dependency ranges and first-release pins current |
| 🔏 Sign, 📎 Attach, 🛒 Market | per released plugin | Checks the tag is the commit this run built, signs and uploads the exact build artifact, publishes it to an existing Market listing, then syncs its description and commands |
| 🧹 Cleanup artifacts | after artifact consumers finish | Deletes handoffs whose consumers succeeded or were skipped, even if another job failed; retains artifacts needed to rerun failed consumers |

The signed `plugins` build artifact remains available in the run summary, with a direct download
link in the build job summary, for one day. CI deletes the integration WASM files and fixture after
integration succeeds or is skipped, even if another job fails; it keeps them when integration fails
so that job can be retried. Per-release handoff artifacts are deleted only after the reusable
release workflow succeeds; a failed release keeps them available for a failed-job rerun. Failure
logs remain available for diagnosis. The Docs workflow deletes its `docs-site` and `github-pages`
artifacts after publishing succeeds or is skipped, and keeps them if publishing fails so it can be
retried. Fork and Dependabot pull requests use read-only tokens, so their temporary artifacts expire
after one day instead of being deleted by the workflows.

## Running only what a change needs

`scripts/changed-areas.mjs` diffs the change against what came before it (the pull request base or
the push's `before` commit). Both it and `scripts/utils/release-commits.mjs` exclude commits listed in
`.git-blame-ignore-revs`; that file is also GitHub's blame ignore list. Add a short reason comment
above each SHA so future entries retain their context. Markdown, `docs/`,
component-level `docs/` folders and `LICENSE` changes are documentation. Changes under
`actions/{name}/` and `extensions/{name}/` are reported separately from plugin and repository code.
An action-only or extension-only change skips the plugin build, integration suites and repository
test jobs; CI calls the matching reusable workflow for each changed component. Common action helper
changes test common and all four public consumers.
Common is excluded from release selection. Action tests live beside their implementation in
`actions/{name}/src/*.test.mjs`; shared helper tests live in `actions/common/src/*.test.mjs`. README,
changelog and version-file-only changes skip action tests.
A docs-only change triggers the separate Docs workflow, which checks the docs and builds the site;
GitHub's path filters skip the main CI workflow, so it does not call action tests. Mixed changes run the
relevant code or action checks.

Everything else outside `actions/` is a change to repository code and runs the code jobs, including
changes under `tools/`, `scripts/` and `.github/`, and deletions. Integration tests narrow to changed plugin packages and
their dependents when all code changes are within plugin or runtime-tool packages; repo-level
changes run the full integration suite. Biome, the type checker and the tests read none of the
documentation files, so a docs-only change cannot fail them.

The main CI `📝 Docs and config` job runs for code, action and extension changes, and for the automatic
`docs: update generated READMEs` commit. Release PRs also change version and changelog files, so
GitHub continues to trigger CI as the README refresh commit is added. The classifier recognizes that
commit and reruns the repository checks that validate the generated README. Ordinary docs-only PRs
skip the main CI workflow entirely.

On a push, the release job waits for the action and extension test gates and docs/config checks. Plugin/repository
changes also require lint, typecheck, build, external-consumer, unit test and integration jobs. Engine
comparison runs separately and does not gate releases.
Empty action and extension matrices pass their gates without running component tests, including version-only release changes.
Release Please only releases a component with
releasable changes, so running it for changed action code does not create an empty release.

Know this before narrowing a job further: a skipped job takes every job that needs it with it, so no
job can be gated on less than the jobs below it. Gating `📋 Lint` without `🔨 Build` would leave a
release with no artifact to attach, and nothing would say so.

## Updating upstream runtime pins

`Update upstream pins` runs daily and can be started manually. Add sources to
`.github/upstream-pins.json`; pin files follow the schemas in `schemas/`, while each source provides
its repository, branch and pinned field in that file and the catalog supplies labels and a validation
command. The workflow compares each pin with its branch
tip, validates updates, and refreshes a dedicated PR. If validation fails, it closes that PR and
creates or updates an issue. When validation later succeeds, it closes the issue and reopens or
creates the PR. Both use the configured labels and a compare link. Static Hermes validation prepares
the pinned runtime, checking out the source and applying its ordered patch series.

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
keeps an independent release PR up to date for each plugin, action, VS Code extension, and public npm tool with
releasable conventional commits. Merging a plugin release PR:

- bumps each changed plugin's version and changelog,
- tags it `<folder>-v<version>` and creates its GitHub release,
- attaches `<folder>.wasm` and `<folder>.wasm.sha256`, taken from the artifact the build job made
  in the same run.

If GitHub rejects release creation because the tag already belongs to an immutable release, the
runner reuses the existing release metadata only when its target commit matches the release PR.
That lets the matching run attach the artifact; an older run defers the artifact to the run that
built the tagged commit. The runner changes the release PR label from pending to tagged either way.
Other release PRs in the same run can still publish; other API errors remain failures.

Merging an action release PR updates its `version.txt` and `CHANGELOG.md`, tags it
`<folder>-v<version>`, and creates a GitHub release. Action releases do not run plugin packaging,
attach WebAssembly files, or publish to Pumpkin Market.

Merging a VS Code extension release PR updates its `package.json` version and `CHANGELOG.md`, tags
it `<folder>-v<version>`, and creates a GitHub release with the built `<folder>.vsix` attached.
Extension releases do not run plugin packaging or publish to Pumpkin Market.

Create and register a new extension with `pnpm gen:extension`. The generator creates its independent
Release Please manifest entry and first-release pin; the release-config check verifies its README,
changelog, package version and tag component.

Actions import shared runtime helpers from `actions/common/src/`. Each action tag contains its own
snapshot of those files, so changes to a shared helper must also include releasable changes under
each consuming action directory to publish the updated helper with those actions.

Public npm tools are discovered from package manifests under `tools/` that declare
`publishConfig.access: "public"` and are not private. Their declared production dependencies and
packed project templates determine release order. Seed each package with a metadata-only `0.0.0`
placeholder so its trusted publisher can be configured. Release Please creates and the workflow
publishes the first functional `0.1.0` release. See
[Publishing public npm tools](npm-publishing.md) for the sequence and
[Trusted publishing for npm tools](npm-trusted-publishing.md) for the `ci.yml` identity, OIDC
permissions, two-day validation window, provenance, and recovery.

To register a new public tool, add its publishable package under `tools/` and run
`pnpm register:tool tools/<path>`. The command uses the package name from its manifest, validates
public access and the first version, then updates both Release Please files. It sets a missing
first-release pin on an existing entry and rejects a conflicting one. Public tool pack checks
discover the package from its manifest; add a consumer smoke check only for a user-facing flow that
needs coverage.

The merge of a release PR is its own commit, so its push can start a run while the previous commit's
run is still active. The older run may create the tag and release first, using an artifact built from
the previous commit. The attach job checks that the tag points to the commit built by its run. It
skips the older run's artifact, leaving the released commit's run to upload the files.

Push workflow runs are not canceled when a newer commit arrives. This lets release-please finish
creating a tag and updating its release PR before the next push run reads that state. Pull request
runs are still canceled when superseded.

Release Please creates a tag immediately, including while a GitHub release is a draft. Without that,
a later release run can miss the previous release and recreate its changelog. The release config
keeps `force-tag-creation` enabled, and the repository check enforces it.

After each Release Please run, a separate matrix job finds every open component release PR and
prepares its branch, including branches Release Please did not return as changed. Discovery retries
briefly and fails if it cannot find all PRs returned by Release Please; a failed GitHub CLI query
also fails the release workflow instead of silently skipping preparation. It regenerates
plugin READMEs, generates every action README's input/output tables from its `action.yml`, and
updates the versioned example tag from that action's Release Please manifest entry. For an action
that has not had its first release, the README uses its `release-as` version instead of `0.0.0`. The
job pushes a `docs: update generated READMEs` commit to the PR branch, so examples are current when
the release merges. The same run retires the `release-as` pin for any plugin, action, extension or
public npm tool whose first release PR advances its manifest version (see below).
release-please rewrites its branch on every update, so those commits are re-added each time.

Release PRs refresh on every release run, even when their release notes are unchanged.
`always-update` keeps the remaining branches based on current `master` after another plugin's
release merges, preventing conflicts in the shared manifest and release configuration. Every
refreshed PR goes through the README and pin preparation job again. Separate PRs keep a plugin
that is not ready from being released with one that is.

The release, release-PR preparation and benchmark-comment jobs authenticate with short-lived GitHub
App installation tokens. The App is installed on this repository with `actions` read and `contents`,
`issues` and `pull-requests` write permissions. Actions settings store its Client ID in the
`RELEASE_APP_CLIENT_ID` repository variable and its private key in the `RELEASE_APP_PRIVATE_KEY`
repository secret. Each job mints its own repository-scoped token; the release-PR job uses its token
to push prepared README and pin updates, which trigger the normal pull-request CI checks. The
benchmark-comment job uses its token to read cross-run artifacts and publish its SVG as a GitHub
attachment embedded in the PR comment.

`scripts/release.mjs` runs the pinned Release Please runtime through `pnpm dlx` and applies the
pre-1.0.0 versioning policy to every configured component. For a current version below `1.0.0`,
breaking changes bump the minor (`0.0.8` to `0.1.0`), features bump the patch, and fixes and
performance improvements bump the patch. At `1.0.0` and later, normal SemVer applies: breaking
changes bump major, features bump minor, and fixes and performance improvements bump patch. The
release config checker requires the corresponding `bump-minor-pre-major` and
`bump-patch-for-minor-pre-major` options and rejects package overrides that disable them.

`scripts/utils/release-commits.mjs` supplies shared commits through its plugin hook before versions and
changelogs are calculated. A shipped change is included for every plugin that bundles the affected
package, and each plugin's version bump is calculated from its own current version. Features, fixes
and performance improvements appear in the notes. After publishing, the runner reloads the manifest
before generating PRs. Each plugin's commits stop at its own latest release, and first-release notes
start at the commit that added the plugin's `package.json`.
Action commits are trimmed to their latest release boundary, so first-release notes do not repeat in
the next release. If a manifest version has no matching GitHub release or tag, the helper uses the
latest published release for that component with a lower version as the history boundary. It fails
if no such release or package introduction commit exists, or if it cannot fetch enough history,
rather than publishing incomplete notes. Increase `commit-search-depth` in the release configuration
if a component has more than that many commits since its boundary.
Changelogs stay generated; do not edit them by hand. Empty version-only `Release-As` commits need a
conventional-commit scope matching the component so only that release is affected.

To preview without changing GitHub, set `GITHUB_REPOSITORY` and `GITHUB_TOKEN`, then run:

```sh
pnpm --package=release-please@17.11.2 dlx -c 'node scripts/release.mjs --dry-run "$(command -v release-please)"'
```

Add `--component=<name>` to preview one plugin or action. `--pull-requests-only` updates release PRs without
creating tags or GitHub releases.

To finish a plugin release whose GitHub release exists but has no plugin assets, run the
`Recover plugin release` workflow from `master` and pass its existing tag (for example,
`upnpumpkin-v0.0.8`). It builds the source at that tag, signs and verifies the plugin with
`PLUGIN_SIGNING_KEY`, uploads the `.wasm` and `.sha256` assets, then publishes the verified plugin
and listing metadata to Pumpkin Market using `MARKET_API_TOKEN`. When the tagged plugin's release
engine is Static Hermes, it also prepares that source's pinned Hermes toolchain before rebuilding. It
reuses and verifies a complete existing asset pair; a partial pair fails so it cannot silently replace
release files.
If the workflow reports a partial pair, remove the lone asset from the release and rerun it.
A release marked immutable without its asset pair cannot be recovered through this workflow.

## Signing

Pumpkin can check a plugin's integrity: a signed `.wasm` carries two custom sections,
`pumpkin.metadata` (plugin name, version, developer, issue time) and `wasm_signature` (an Ed25519
signature over the code plus the metadata, and the public key). Pumpkin loads unsigned plugins with
a warning unless `allow_unsigned = false` is set in its config. Signing is optional here.

`pnpm package` builds each production plugin with its configured engine (Static Hermes by default),
then copies built plugins into `dist/` and writes checksums; it does not sign files or warn when they
are unsigned. CI always prepares a key and uses
the reusable [`sign-pumpkin-plugin` action](../actions/sign-pumpkin-plugin/README.md) to sign every
collected plugin from a metadata manifest. It then runs the
[`verify-pumpkin-plugin` action](../actions/verify-pumpkin-plugin/README.md) against the same
manifest, pinning verification to the public key derived from that run's signing key. Pushes use the
repository secret when available, while pull requests and pushes without the secret use an ephemeral
key. CI uses the verified signed files for integration tests. The ephemeral key is only for checks;
release jobs never receive it. Release jobs use the signing action to sign the exact build artifact
after checking that the release tag points to the commit that produced the build. The signed `.wasm`
and refreshed `.sha256` go to the GitHub release. Before Market upload, CI verifies that signed
artifact against the expected plugin name and version, then removes its publisher signing sections;
Market signs each public download itself.

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

A plugin is tracked only if it is listed in **both** release-please files. `pnpm gen` adds it to both
automatically. Packages that are not ready to release can stay out of both files and be documented
in `release-please-paused.json` with a reason. The release config check verifies that paused package
paths exist and are not tracked. To resume a package, remove it from that file and add it to both
release-please files.

A first release has no tag boundary, so the release helper scans full history. Pausing an unreleased
plugin prevents it from triggering that scan on every release run; it remains in the workspace and
normal build and test workflows.

If you ever create a plugin by hand, do these three things:

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

3. Start the plugin at version `0.0.0` in its `package.json`. After the pinned `0.0.1` first
   release, a `feat!:` breaking change bumps `0.0.X` to `0.X.0`; a regular `feat:` or `fix:` bumps
   the patch while the current version is below `1.0.0`. Once `1.0.0` has been released, normal
   SemVer applies: `feat:` bumps minor and a breaking change bumps major.

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
> keeps hyphens. In JavaScript actions, import the shared `getInput()` helper from
> `actions/common/src/utils.mjs` and pass the input name exactly as declared, such as
> `getInput('plugin-name')`.
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
| `scripts/check-release-config.mjs` | a plugin, action or public tool is missing from either release-please file, a paused plugin is still tracked, an action is not using the `simple` strategy, `component` isn't the folder name, the manifest and package/version file disagree, an unreleased component lacks its required first-release pin, or a released one still has it |
| `scripts/package-metadata.mjs` | a `package.json` has an incorrect derived license, homepage, repository or bugs field, lacks a short description, or a library lacks `sideEffects`, `module` or `types`. Public npm tool engines must match `.node-version`. `--fix` writes derived fields |
| `scripts/check-docs.mjs` | a package has no README, a link, heading or path in the docs doesn't exist, a `pnpm` command isn't a script, a doc page isn't in the docs index, a root script isn't documented, or a CI job isn't in the table above |

`pnpm test:scripts` runs the tests of those three, `scripts/unpin-release-as.mjs`,
`scripts/changed-areas.mjs`, the bundled release commit selector,
and the agent hooks, using fixtures and throwaway repos. Action README generation and example
version updates are covered by `pnpm --filter @pumpkin-plugins/docs test`. See "Docs match the code" in
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
rebuilding it. Its runner is declared in [`action.yml`](../actions/publish-to-pumpkin-market/action.yml).

In this repo, the `market` job downloads the `.wasm` produced by the build job, resolves the plugin's
canonical name from its info module, and passes the per-plugin Release Please version and changelog
to the action using its local path. After a successful publish, the job generates localized
description from `info.description` and the plugin README, and generates command metadata from
`info.commands`. The description omits generated README blocks plus the `Installation` and
`Commands` sections. The job then calls the metadata action with the numeric listing ID returned by
the publisher. The metadata action sends a patch, so it leaves the listing's other fields to the
Market listing editor. Builds aren't byte-reproducible, so the job must upload the artifact rather
than rebuild.

The action looks up the canonical plugin name by searching a limited result set and requiring an
exact name match. It never creates a listing: listing
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
2. Create and install a GitHub App on this repository with `actions` read and `contents`, `issues`
   and `pull-requests` write permissions. Add its Client ID as the `RELEASE_APP_CLIENT_ID` Actions
   variable and its private key as the `RELEASE_APP_PRIVATE_KEY` Actions secret. The release jobs
   use its installation tokens so release PRs and their updates trigger CI; the benchmark-comment
   job uses them to read artifacts from earlier workflow runs and upload its chart attachment.
3. Add the Ed25519 signing key as the `PLUGIN_SIGNING_KEY` secret (see [Signing](#signing)).
   Non-release checks use an ephemeral key, but the release workflow requires this secret to publish
   signed artifacts.
4. For market publishing: create a Market API key with the `plugins:update` and
   `plugins:versions:upload` scopes, then add it as the `MARKET_API_TOKEN` repository secret. Keep
   the key out of the repository and chat messages.
5. Optional: add the Codecov repository upload token as the `CODECOV_TOKEN` Actions secret to publish
   coverage from protected branches and same-repository runs. Public fork pull requests can use
   Codecov's tokenless upload setting. The `codecov.yml` project status compares coverage with the
   base commit and allows a drop of up to 1 percentage point to avoid failing on small fluctuations.
