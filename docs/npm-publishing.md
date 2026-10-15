---
navigation:
    category: CI and releases
---

# Publishing public npm tools

Public npm tools are discovered from package manifests under `tools/` that declare
`publishConfig.access: "public"` and are not private. Their package manifests and packed project
templates declare the dependencies that determine release order.

For initial setup, publish metadata-only placeholders at `0.0.0`. Release Please produces and the
GitHub Actions release workflow publishes the first functional release for each package.

## Seed package names

npm requires a package to exist before a trusted publisher can be configured. Publish one
`0.0.0` placeholder for each public tool before setting up trusted publishing.
Each placeholder contains only `package.json` and a README that says the package is non-functional.
It must not contain runtime code, commands, or package dependencies.

Publish each verified placeholder tarball with the `placeholder` dist-tag:

```sh
npm publish <placeholder-tarball> --access public --tag=placeholder
```

The registry also assigns the first published version to `latest`, so both tags point to `0.0.0`
until the first functional release. The release workflow publishes without a non-default tag, moving
`latest` to the functional version while `placeholder` remains on `0.0.0`.

Run direct npm commands from outside the repository root, such as `/tmp`, to avoid the root
`devEngines` package-manager requirement. Confirm the exact package name and `0.0.0` version on the
public registry after each publish. Do not republish a placeholder version with different bytes;
npm versions are immutable.

## Publish functional releases

Release Please creates the first functional release PR for each registered tool. The configured
first functional version is `0.1.0`. The publish job orders selected tools from their declared
production dependencies and packed project templates, so each consumer's required public
dependencies are available before its publish job runs.

Release PR titles use the full `@pumpkin-plugins/<name>` package name for scoped tools, while tags
keep using the folder component. The unscoped `create-pumpkin-plugin` title stays unscoped.

The `ci.yml` caller invokes the reusable release workflow after CI gates pass. Its `publish-tools`
job runs only when Release Please reports public tool paths to release. The job packs and validates
those packages sequentially, checks exact dependency versions and registry integrity, then publishes
missing versions with npm trusted publishing and provenance. See
[Trusted publishing for npm tools](npm-trusted-publishing.md) for setup and recovery.

If a GitHub release exists but its npm job was skipped, dispatch the `ci.yml` caller with the full
commit SHA that the release tag targets. For codemod, resolve its tag before dispatching:

```sh
release_commit="$(git rev-parse 'codemod-v0.1.0^{commit}')"
gh workflow run ci.yml --ref master -f release_commit="$release_commit"
```

This recovery reads existing GitHub releases without creating release tags or PRs, selects only npm
tools whose tags point to that exact SHA, then checks out the same source commit for packing. Normal
push releases remain pinned to the commit built by their own workflow run. Replace the tag with the
target tool's release tag when recovering another package.

Configure trust for a package only after its placeholder exists and its real Release Please release
is ready. The first successful OIDC publish must complete within two days of creating the
relationship. Publishing the existing `0.0.0` placeholder again does not validate OIDC.

`pnpm npm:bootstrap` is available as a manual exact-tag fallback for a maintainer who must publish
a `0.1.0` artifact directly. It validates the tagged source and package but does not configure npm
trust. The normal first functional release uses the Release Please workflow above.
