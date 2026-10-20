---
navigation:
    category: Repository maintenance
title: "CI and releases"
description: "Which checks run for each change, how releases are prepared, and how plugins reach the Market"
---

# CI and releases

Use this guide to see which checks your change runs, how to read their results, and what happens after
a release PR merges. The main workflow, `.github/workflows/ci.yml`, classifies changes and selects
checks for plugins, repository code, actions, extensions and public tools. It calls the reusable
external-consumer workflow at `.github/workflows/external-consumer.yml` to make sure published tools
work outside this monorepo.

After the `🛡️ CI result` check passes, `.github/workflows/release.yml` handles releases. The reusable
`.github/workflows/extensions.yml` checks changed extensions. `.github/workflows/docs.yml` checks the documentation and, outside forks, publishes the
VitePress site, then mirrors it to `gh-pages`. GitHub workflow validation runs separately in
`.github/workflows/actionlint.yml`. `.github/workflows/issue-forms.yml` validates the chooser, the
issue forms and the label catalog; `.github/workflows/issue-intake.yml` checks new and edited issue
bodies and manages `status: needs info` and `status: needs triage` for incomplete submissions.

Most jobs use the shared setup in `.github/common/bootstrap` for pnpm, Node, dependencies and the
Turborepo cache. Most CI jobs run on `ubuntu-26.04`; external-consumer checks also run on `macos-15`
and `windows-2025`.

Only default-branch pushes save the pnpm store and Turborepo caches; pull requests and other runs
restore those entries without saving their own, because a pull request's cache is visible only to
that pull request. Cache keys separate runner OS, architecture and job. Engine comparison adds its
matrix variant as a `cache-suffix`, so parallel variants do not reuse each other's build outputs.
Restores first look for the same job and variant from an earlier commit, then fall back to shared
task caches. Turbo still
checks each task's inputs before reusing outputs. The benchmark's real-server tests run even when a
build comes from cache. Malloc variants keep their WASI archives and prepared-build fingerprint in
a separate cache keyed to the pinned Static Hermes toolchain. This keeps those files separate from
the shared Hades snapshot. Building malloc also rewrites the host build's compiler export, which the
malloc fingerprint records, so that cache holds the export too and is restored after the Hades
build check.

Build saves the prepared Static Hermes build only when no cache matched its key exactly, so
Integration and Generator can restore it later in the same run. External consumer saves its pnpm
store and Static Hermes build only on `master` pushes, once per key; pull requests only restore them.

Release Please branches (`release-please--branches--...`) skip the CI, Docs, Actionlint and benchmark
comment jobs. The commits being released have already passed validation. Release PR updates add the
generated version and changelog, and the release workflow prepares generated READMEs and first-release
pins.

## Jobs

