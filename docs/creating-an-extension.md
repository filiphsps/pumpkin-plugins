---
navigation:
    category: Getting started
title: "Creating a VS Code extension"
description: "Scaffold, build, test, and release a VS Code extension"
---

# Creating a VS Code extension

This guide takes you from the repository generator to a VSIX attached to a GitHub release. Extensions
live in `extensions/` as private pnpm workspace packages, and Release Please tracks each extension as
its own release component.

## Create the starter

From the repository root, run:

```sh
pnpm gen:extension
```

The generator asks for three values:

| Prompt | Example | What to enter |
| --- | --- | --- |
| Folder name | `minecraft-terms` | A new kebab-case name. It becomes the folder and package name under `extensions/`. |
| Display name | `Minecraft Terms` | The name people see in VS Code. It defaults to a title-cased version of the folder name. |
| Description | `Minecraft terminology for Code Spell Checker` | A required, single-line description of at most 70 characters. |

You can pass the same answers on the command line:

```sh
pnpm gen:extension --args minecraft-terms "Minecraft Terms" "Minecraft terminology for Code Spell Checker"
```

The folder must not already exist. When the generator finishes, it has created a TypeScript starter
in `extensions/<folder>/`:

- `src/extension.ts` activates the extension, and `src/command.ts` registers its sample Hello World
  command. `src/extension.test.ts` tests the command registration and behavior.
- `package.json` contains the VS Code extension manifest and the `build`, `typecheck`, `test`, and
  `package` scripts. The starter manifest includes a sample command, an MIT license, and version
  `0.0.0`.
- `README.md` explains how to install the VSIX and run the sample command. `tsconfig.json` configures
  TypeScript, and `.vscodeignore` keeps source files and tests out of the package.
- `CHANGELOG.md` and `LICENSE` provide the release notes file and license file.

The generator also registers the extension in `release-please-config.json` and
`.release-please-manifest.json`. It pins the first release to `0.0.1`; leave that registration in
place. Finally, it runs `pnpm install`, refreshes the root README catalog and component API-reference
links, and formats the generated files. Review the new package and replace the sample behavior and
instructions before asking for a release.

Update `src/extension.ts` and `src/command.ts` with the behavior you want, then adjust
`src/extension.test.ts` to cover it. Add or change commands in the `contributes` section of
`package.json`, and make sure the README explains how someone can use the finished extension. The
README's API-reference block is generated; keep its markers in place. For longer user guides, add
pages under `extensions/<folder>/docs/` and follow the [documentation-site guide](documentation-site.md).

## Build and test your extension

The starter gives you separate scripts for checking and packaging the extension. Run them from the
repository root, replacing `minecraft-terms` with your extension's folder name:

```sh
pnpm --filter minecraft-terms run typecheck
pnpm --filter minecraft-terms run test
pnpm --filter minecraft-terms run build
pnpm --filter minecraft-terms run package
```

The build writes the compiled extension to `dist/`. The package script then uses the repository's
`scripts/package-extension.mjs` helper and `@vscode/vsce` to create a `.vsix` file in the extension
folder, named `<folder>-<version>.vsix`. Install it locally with
`code --install-extension path/to/my-extension.vsix`, replacing the example path with the VSIX you
built, then try it in VS Code.

The helper runs VSCE with `--no-yarn --no-dependencies`; it does not install or copy production npm
dependencies into the VSIX. Bundle any runtime dependencies into `dist/`, and do not leave them in
`package.json`'s `dependencies` field: the helper stops if that field is non-empty. Development
dependencies such as TypeScript and Vitest stay in `devDependencies`.

If the extension ships generated files from another workspace package, list that package's name in
`pumpkinBundleDependencies` in the extension's `package.json`. Release tooling uses this declaration
to include changes to the bundled package when deciding whether the extension needs a release. Also
add the package to `devDependencies` as `workspace:*`, so Turbo rebuilds the extension when it
changes.

## What CI checks

When extension source or configuration changes, CI runs Biome, typechecking, the extension's tests,
the build, and VSIX packaging. It keeps the verification VSIX as a one-day workflow artifact. An
extension-only change skips the Pumpkin plugin build and real-server integration suites; if a change
also touches those areas, their checks run separately. See [how CI selects checks](ci-and-releases.md#running-only-what-a-change-needs)
for the full rules.

The documentation workflow also builds the extension's API reference from its TypeScript source.
The README's generated reference block links to that reference. Add user-facing guides under
`extensions/<folder>/docs/` when the README needs more detail; see [the documentation-site guide](documentation-site.md)
for how those pages are organized and published.

## Release the VSIX

Use the repository's [Conventional Commit](ci-and-releases.md#merging) format for extension changes.
Release Please opens a pull request that updates the extension's version and changelog. After you
merge it, the release workflow verifies that the tag points to the commit it is building, packages
the extension, and attaches the VSIX to its GitHub release. You do not need to upload the VSIX
yourself.
