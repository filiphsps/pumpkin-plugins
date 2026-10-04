# CI and releases

Everything is in `.github/workflows/ci.yml`. The shared setup (pnpm, Node, install, Turborepo
cache) is the composite action in `.github/common/bootstrap`.

## Jobs

| Job | Runs | What |
| --- | --- | --- |
| 💬 Commit messages | PRs | Lints every commit with `commitlint.config.mjs` |
| 📋 Lint | always | `pnpm lint`: Biome, then the JSDoc check (see [Code style](code-style.md)) |
| ✅ Typecheck | always | `pnpm typecheck` |
| 🧪 Test | always | Unit tests, and the tests of the repo checks (`pnpm test:scripts`) |
| 📝 Docs and config | always | README generation succeeds, and `pnpm check` passes: release config, package metadata, docs against the code |
| 🔨 Build | after lint and typecheck | Builds every plugin and uploads them as an artifact |
| 🎃 Integration | after build | Runs the integration tests against the pinned Pumpkin release (downloaded and checksum-verified); server logs are uploaded on failure |
| 🧬 Generator | after lint | Generates a throwaway plugin with `pnpm gen` and typechecks, builds and integration-tests it |
| 🚢 Release | `master` pushes, after the checks | release-please, then keeps the release PR's READMEs and `release-as` pins current |
| 📎 Attach, 🛒 Market | per released plugin | Checks the tag is the commit this run built, then uploads the `.wasm`; the market step is a stub |

## Merging

Pull requests are **rebase-merged**, never squashed. Every commit lands on `master` as written, and
release-please reads each one, so every commit message must be a conventional commit:
`feat(scope): ...`, `fix: ...`, `feat!: ...` for breaking changes. The commit lint enforces it.

Only commits that touch a plugin's directory release that plugin. A change under `tools/` that
should ship in plugin builds needs a commit touching each affected plugin, or a `Release-As:`
footer.

## Releases

On `master`, once the checks pass, [release-please](https://github.com/googleapis/release-please)
keeps one release PR up to date from the conventional commits. Merging it:

- bumps each changed plugin's version and changelog,
- tags it `<folder>-v<version>` and creates its GitHub release,
- attaches `<folder>.wasm` and `<folder>.wasm.sha256`, taken from the artifact the build job made
  in the same run.

The merge of a release PR is a commit of its own, so the push it triggers starts a run while the run
for the commit before the merge can still be going. Whichever reaches the release job first creates
the tag and the release, which is usually the older run, and the artifact it holds was built from an
earlier commit. The attach job therefore resolves the tag first and refuses to upload unless it
points at the commit that run built, which leaves the release to the run for the released commit.

Each time release-please creates or updates the release PR, the release job regenerates the READMEs
and pushes a `docs: update generated READMEs` commit to the PR branch, so they are current when the
release merges. The same run retires the `release-as` pin of any plugin the PR releases (see below).
release-please rewrites its branch on every update, so those commits are re-added each time.

## Signing

Pumpkin can check a plugin's integrity: a signed `.wasm` carries two custom sections,
`pumpkin.metadata` (plugin name, version, developer, issue time) and `wasm_signature` (an Ed25519
signature over the code plus the metadata, and the public key). Pumpkin loads unsigned plugins with
a warning unless `allow_unsigned = false` is set in its config. Signing is optional here.

`pnpm package` (`scripts/collect-plugins.mjs`) signs every plugin when the `PLUGIN_SIGNING_KEY`
environment variable is set; the CI `build` job passes it from the repository secret of the same
name. The `.sha256` next to each `.wasm` is of the signed file, so it matches what is released.

| Situation | Result |
| --- | --- |
| `PLUGIN_SIGNING_KEY` is a valid key | Plugins are signed |
| Not set or empty (forks, local runs) | Plugins are collected unsigned and a warning annotation (`::warning title=Plugins are unsigned`) is shown; the build doesn't fail |
| Set but not 64 hex characters | The step fails: a misconfigured secret must not silently ship unsigned |

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

## Repo checks

`pnpm check` runs three scripts, each of which says exactly what is wrong. CI runs it in the
`📝 Docs and config` job, and the `🧬 Generator` job runs it on a freshly generated plugin, so the
generator and the checks can't drift:

| Script | Fails when |
| --- | --- |
| `scripts/check-release-config.mjs` | a plugin is missing from either release-please file, `component` isn't the folder name, the manifest and `package.json` versions disagree, an unreleased plugin lacks `release-as: 0.0.1`, or a released one still has it |
| `scripts/package-metadata.mjs` | a `package.json` lacks the license, author, contributors, homepage, repository, bugs, funding or a short description, or a library lacks `sideEffects`, `module`, `types`, `files` and `publishConfig`. `--fix` writes everything but the description |
| `scripts/check-docs.mjs` | a package has no README, a link, heading or path in the docs doesn't exist, a `pnpm` command isn't a script, a doc page isn't in the docs index, a root script isn't documented, or a CI job isn't in the table above |

`pnpm test:scripts` tests the three against throwaway repos, and `scripts/unpin-release-as.mjs` on
its own. See "Docs match the code" in [Code style](code-style.md).

## Not implemented: publishing to market.pumpkinmc.org

The `market` job and `scripts/publish-to-market.mjs` are a stub. They report what would be uploaded
and emit a warning annotation per released plugin; nothing is sent. The upload API isn't publicly
documented, so the script's header lists what has to be settled first: the endpoint, the
`MARKET_API_TOKEN` secret, whether the market signs builds itself or expects them pre-signed, and
what metadata it needs. Builds are [signed](#signing) with our own key when `PLUGIN_SIGNING_KEY` is
set, which may not be what the market expects. Builds aren't byte-reproducible, so the upload must
use the build job's artifact.

## GitHub settings

These aren't done by the workflows:

1. Settings, General, Pull Requests: enable **Allow rebase merging** only. Disable squash and merge
   commits.
2. Settings, Actions, General: enable **Allow GitHub Actions to create and approve pull requests**.
3. Optional: add a PAT or GitHub App token as the `RELEASE_PLEASE_TOKEN` secret. Without it, CI
   doesn't run on the release PR, because GitHub doesn't trigger workflows for events created with
   `GITHUB_TOKEN`. That includes the README commit.
4. Optional: add the Ed25519 signing key as the `PLUGIN_SIGNING_KEY` secret (see [Signing](#signing)).
   Without it, plugins are released unsigned.
5. Later, for market publishing: add the API token as the `MARKET_API_TOKEN` secret. Nothing reads it
   yet beyond reporting whether it is set.
