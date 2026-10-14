# Creating a VS Code extension

Create an extension package with the Turbo generator:

```sh
pnpm gen:extension
```

Enter a kebab-case folder name, a display name, and a short description. The generator scaffolds a
TypeScript VS Code extension in `extensions/`, registers its independent Release Please component,
installs workspace dependencies, and refreshes the generated README catalog. Extension packages
are private workspace packages; releases are distributed as VSIX assets on GitHub Releases.

Each extension supplies `build`, `typecheck`, `test`, and `package` scripts. The package script uses
`@vscode/vsce` to create a VSIX without installing npm dependencies, so bundle production code into
`dist/` during the build. If the extension ships generated data from a workspace package, list that
package in `pumpkinBundleDependencies`; Release Please includes its changes in the extension release.

## Build and package

From the repository root, run the extension's build and package scripts. For Minecraft Terms:

```sh
pnpm --filter minecraft-terms run build
pnpm --filter minecraft-terms run package
```

The package command writes `minecraft-terms-<version>.vsix` into `extensions/minecraft-terms/`.
For another extension, replace `minecraft-terms` with its package name.

CI sends changed extension packages through `.github/workflows/extensions.yml` only; an
extension-only change does not run the plugin build or Pumpkin integration suites. Mixed changes
run the extension checks and the checks for every other changed area.

Extension READMEs are included in the generated root catalog and on the documentation site. Add
the extension description and license to its `package.json`; `pnpm readme` refreshes the catalog and
documentation links. Release Please updates the extension version and changelog, and the release
workflow packages the tagged revision and attaches the VSIX to its release.
