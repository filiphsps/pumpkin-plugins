# Plugin build tool

`@pumpkin-plugins/build` turns a plugin's TypeScript entry point into a Pumpkin WebAssembly
component. It bundles the plugin, adds the WASI imports declared by the package, componentizes the
module with the repository's pinned toolchain, and can generate guest declarations for typechecking.

## Build a plugin

Run `pnpm build` from a plugin package. The build configuration is the `pumpkinPlugin` object in
that package's `package.json`; it identifies the entry point, output file, and requested WASI
capabilities. The result is the configured `.wasm` file under the package's build directory.
The optional `engine` setting defaults to `static-hermes`; set it to `quickjs` to build a QuickJS
plugin. Both engines are supported, and current plugin packages use the Static Hermes default. Static
Hermes is the WASI 2 backend described in the [runtime guide](../../static-hermes-runtime/README.md).
It uses the lean runtime archive and Hades garbage collector by default. Set `staticHermesRuntime`
to `"full"` to retain runtime source compilation, or set `STATIC_HERMES_ENABLE_LEAN_ARCHIVE=0` to
disable the lean archive for builds. Set `staticHermesGc` to `"malloc"` to select malloc-managed GC.

The executable is compiled from TypeScript to `dist/cli.js`. Repository-wide build and typecheck
commands compile it before consumers run. For a direct workspace package command after a fresh
checkout, first run `pnpm --filter @pumpkin-plugins/static-hermes-runtime build` and
`pnpm --filter @pumpkin-plugins/build build` from the repository root.
Use `pumpkin-plugins-build --help` to list options and `--version` to show the installed tool version.

Run the build command with `--types-only` to generate guest types without producing the component.
Those declarations are consumed by TypeScript and the editor. They are build output, so edit the
plugin source and package configuration rather than generated files.

Pass `--parse-ts` to use Hermes's partial, unstable TypeScript parser when compiling a Static Hermes
component bundle. The option is off by default and is unavailable with QuickJS.

The build tool owns console output for both engines. It reports the entry point, selected runtime,
componentization stage and final artifact size with a shared `[build]` prefix. Routine output from
the QuickJS and Static Hermes toolchains is suppressed; failures include captured stderr diagnostics
in the same format.

## Build constraints

Static Hermes uses the pinned Pumpkin API WIT and WASI 2. Keep the workspace's Pumpkin API version
aligned with the test harness server version. Requested WASI capabilities and Pumpkin permissions
must match the APIs the plugin uses.

Identical source builds are not byte-for-byte reproducible. Signing or publishing workflows must
use the exact artifact from the build job instead of rebuilding it later.
