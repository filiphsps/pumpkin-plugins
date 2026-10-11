# Plugin build tool

`@pumpkin-plugins/build` turns a plugin's TypeScript entry point into a Pumpkin WebAssembly
component. It bundles the plugin, adds the WASI imports declared by the package, componentizes the
module with the repository's pinned toolchain, and can generate guest declarations for typechecking.

## Build a plugin

Run `pnpm build` from a plugin package. The build configuration is the `pumpkinPlugin` object in
that package's `package.json`; it identifies the entry point, output file, and requested WASI
capabilities. The result is the configured `.wasm` file under the package's build directory.

Run the build command with `--types-only` to generate guest types without producing the component.
Those declarations are consumed by TypeScript and the editor. They are build output, so edit the
plugin source and package configuration rather than generated files.

## Build constraints

The tool uses the selected API code and WIT from `pumpkin-api-targets.json` and QuickJS/WASI componentizer. Keep the API/WIT/server tuple aligned. Root commands select `release` by default;
`PUMPKIN_API_TARGET=nightly pnpm build` selects the pinned nightly tuple. Local API and WIT overrides
are hashed by the root runner before Turbo caches a task. Plugin code runs in QuickJS;
browser globals such as `fetch`, `TextEncoder`, and `TextDecoder` are not available. Requested WASI
capabilities and Pumpkin permissions must match the APIs the plugin uses.

Identical source builds are not byte-for-byte reproducible. Signing or publishing workflows must
use the exact artifact from the build job instead of rebuilding it later.
