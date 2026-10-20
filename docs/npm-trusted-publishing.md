---
navigation:
    category: CI and releases
title: "Trusted publishing for npm tools"
description: "npm OIDC setup, workflow identity, validation window, provenance and recovery"
---

# Trusted publishing for npm tools

The release workflow publishes public tools through npm trusted publishing. GitHub Actions
authenticates with OpenID Connect (OIDC), so the workflow does not need an npm write token in
GitHub secrets.

## Before you configure a package

npm needs the package to exist before you can configure its trusted publisher. First publish and
confirm the metadata-only `0.0.0` placeholder described in [Publishing public npm
tools](npm-publishing.md), then add the trusted publisher right away. The placeholder has no
working package code and does not validate OIDC. Release Please publishes the first functional
version, and it must succeed through OIDC within two days of creating the relationship. Schedule
the placeholder and trusted-publisher setup when that release can finish in the window.

You need write access to each package, account-level two-factor authentication, and npm CLI
`11.15.0` or newer to run `npm trust`. Check your version with `npm --version`; update it with
`npm install --global npm@^11.15.0` if needed.

npm allows `npm stage publish` by default for new trusted publishers. The `--allow-publish` flag also
allows direct `npm publish`, which this repository's release workflow uses. See npm's current
[trusted publisher permissions](https://docs.npmjs.com/trusted-publishers/#configuring-trusted-publishing).

Run direct npm commands from outside the repository root, such as `/tmp`, so the root
`devEngines` package-manager requirement does not interfere.

## Add a trusted publisher for each package

In the package's npm settings, add a GitHub Actions trusted publisher with these values:

| npm setting | Value |
| --- | --- |
| GitHub organization or user | `filiphsps` |
| GitHub repository | `pumpkin-plugins` |
| Workflow filename | `ci.yml` |
| Environment name | Leave blank |
| Allowed actions | `npm stage publish` (automatic) and direct `npm publish` |

The examples use `@pumpkin-plugins/codemod`; replace it with the name of the package you are
configuring, and repeat these steps for each public tool.

Before creating the relationship, check the package's current entries:

```sh
npm trust list @pumpkin-plugins/codemod
```

If the list already shows the exact relationship for `filiphsps/pumpkin-plugins`, `ci.yml`, no
environment, and both publish permissions, the package is configured; do not add it again. If the
package has no relationships, create the relationship with this command. The registry readback
should identify `ci.yml`, `filiphsps/pumpkin-plugins`, and both permissions (`createPackage` and
`createStagedPackage`):

```sh
npm trust github @pumpkin-plugins/codemod --file ci.yml --repo filiphsps/pumpkin-plugins --allow-publish --yes
```

There is an unresolved conflict in npm's documentation: the
[trusted-publishers guide says a package can have up to 10 relationships](https://docs.npmjs.com/trusted-publishers/#managing-trusted-publisher-configurations),
while the [`npm trust` CLI reference says only one configuration per package is supported](https://docs.npmjs.com/cli/v11/commands/npm-trust/#provider-options).
If the exact relationship is not present but another one is listed, stop before running the
command with `--yes` and resolve the conflict through a supported npm procedure. Do the same if
the existing identity or permissions do not match, or if npm's output does not make replacement
behavior clear. Keep unrelated relationships; do not revoke one or work around the limit. Do not
revoke an existing relationship just to repeat setup.

The repository's `.github/workflows/ci.yml` calls the reusable
`.github/workflows/release.yml`. npm matches the caller's workflow filename, so use `ci.yml` in the
trusted publisher settings, not `release.yml`. OIDC also needs `id-token: write` in both the
caller's `release` job and the reusable workflow's `publish-tools` job. You do not need to add an
npm write token to GitHub Actions secrets.

On a normal release run, the publish job catches up missing npm versions from earlier tool releases
before publishing the tools selected for the current release. A manual recovery run publishes only
tool releases selected for the exact requested commit. Configure trust shortly before the real
Release Please release is ready, merge that release PR promptly, then confirm the workflow succeeds
and verify the version on npm. The first functional OIDC publish must complete within two days of
creating the trusted-publisher relationship; publishing or retrying the existing `0.0.0`
placeholder does not count.

## Recover an expired or incorrect relationship

If the relationship expires before a successful OIDC publish, npm will not let you edit or use it.
List the package's relationships and match the expired `ci.yml` entry by its identity and exact ID:

```sh
npm trust list @pumpkin-plugins/codemod
```

If you cannot identify that entry unambiguously, stop before revoking anything. Replace the example
package name and `EXPIRED_TRUST_ID` below with the package and exact ID you identified. Revoke only
the expired relationship, then create it again with the command above and complete a new-version
OIDC publish within two days:

```sh
npm trust revoke @pumpkin-plugins/codemod --id EXPIRED_TRUST_ID
```

You cannot edit a relationship's identity in place. If it is incorrect, revoke only that exact
entry, then recreate it. After either recreation, the new relationship must complete a successful
OIDC publish within two days. Preserve every unrelated relationship.

## Runtime and provenance

The setup command and the automated publish job have different npm minimums. Use npm CLI `11.15.0`
or newer to run `npm trust`; the workflow checks for npm CLI `11.5.1` or newer before publishing.
The [publish workflow](../.github/workflows/release.yml) runs on the repository Node version from
`.node-version`. It publishes from GitHub-hosted runners in this public GitHub repository.

npm automatically generates provenance for public packages published through trusted publishing
from a public repository. The workflow also passes `--provenance` explicitly to keep the
requirement visible in the release command. Provenance links a package version to its source and
publishing workflow, helping readers verify where it came from; it does not guarantee that the
package is safe. See npm's
[trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/),
[`npm trust` reference](https://docs.npmjs.com/cli/v11/commands/npm-trust/), and
[provenance guide](https://docs.npmjs.com/generating-provenance-statements/).