| Job | When it runs | What happens |
| --- | --- | --- |
| 🔍 Changed files | CI-triggering changes | Classifies plugin and repository code, action and extension directories, documentation, and label configuration. It also selects integration suites and generator smoke checks, detects generated README refresh commits, and writes the list of jobs the change needs. |
| 🔍 Lint GitHub workflows | Pull requests, default-branch pushes, and manual runs | `actionlint` checks the workflow files. It skips Release Please branches and changes limited to label configuration. |
| 💬 Commit messages | Pull requests that change code, actions, extensions, or generated READMEs | Checks every commit with `commitlint.config.mjs`. |
| 📋 Lint | Code or action code changes | Runs `pnpm lint`, which runs Biome followed by the JSDoc check (see [Code style](code-style.md)). |
| ✅ Typecheck | Code changes | Runs `pnpm typecheck`. |
| 🧪 Test | Plugin, repository or action code changes | Runs workspace behavior suites and script, hook and action tests with `pnpm coverage`. Merges Node process coverage with package reports in Codecov and retains coverage evidence. Tooling coverage is gated with a 1 percentage-point tolerance; plugin guest coverage is informational until WASM execution can be measured. |
| 📦 External consumer | Code changes | Packs public tools with their workspace dependencies, checks packed metadata and starter dependency ranges, then installs and builds the creator's TypeScript and JavaScript starters and runs `pumpkin-codemod list` outside the repository. Linux x64 runs for every code change. macOS arm64 and Windows x64 run on `master` pushes and on pull requests that change a public tool, its workspace dependencies or their lockfile entries, workspace-wide configuration, or the external consumer test. All use pinned Node and pnpm versions. |
| 🧪 Extension tests | Extension changes that need checks | The reusable workflow lints, typechecks, tests and packages each changed extension. |
| 📝 Docs and config | Code, action, extension, generated README, or docs-only `master` pushes | Checks that generated READMEs are current and runs `pnpm check` for release configuration, package metadata and docs-to-code links. |
| 🔨 Build | Code changes, after change classification | Prepares Static Hermes while lint and typecheck run, then builds each production plugin with its configured engine (Static Hermes by default). It loads one Static Hermes plugin on a real server as a smoke test, then signs and verifies the artifacts. |
| 📊 Engine comparison | Changes to the benchmarks or the packages and workflow they build and run, and every code push to `master`; after build | Calls `.github/workflows/engine-comparison.yml` through `workflow_call`. `benchmarks/engine-comparison/scripts/write-engine-comparison-matrix.ts` lists the parallel jobs: one per engine variant, plus Static Hermes stack-guard checks. A report job validates and combines their results from real Pumpkin servers. |
| 📈 Engine comparison comment | Successful PR CI runs with a benchmark report, including runs for pull requests from forks | Finds the open pull request whose head matches the run, compares the report with the latest matching default-branch run, updates one PR comment, and embeds an SVG chart of timing changes. |
| 🎃 Integration | Plugin or suite-dependency changes, workspace-wide build configuration, or shared integration setup changes; after build | Runs affected packages and their dependents against the pinned Pumpkin release. Workspace-wide or shared integration changes run the full suite. The job reuses WASM files from Build. |
| 🧬 Generator | Scaffold, generator setup, or generated-plugin dependency changes; after lint and build | Reuses Build's Static Hermes cache, generates a throwaway plugin, action and extension, checks release registration and READMEs, tests the action and extension, and typechecks, builds and integration-tests the plugin. |
| 🛡️ CI result | Every CI run outside Release Please branches, after every job except Engine comparison | The single required check. It fails when a job the change needs didn't succeed, or when any job failed or was cancelled. |
| 🚢 Release | `master` pushes after CI result passes, including docs-only pushes | Calls the reusable release workflow. It catches up pending releases and refreshes every open release PR; Actions get GitHub releases, extensions get VSIX assets, public tools publish npm tarballs, and plugins get signed artifacts and Market listings. |
| 📝 Prepare release PR | Every open release PR on a release run | Refreshes plugin and extension READMEs, action README examples, starter dependency ranges and first-release pins. |
| 📎 Publish | Each released plugin | Runs `publish-plugin-release.yml`, which the `Recover plugin release` workflow also uses for one tag. It confirms the tag points to the release commit, signs, verifies and uploads the artifact unless the release already has it, publishes it to an existing Market listing, and syncs its description and commands. |

The signed `plugins` build artifact stays available from the run summary for one day; the build job
summary includes a direct download link. The integration WASM files and their fixture also expire
after one day instead of being deleted, so they stay available when you need to rerun a failed job
or release. Failure logs remain available for diagnosis.

The Docs workflow uploads its `docs-site` and `github-pages` artifacts only on pushes, where the
publish job uses them, and lets them expire after one day. The benchmark-comment workflow keeps the
combined report for its post-CI run and stores chart SVGs on the `benchmark-charts` branch, where
artifact expiry doesn't remove them. Each publish replaces that branch with a single commit that has
no parent and holds only the charts of the newest 100 runs, so it never grows a history; PR comments
from older runs lose their chart image.

## Reading CI results

Start with the job summary to see what ran for your change. Test jobs combine Vitest's package
reports into one table with command outcomes, elapsed time and freshly executed test counts. The
table keeps expected failures, skipped tests and todos separate from passes. Expand flaky-test links
or unfamiliar reporter output for details; use the step logs for failure annotations and full
diagnostics. Cached suites and Node test results are labeled separately, so they aren't counted as
fresh Vitest passes.

The Build summary lists component builds, the runtime smoke check, plugin names and versions,
component sizes and the signed artifact download. Its signing note says the artifacts carry a CI-only
key. The Build smoke test doesn't create a separate Vitest report. Extension
checks link the VSIX download, the Docs workflow links the published site, release orchestration
lists released components and release PR counts, and upstream-pin jobs link the source diff. Before
expensive checks start, the selected-checks summary explains why each job is in scope. Step
failures, cancellations and skips appear in the job's step list, not in the summary.

