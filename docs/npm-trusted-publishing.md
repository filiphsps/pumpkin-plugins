---
navigation:
    category: CI and releases
---

# Trusted publishing for npm tools

The release workflow publishes the public tools with npm trusted publishing. npm authenticates the
GitHub Actions workflow through OpenID Connect (OIDC); no npm write token is stored in GitHub
secrets.

## Prerequisites

Configure a trusted publisher only after its npm package exists. The metadata-only `0.0.0`
placeholder satisfies this requirement but contains no working package code. Because the new
relationship must be validated by a successful publish within two days, wait until the real
Release Please release is ready to merge before creating it. npm also requires package write access,
account-level two-factor authentication, and npm CLI `11.15.0` or newer for the `npm trust` command.
Check the CLI with `npm --version`; update it with
`npm install --global npm@^11.15.0` if needed.

For new trusted publishers, npm automatically allows `npm stage publish`. The `--allow-publish` flag
also allows direct `npm publish`, which this repository's release workflow uses. See npm's current
[trusted publisher permissions](https://docs.npmjs.com/trusted-publishers/#configuring-trusted-publishing).

Run direct npm commands from outside the repository root, such as `/tmp`, to avoid the root
`devEngines` package-manager requirement.

The first functional version is published by the Release Please workflow. See
[Publishing public npm tools](npm-publishing.md) for the placeholder and release sequence.

## Configure the trusted publisher

For each package, add a GitHub Actions trusted publisher with these values:

| npm setting | Value |
| --- | --- |
| GitHub organization or user | `filiphsps` |
| GitHub repository | `pumpkin-plugins` |
| Workflow filename | `ci.yml` |
| Environment name | Leave blank |
| Allowed actions | `npm stage publish` (automatic) and direct `npm publish` |

Run this command after substituting the package name and checking its current relationships below.
The registry readback should identify `ci.yml`, `filiphsps/pumpkin-plugins`, and both publish
permissions (`createPackage` and `createStagedPackage`):

```sh
npm trust github <package-name> --file ci.yml --repo filiphsps/pumpkin-plugins --allow-publish --yes
```

Check the package's existing relationships first with `npm trust list <package>`. If the exact
`ci.yml` relationship is already present, do not add it again. If no relationship exists, run the
command above. Preserve every unrelated relationship. The current npm docs disagree: the
[trusted-publishers guide says a package can have up to 10 relationships](https://docs.npmjs.com/trusted-publishers/#managing-trusted-publisher-configurations),
while the [`npm trust` CLI reference says only one configuration per package is supported](https://docs.npmjs.com/cli/v11/commands/npm-trust/#provider-options).
If any other relationship is listed, or the output does not make replacement behavior clear, stop
before running the `--yes` command and resolve the conflict through a supported npm procedure. Do
not revoke an unrelated entry or work around the limit. Do not revoke an existing relationship
just to rerun setup.

The repository uses a reusable workflow: `.github/workflows/ci.yml` calls
`.github/workflows/release.yml`. npm matches the caller's workflow filename, so configure `ci.yml`,
not `release.yml`. OIDC requires `id-token: write` in both the caller's `release` job and the
reusable workflow's `publish-tools` job. The publish job is gated by Release Please's
`tool_paths_released` output. A GitHub Actions npm write token is not needed.

## Validate the relationship within two days

npm requires a newly created trusted-publisher relationship to complete its first successful OIDC
publish within two days. Configure trust shortly before the real Release Please release is ready,
merge that release PR promptly, then confirm the release succeeds and verify the version on npm.
Publishing or retrying the already published `0.0.0` placeholder does not validate the trusted
publisher.

If the relationship expires before a successful OIDC publish, list the package relationships and
identify the expired `ci.yml` relationship by its identity and exact ID. Only revoke that expired
relationship; preserve all unrelated entries. If the listed entries do not identify it
unambiguously, stop before revoking anything:

```sh
npm trust list <package>
```

Revoke that expired relationship, then create it again using the command above and complete a
new-version OIDC publish within two days:

```sh
npm trust revoke <package> --id <expired-trust-id>
```

Do not remove unrelated relationships. A trusted-publisher configuration cannot be edited in
place; after expiry or an identity error, revoke only the exact expired or incorrect relationship,
then recreate it. The new relationship must complete a successful OIDC publish within two days.

## Runtime and provenance

npm CLI `11.15.0` or newer is required to run the `npm trust` setup command. For the automated
trusted-publish operation, npm CLI `11.5.1` or newer and Node `22.14.0` or newer are required. The
repository's [publish workflow](../.github/workflows/release.yml) sets its Node version and checks
the npm minimum before publishing.
The workflow publishes from GitHub-hosted runners in this public GitHub repository.

npm automatically generates provenance for public packages published through trusted publishing
from a public repository. The workflow also passes `--provenance` explicitly when publishing, so
the release command records that requirement directly. Provenance links a package version to its
source and publishing workflow; it does not by itself guarantee that the package is safe. See npm's
[trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/),
[`npm trust` reference](https://docs.npmjs.com/cli/v11/commands/npm-trust/), and
[provenance guide](https://docs.npmjs.com/generating-provenance-statements/).
