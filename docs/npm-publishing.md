---
navigation:
    category: CI and releases
title: "Publishing public npm tools"
description: "How to prepare a public tool for npm and recover a missed release"
---

# Publishing public npm tools

This guide covers the first npm publication and the release path for public tools in `tools/`.
Release automation finds packages whose `package.json` sets `publishConfig.access` to `public` and
does not mark them private. Package manifests and packed project templates also determine which
tools need to publish first.

If you are adding a tool, register it first. For example, register the codemod package with
`pnpm register:tool tools/codemod`; replace `tools/codemod` with the new package's directory. The
[release guide](ci-and-releases.md#releases) explains registration and how Release Please prepares
its release PRs.

## Prepare a package for its first release

npm needs the package name to exist before you can configure its trusted publisher. Plan the
placeholder and first functional release together: the first successful OIDC publish must happen
within two days of creating the trusted-publisher relationship.

Publish one metadata-only `0.0.0` placeholder for each package. Include only `package.json` and a
README that clearly says the package is not functional. Do not include runtime code, commands, or
package dependencies. Publish the tarball you created with the `placeholder` dist-tag; replace the
example path with its actual location:

```sh
npm publish ./path/to/placeholder.tgz --access public --tag=placeholder
```

Run direct npm commands from outside the repository root, such as `/tmp`, because the root
`devEngines` setting requires pnpm. After each publish, confirm the exact package name and `0.0.0`
version on the public registry. npm assigns the first version to `latest` as well, so both `latest`
and `placeholder` point to `0.0.0` until the first functional release. The release workflow then
moves `latest` to the functional version and leaves `placeholder` on `0.0.0`.

Once npm shows the placeholder, configure that package's trusted publisher using [Trusted publishing
for npm tools](npm-trusted-publishing.md). Do this immediately after confirming the package. The
placeholder only reserves the name; it does not test OIDC. Arrange for the first functional release
to publish successfully within two days of setting up trust. npm versions are immutable, so do not
try to republish `0.0.0` with different contents.

## How functional releases reach npm

Release Please prepares a release PR after the tool has releasable changes and its transitive public
production dependencies have functional releases. The first functional version is `0.1.0`. When the
PR merges, `ci.yml` runs its required checks and calls the reusable release workflow. That workflow
publishes the released tools in dependency order, including dependencies declared in packed project
templates.

Before publishing, the workflow checks the release tag, packed files, exact dependency versions, and
the integrity of versions already on npm. If a newly published dependency has not reached the
registry yet, it retries the lookup for up to about two minutes. The publish uses npm trusted
publishing and provenance; GitHub does not need an npm write token. See [Trusted publishing for npm
tools](npm-trusted-publishing.md) for the required workflow identity, OIDC setup, and validation
window.

Every normal release run also checks earlier non-draft tool releases on the target commit's
first-parent history. If an earlier version is missing from npm, the workflow publishes it from its
original release commit, oldest first, before publishing the current tools. This catches up a release
when a newer push replaces an older pending CI run. A version lower than the package's current
`latest` is published with the `backfill` dist-tag, so `latest` stays on the newest release. The
workflow doesn't publish prerelease versions.

Release PR titles use the full `@pumpkin-plugins/<name>` for scoped tools, but their tags use the
Release Please component name (the tool folder name). The `create-pumpkin-plugin` title remains
unscoped.

## Recover a missed publish

The normal workflow checks for missing npm versions on later runs. To recover one immediately without
another push, dispatch `ci.yml` on `master` with the full commit SHA targeted by the existing release
tag. For example, resolve the codemod tag and dispatch that commit:

```sh
release_commit="$(git rev-parse 'codemod-v0.1.0^{commit}')"
gh workflow run ci.yml --ref master -f release_commit="$release_commit"
```

For another tool, replace `codemod-v0.1.0` with its release tag. The recovery run reads existing
GitHub releases and selects only npm tool releases whose tags point to the requested commit. It
packs from that exact source commit and does not create release tags or PRs. Normal push releases
remain pinned to the commit built by their own workflow run.

## Manual first-release fallback

If you must publish the first functional version directly, `pnpm npm:bootstrap` can publish the
validated `0.1.0` artifact from its exact release tag. For example:

```sh
pnpm npm:bootstrap -- tools/codemod --tag codemod-v0.1.0 --expected-owner your-npm-username --confirm-write-access
```

Replace the package path, tag, and `your-npm-username` with values for the tool you are publishing.
Authenticate to npm as that user and enable account-level two-factor authentication first. The command checks the
tagged source, packed package, dependencies, registry integrity, and npm account before it
publishes. It does not configure trusted publishing or count as the first successful OIDC publish,
so the two-day validation window still applies. Use the normal Release Please workflow for
functional releases whenever possible.