`scripts/ci-run.mjs` captures summaries from child processes while keeping their console output,
annotations and command failures. `scripts/ci-summary.mjs` and `.github/common/job-summary` can then
render the job result even after a command fails. Vitest's built-in GitHub reporter provides the
test output without another reporting action or extra token permissions. The Docs workflow saves its
summary tools before switching the checkout to the `gh-pages` mirror, so it can still report the
publish result.

## Running only what a change needs

CI compares each change with the pull request base or the push's `before` commit. The
`scripts/changed-areas.mjs` classifier uses that diff to select checks. Both it and
`scripts/utils/release-commits.mjs` ignore commits listed in `.git-blame-ignore-revs`, which is also
GitHub's blame-ignore list. Add a short reason above each SHA so future entries keep their context.

The classifier scopes checks this way:

- Markdown, files under `docs/`, component-level `docs/` folders and `LICENSE` changes count as
  documentation. A docs-only pull request runs the separate Docs workflow to check the docs and
  build the site. The main CI pull-request path filter excludes ordinary Markdown and guide changes,
  but re-includes root, package, action and extension README paths so generated README commits can
  run the generated-content check. On `master`, the push path filter also includes documentation
  changes. The classifier skips code-dependent jobs, while Docs and config and the release workflow
  run after CI result passes. That release run catches up pending merged releases and updates and
  prepares every open release PR. Mixed changes run checks for their code or action changes as well.
- Changes under `actions/{name}/` and `extensions/{name}/` are selected separately from plugin and
  repository code. Both skip the plugin build and integration suites. Action code changes run Lint
  and the coverage job, which runs every action's tests, so the tooling gate receives a complete
  report. CI calls the reusable extension workflow for each changed extension; extension-only
  changes skip the coverage job. Action tests live beside the implementation in
  `actions/{name}/src/*.test.mjs`, and shared-helper tests live in `actions/common/src/*.test.mjs`.
  The `common` helper isn't a release component. README, changelog and version-file-only changes
  skip action tests.
- Everything else is plugin or repository code, including changes under `tools/`, `scripts/` and
  `.github/`, as well as deletions. `.github/labels.yml` and `.coderabbit.yaml` are exceptions:
  changes limited to those two files still start CI and Actionlint so they can report successful
  skips. If a code or workflow file changes alongside them, the relevant checks run.

Real-server integration runs when a change affects plugin code or dependencies used by the
integration suites, or changes workspace-wide build configuration or shared integration setup.
Package changes select the affected integration suites and their dependents. Lockfile importer
changes select the importer packages and their dependents; catalog-only workspace changes use the
same importer scope. Other workspace-wide
changes, lockfile changes without importer-level changes, and changes to the integration workflow or
its local actions run the full suite. Unrelated scripts and workflow files skip integration.
Benchmark-only changes use Engine comparison instead. On pull requests, Engine comparison runs only
when the benchmark packages, their workspace dependencies or the comparison workflow change; every
code push to `master` runs it so pull requests have a baseline. Biome, the type checker and unit
tests don't read docs, so documentation-only changes cannot fail those checks.

The main CI `📝 Docs and config` job runs for code, action and extension changes, the automatic
`docs: update generated READMEs` commit, docs-only `master` pushes, and included README changes. A
Release Please branch update can trigger CI, Docs and Actionlint at the GitHub level, but their jobs
skip those branches: the source commit has already passed validation, and the release workflow
prepares generated READMEs and first-release pins. The benchmark-comment workflow skips them too.
Pull requests that change only guide pages or other Markdown outside the included README paths skip
the main CI workflow entirely.

On `master`, a push made up only of `chore(master): release ...`,
`chore: retire first-release pins`, starter tool version sync and generated README commits skips
unit and script tests, external-consumer tests, real-server integration, generator smoke tests and
Engine comparison. `scripts/changed-areas.mjs` holds these commit subjects, and CI result accepts
these intentional skips. Build, lint, typecheck, Docs and
config checks, and release processing still run when needed.

Docs-only pushes also run Docs and config plus the release workflow after CI result passes.
This lets a documentation fix trigger release catch-up and rebase the open Release Please PRs without
running plugin builds or tests.

