---
navigation:
    category: CI and releases
---

# Publishing public npm tools

The public npm package set and dependency order are defined in
[`tool-packages.mjs`](../scripts/utils/tool-packages.mjs). Use that source for the current names,
workspace paths, and release order; this guide does not duplicate the list.

For initial setup, publish metadata-only placeholders at `0.0.0`. Release Please produces and the
GitHub Actions release workflow publishes the first functional release for each package.

## Seed package names

npm requires a package to exist before a trusted publisher can be configured. Publish one
`0.0.0` placeholder for every package in the canonical list before setting up trusted publishing.
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
first functional version is `0.1.0`. Merge release PRs in the canonical order from
[`tool-packages.mjs`](../scripts/utils/tool-packages.mjs), so each consumer's required public
dependencies are available before its publish job runs.

The `ci.yml` caller invokes the reusable release workflow after CI gates pass. Its `publish-tools`
job runs only when Release Please reports public tool paths to release. The job packs and validates
those packages sequentially, checks exact dependency versions and registry integrity, then publishes
missing versions with npm trusted publishing and provenance. See
[Trusted publishing for npm tools](npm-trusted-publishing.md) for setup and recovery.

Configure trust for a package only after its placeholder exists and its real Release Please release
is ready. The first successful OIDC publish must complete within two days of creating the
relationship. Publishing the existing `0.0.0` placeholder again does not validate OIDC.

`pnpm npm:bootstrap` is available as a manual exact-tag fallback for a maintainer who must publish
a `0.1.0` artifact directly. It validates the tagged source and package but does not configure npm
trust. The normal first functional release uses the Release Please workflow above.