`scripts/ci-gate.mjs` holds one table of which jobs each change needs. The `🔍 Changed files` job
writes that selection as its `jobs` output, every job's `if:` reads its own entry, and
`🛡️ CI result` checks the results against the same selection. A push can release only after CI
result passes. Engine comparison runs separately and does not gate releases. Release Please only
creates a release for a component with releasable changes, so running it after an action code
change doesn't create an empty release.

To add a CI job, add its row to the table in `scripts/ci-gate.mjs`, read it in the job's `if:`, and
add the job to the `needs` of `🛡️ CI result`; `scripts/workflows.test.mjs` fails when one of these
is missing. Keep downstream jobs in mind: if a selected job is skipped, the jobs that need it are
skipped too, and CI result reports each of them.

## Label management

`.github/labels.yml` is the full label catalog for the repository. Add `ai_apply_when` only to labels
CodeRabbit is allowed to apply. Each plugin package needs a `plugin: <Name>` label whose
`ai_apply_when` names `packages/<dir>/`.

`reviews.labeling_instructions` in `.coderabbit.yaml` is generated from the catalog. After editing
`.github/labels.yml`, run `node .github/scripts/coderabbit-labels.mjs` and commit both files.
Issue form validation runs the same script with `--check` on pull requests and fails when the
catalog is invalid, a plugin has no label, or `.coderabbit.yaml` is out of date.
CodeRabbit applies labels using those instructions. The `ready-for-agent` and `ready-for-human`
labels remain outside its eligible set.

After a catalog change reaches `master`, the label-sync workflow drops `ai_apply_when`, syncs the
labels to GitHub and leaves labels outside the catalog untouched.

## Updating upstream runtime pins

`Update upstream pins` runs daily, and you can start it manually. To add a source, register its
repository, branch and pinned field in `.github/upstream-pins.json`, then add a pin file that follows
the appropriate schema in `schemas/`. The catalog also supplies labels and the command used to
validate an update.

The workflow compares each pin with its branch tip, validates any update, and refreshes a dedicated
pull request. If validation fails, it closes that PR and creates or updates an issue. When
validation passes again, it closes the issue and opens a new PR. Both include the
configured labels and a compare link. Static Hermes validation prepares the pinned runtime by
checking out its source and applying the patch series in order. It uses the same pinned CMake and
Ninja setup as CI.

## Merging

Pull requests are **rebase-merged**, never squashed. Rebase merging preserves each commit on
`master`, where Release Please reads it to create changelog entries and choose version bumps. Give
every commit a conventional message such as `feat(scope): ...`, `fix: ...`, or `feat!: ...` for a
breaking change; commit lint enforces this format.

For plugins, the release selector follows source modules reachable from each plugin entry and the
workspace build tool, along with explicitly bundled assets. A shared fix appears in each affected
plugin's changelog, starting from that plugin's own previous release. Tests, test helpers, generated
build output and documentation aren't shipped code. A dependency-catalog change counts only if it
changes an entry used by those source modules; a change to the shared TypeScript configuration counts
for every plugin.

## Releases

After the required checks pass on `master`, [Release Please](https://github.com/googleapis/release-please)
keeps a separate release PR up to date for every plugin, action, VS Code extension and public npm
tool with releasable conventional commits. Public npm tools release independently: a dependency
change can release that dependency without creating PRs for every tool that consumes it. A tool's
own shipped files and packed templates determine whether it needs a release PR. Its npm dependencies
still determine publishing order, and a tool PR waits until all of its transitive public production
dependencies have functional releases.

When you merge a plugin release PR, the workflow updates each changed plugin's version and generated
changelog, creates a `<folder>-v<version>` tag and GitHub release, and attaches the `<folder>.wasm`
and `<folder>.wasm.sha256` files from the build artifact made in that same run.

Sometimes GitHub rejects release creation because the tag already belongs to an immutable release.
The runner reuses that release's metadata only when its target commit matches the release PR. Only the
run that built that commit can attach its artifact; an older run leaves the attachment for the
matching run. The runner marks the release PR as tagged either way. Other release PRs in the same run
can still publish, while unrelated API errors remain failures.

The matching run also recovers releases already created for configured component versions at its
exact commit, even if another run has marked their PRs as tagged. Newly created and recovered
releases go through the same fan-out, with each tag included once. A successful release run also
checks plugin releases on its first-parent history for releases missing both plugin assets. It
rebuilds each plugin from its tag commit, attaches signed assets, and publishes the release and its
tagged listing metadata to Pumpkin Market. If GitHub release creation succeeded but npm publishing
didn't, a later run can resume publishing; an existing npm version must pass the publisher's
integrity check.

Action release PRs update `version.txt` and `CHANGELOG.md`, create a `<folder>-v<version>` tag and
GitHub release. They don't package plugins, attach WebAssembly files or publish to Pumpkin Market.
VS Code extension release PRs update the `package.json` version and `CHANGELOG.md`, then create the
same style of tag and a GitHub release with the built `<folder>.vsix` attached. They don't package
plugins or publish to Pumpkin Market.

Create and register an extension with `pnpm gen:extension`. The generator adds its independent
Release Please manifest entry and first-release pin. The release-config check then verifies its
README, changelog, package version and tag component.

Actions import shared runtime helpers from `actions/common/src/`, but each action tag contains its
own snapshot of those files. To publish a shared-helper change, include a releasable change under
each consuming action directory.

Release Please discovers public npm tools from package manifests under `tools/` that set
`publishConfig.access: "public"` and aren't private. Their production dependencies and packed
project templates determine release order. Start each package with a metadata-only `0.0.0`
placeholder so you can configure its trusted publisher. Release Please creates the first functional
`0.1.0` release, which the workflow publishes. See [Publishing public npm tools](npm-publishing.md)
for the sequence and [Trusted publishing for npm tools](npm-trusted-publishing.md) for the `ci.yml`
identity, OIDC permissions, two-day validation window, provenance and recovery.

To register a public tool, add its publishable package under `tools/` and run the registration
command. For example, register the codemod package with `pnpm register:tool tools/codemod`; replace
`tools/codemod` with the new package's directory. The command reads the package name from its
manifest, validates public access and the first version, and updates both Release Please files. It
adds a missing first-release pin to an existing entry and rejects a conflicting pin. Public-tool
pack checks find packages from their manifests; add a consumer smoke check only when a user-facing
flow needs it.

The merge of a release PR creates a new commit, so its push can start before the previous push's run
finishes. The older run may create the tag and release first, but its build artifact comes from the
previous commit. The attach job checks whether the tag points to the commit that run built and skips
an artifact when they don't match. The matching run, or a later successful run if it was skipped,
builds the tagged source and uploads the release files.

For push runs, GitHub keeps one run active and one pending in each concurrency group. A newer push
can replace that pending run. To catch up releases from a pending run that was replaced, the npm
publisher scans tool releases on the target commit's first-parent history and publishes missing
versions from their exact tag commits, oldest first. GitHub cancels pull request runs when a newer
run supersedes them.

Release Please creates a tag as soon as it prepares a release, even while the GitHub release is a
draft. That tag gives the next release run a history boundary, so it won't miss the previous release
and repeat its changelog. The release configuration keeps `force-tag-creation` enabled, and the
repository check enforces it.

After each Release Please run, a matrix job finds every open component release PR and prepares its
branch, including branches Release Please didn't return as changed. Discovery retries briefly and
fails if it can't find every PR returned by Release Please. A failed GitHub CLI query also fails the
release workflow instead of silently skipping preparation. The job regenerates plugin READMEs,
generates each action README's input and output tables from its `action.yml`, and updates the
versioned example tag from the action's Release Please manifest entry. Before an action's first
release, the README uses its `release-as` version instead of `0.0.0`.

The preparation job pushes a `docs: update generated READMEs` commit to each release PR branch, so
examples are current when the release merges. In the same run, it removes the `release-as` pin for
any plugin, action, extension or public npm tool whose first release PR advances its manifest
version (see below). Release Please rewrites its branch on each update, so the preparation commits
are added again each time.

Release PRs refresh on every release run, even if their release notes haven't changed.
`always-update` rebases the remaining branches on current `master` after another plugin release
merges, which prevents conflicts in the shared manifest and release configuration. Each refreshed
PR goes through README and pin preparation again. Separate release PRs let you hold one plugin back
without holding another release.

The release, release-PR preparation and benchmark-comment jobs use short-lived installation tokens
from the release GitHub App; [GitHub settings](#github-settings) describes its setup. Each job creates
its own repository-scoped token. The release-PR job uses its token to push prepared README and pin
updates, which then trigger normal pull request checks. The benchmark-comment job uses its token to
read artifacts from earlier runs and publish the SVG as a GitHub attachment in the PR comment.

`scripts/release.mjs` runs the pinned Release Please version through `pnpm dlx`. The root of
`release-please-config.json` sets the pre-1.0.0 version policy for every configured component.
Below `1.0.0`, breaking changes bump the minor version (`0.0.8` to `0.1.0`), while features, fixes
and performance improvements bump the patch. At `1.0.0` and later, normal SemVer applies: breaking
changes bump major, features bump minor, and fixes and performance improvements bump patch. The
release-config check requires `bump-minor-pre-major` and `bump-patch-for-minor-pre-major` and
rejects package overrides that turn either option off.

Before Release Please calculates versions and changelogs, `scripts/utils/release-commits.mjs` adds
shared commits through its plugin hook. If a shipped dependency changes, every plugin that bundles
it gets the change in its notes, and each plugin's bump uses its own current version. Features,
fixes and performance improvements appear in release notes. After publishing, the runner reloads
the manifest before it creates release PRs.

Each plugin's changelog starts after its own latest release. For a first release, notes start at the
commit that added the plugin's `package.json`. Action commits also stop at the action's latest
release so its first-release notes aren't repeated in the next one. If a manifest version has no
matching GitHub release or tag, the helper uses the latest published release with a lower version as
the history boundary. If no such release exists, package paths use the commit that introduced their
`package.json`. The helper fails rather than publish incomplete notes when it can't find a boundary
or enough history; increase `commit-search-depth` if a component has more commits since its
boundary than the configured search can cover.

Changelogs are generated; don't edit them by hand. An empty version-only `Release-As` commit needs a
conventional-commit scope matching the component so only that component is affected.

To preview a release without changing GitHub, set `GITHUB_REPOSITORY` and `GITHUB_TOKEN`, then run:

```sh
pnpm --package=release-please@17.11.2 dlx -c 'node scripts/release.mjs --dry-run "$(command -v release-please)"'
```

Add a `--component` value, such as `--component=apple-skin-pumpkin`, to preview one plugin or action.
Add `--pull-requests-only` to update release PRs without creating tags or GitHub releases.

The catch-up job also prepares the tag's pinned Hermes toolchain when that release uses Static
Hermes. It skips a partial plugin asset pair or an immutable release with a warning because it can't
replace the existing files automatically.

## Signing

Signing lets Pumpkin detect whether a plugin file has changed. A signed `.wasm` carries two custom
sections: `pumpkin.metadata` records the plugin name, version, developer and issue time; and
`wasm_signature` contains an Ed25519 signature over the code and metadata, plus the public key.
By default Pumpkin loads an unsigned plugin and logs a warning. If the server config sets
`allow_unsigned = false`, globally or in a plugin's override, Pumpkin skips unsigned or invalid files
instead of loading them. Local signing is optional, but unsigned local builds won't load on a server
with that setting.

`pnpm package` builds each production plugin with its configured engine (Static Hermes by default),
copies the result into `dist/` and writes checksums. It doesn't sign files or warn that they're
unsigned, regardless of the key environment variable. CI always prepares a signing key and uses the
reusable [`sign-pumpkin-plugin` action](../actions/sign-pumpkin-plugin/README.md) to sign every collected
plugin from a metadata manifest. It then runs the
[`verify-pumpkin-plugin` action](../actions/verify-pumpkin-plugin/README.md) against that manifest,
pinning verification to the public key derived from the same run's signing key.

CI signs with an ephemeral key generated for the run, on pull requests and pushes alike, so the
repository release key never reaches the build job. The verified signed files go to integration
tests; the ephemeral key is only for checks and is never available to release jobs. The release
workflow signs each published asset with the repository key. Before signing a release artifact,
the release job confirms its tag points to the commit that produced the build. It uploads the signed
`.wasm` and refreshed `.sha256` to the GitHub release. Before uploading to Pumpkin Market, CI
checks that the repository key signed the artifact, verifies its expected plugin name and version,
and removes the publisher's signing sections. Market signs each public download itself.

| Situation | Result |
| --- | --- |
| Local `pnpm package` | Always collects unsigned files without a warning, regardless of the key environment variable |
| CI push with a valid repository key | Signs the build and release artifacts with the repository key |
| CI pull request or push without a key | Signs build artifacts with a run-only key; release signing still requires the repository key |
| Signing action receives a malformed key | Fails rather than silently shipping unsigned files |

To set up the repository signing key:

1. Generate a key: `node scripts/generate-signing-key.mjs`. It prints a secret and a public key and
   writes nothing.
2. Settings, Secrets and variables, Actions: add the secret as the repository secret
   `PLUGIN_SIGNING_KEY`. The public key is safe to publish.

To check a downloaded plugin, run `node scripts/verify-plugin.mjs path/to/plugin.wasm`, replacing
the example path with the file you downloaded. It prints the plugin name, version and public key.
It exits with 1 if the file is unsigned or its signature doesn't match.

The signature includes its public key, so Pumpkin 0.2.0 can check that a file is intact but can't
identify who signed it. Server admins decide which publishers to trust by comparing the embedded key
with the publisher's published key.

To rotate the key, generate a new one and replace the repository secret. Releases signed with the old
key remain valid because each file carries its signing key; only the published public key changes.

## Registering a plugin for releases

A plugin is tracked for releases only when it appears in **both** Release Please files.
`pnpm gen` adds it to both. If a package isn't ready to release, leave it out of those files and add
its path and a reason to `release-please-paused.json`. Write the reason as a full sentence that
names what blocks the release: the plugin's README shows it in place of the download link, and the
root README marks the plugin as unreleased. The release-config check verifies that each paused path
exists and isn't tracked. To resume a package, remove it from the paused file and add it to both
Release Please files. A paused package stays in the workspace and continues through normal build and
test workflows.

`pnpm gen` handles release registration for you. If you create a plugin by hand, make these three
updates:

1. Add it to `release-please-config.json`, under `packages`. The `component` must be the folder
   name; it becomes the tag prefix (`my-plugin-v0.0.1`):

   ```json
   "packages/my-plugin": { "component": "my-plugin", "release-as": "0.0.1" }
   ```

   `release-as` makes the first release `0.0.1` regardless of the commits (without the pin, a
   breaking change could make it `0.1.0`). It stays in place until removed, so the release job
   removes it from the release PR with `scripts/unpin-release-as.mjs`. The pin must be gone **before**
   that PR merges: while it remains, `master` fails the release-config check, which both the release
   and attach jobs need. The merged release then won't be tagged or get a `.wasm`. To remove it by
   hand, delete the line from the release PR branch.

2. Add it to `.release-please-manifest.json`, at the same version as the plugin's `package.json`:

   ```json
   "packages/my-plugin": "0.0.0"
   ```

3. Set the plugin's initial `package.json` version to `0.0.0`. After the pinned `0.0.1` first
   release, a `feat!:` breaking change bumps `0.0.X` to `0.X.0`; a regular `feat:` or `fix:` bumps
   the patch while the current version is below `1.0.0`. After `1.0.0`, normal SemVer applies:
   `feat:` bumps minor and a breaking change bumps major.

## Registering an action for releases

Each directory under `actions/` with an `action.yml` or `action.yaml` is an independent release
component. Use `pnpm gen:action` to create the standard files and register a new action. If you set
one up by hand, add it under `packages` in `release-please-config.json` with its folder as the
component, the `simple` release strategy and a first-release pin:

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

Use a JavaScript action (`runs.using: node24`) when it can run on GitHub's built-in Node runtime.
Consumers don't need `actions/setup-node` or a local Node installation for that action. Use a
composite action when it needs to orchestrate workflow steps or support other runner steps.

Add `actions/my-action/version.txt` with `0.0.0`, a `CHANGELOG.md` and the same path at version
`0.0.0` in `.release-please-manifest.json`. Release Please updates the version file and changelog,
and the repository check keeps the action version, manifest and config aligned. The tag is
`my-action-v<version>`. As with plugins, the release PR job removes `release-as` after the first
version is set.

## Repo checks

Run `pnpm check` to validate release configuration, package metadata and documentation. Each script
explains what failed. CI runs the check in `📝 Docs and config` and again on a freshly generated
plugin in `🧬 Generator`, so the generated setup stays compatible with repository checks:

| Script | Fails when |
| --- | --- |
| `scripts/check-release-config.mjs` | A plugin, action, extension or public tool is missing from either Release Please file; either file lists a path that isn't a release component, such as a private benchmark; a paused plugin is still tracked; an action uses a strategy other than `simple`; `component` differs from the folder name; the manifest and package or version file disagree; or a component is missing a required first-release pin or still has one after release. |
| `scripts/package-metadata.mjs` | A `package.json` has the wrong derived license, homepage, repository or bugs field; has no short description; or a library is missing `sideEffects`, `module` or `types`. Public npm tool engines must match `.node-version`. Use `--fix` to write derived fields. |
| `scripts/check-docs.mjs` | A package has no README; a documentation link, heading or path doesn't exist; a `pnpm` command isn't a script; a doc page is missing from the docs index; a root script isn't documented; or a CI job is missing from the table above. |
| `pnpm typecheck:scripts` | The JSDoc types of a release or publish script disagree with its code or its callers. It checks the scripts listed in `tsconfig.scripts.json`. |

`pnpm test:scripts` tests those three scripts, `scripts/unpin-release-as.mjs`,
`scripts/changed-areas.mjs`, the bundled release-commit selector, the agent hooks and the issue-form
and label scripts in `.github/scripts`, using fixtures and throwaway repositories. The docs package
tests action README generation and example-version updates with `pnpm --filter @pumpkin-plugins/docs test`. See [Keep docs in sync with code](code-style.md#keep-docs-in-sync-with-code).

## Publishing to market.pumpkinmc.org

The reusable JavaScript action for publishing to Pumpkin Market lives in
[`actions/publish-to-pumpkin-market/`](../actions/publish-to-pumpkin-market/README.md). Like the
other actions in this monorepo, it has its own directory, metadata and README. Other repositories
can pin a published version like this:

```yaml
uses: filiphsps/pumpkin-plugins/actions/publish-to-pumpkin-market@publish-to-pumpkin-market-v0.0.1
```

Set exactly one of `plugin-name` or `plugin-id` to choose an existing listing. The action also needs
the version, `.wasm` path and Market API token; track, release notes and API URL are optional. It
sends the file it receives without rebuilding it, using bearer authentication and multipart `wasm`
and `metadata` fields in a `PUT /api/plugins/<id>` request. Its runner is declared in
[`action.yml`](../actions/publish-to-pumpkin-market/action.yml).

In this repository, the `market` job downloads the `.wasm` built earlier and resolves the plugin's
canonical name from its info module. It passes the plugin's Release Please version and changelog to
the action by local path. After a successful publish, the job builds a localized description from
`info.description` and the plugin README, then builds command metadata from `info.commands`. The
description excludes generated README blocks and the `Installation` and `Commands` sections.
Relative links and images in the README become GitHub URLs at the plugin's release tag. The job
passes the numeric listing ID returned by the publisher to the metadata action. In its default
`patch` mode, that action sends a partial `PUT` with the description and commands, leaving the
listing's other fields for the Market listing editor.

Builds aren't byte-reproducible, so the job uploads the Build artifact instead of rebuilding the
plugin. When you select a listing by name, the action searches a limited result set for an exact
canonical-name match. It never creates a Market listing; listing metadata and review happen in
Market. By default, the action fails if the plugin isn't listed, hasn't yet been published there,
or the token is missing. With `warn: true`, it reports a warning and continues. This repository
enables that mode so GitHub releases don't depend on a Market listing or credentials. Other Market
API failures still fail the job and can be retried. See the
[action README](../actions/publish-to-pumpkin-market/README.md#inputs) for every input, and
[Pumpkin Market API](pumpkin-market-api.md) for the listing metadata API and its observed behavior.

## GitHub settings

Set these once in GitHub; the workflows can't configure them for you:

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
   Codecov's tokenless upload setting. The existing `codecov.yml` default project status gates
   tooling coverage against the base commit with a 1 percentage-point tolerance. The separate guest
   status is informational because Node coverage cannot measure plugin execution inside WASM.

Forks have neither the release App nor these secrets, so each job that needs them starts its `if:`
with `!github.event.repository.fork` and skips in a fork; `scripts/workflows.test.mjs` fails when one
doesn't.
