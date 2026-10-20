# Plugin build tool

`@pumpkin-plugins/build` turns a plugin's TypeScript entry point into a Pumpkin WebAssembly
component. It bundles the plugin, adds the WASI imports declared in the package configuration, and
uses the selected engine to componentize the bundle with the repository's pinned toolchain. You can
also use it to generate guest declarations for typechecking.

## Build a plugin

Run `pnpm build` from a plugin package. The `pumpkinPlugin` object in its `package.json` selects
the entry point, output file, requested WASI capabilities, and optional engine. The output is the
configured `.wasm` component under the package's build directory.

The engine defaults to `static-hermes`; set it to `quickjs` to build with QuickJS. Both engines are
supported, and current plugin packages use Static Hermes. Static Hermes is the WASI 2 backend
described in the [runtime guide](../../static-hermes-runtime/README.md). It uses the lean runtime
profile and Hades garbage collection by default. Set `staticHermesRuntime` to `"full"` to retain
runtime source compilation, or set `STATIC_HERMES_ENABLE_LEAN_ARCHIVE=0` to select the full profile
for builds. Set `staticHermesGc` to `"malloc"` to use malloc-managed garbage collection.

The executable is compiled from TypeScript to `dist/cli.js`. Repository-wide build and typecheck
commands compile it before consumers run. After a fresh checkout, build the runtime and CLI before
running a direct workspace package command:

```sh
pnpm --filter @pumpkin-plugins/static-hermes-runtime build
pnpm --filter @pumpkin-plugins/build build
```

Run `pumpkin-plugins-build --help` to see the available options or `--version` to see the installed
tool version.

Run `pumpkin-plugins-build --types-only` to generate guest declarations without building the
component. TypeScript and your editor consume these declarations. They are build output, so make
changes in your plugin source and package configuration rather than editing the generated files.

Pass `--parse-ts` to use Hermes's partial, unstable TypeScript parser when compiling a Static Hermes
component bundle. The option is off by default and cannot be used with QuickJS.

The build tool reports progress for both engines with a shared `[build]` prefix, including the entry
point, selected runtime, componentization stage, and final artifact size. It suppresses routine
output from the QuickJS and Static Hermes toolchains; if a tool fails, its captured stderr appears
in the build output.

If a script needs to check what a build selected, set `PUMPKIN_PLUGINS_BUILD_LOG_FORMAT=json`. The
tool then prints each of these messages as one JSON object per line, on the same stream as the text
line. Each object has a `type` of `bundle`, `componentize`, `built`, `warning` or `error`, plus that
message's details, such as `engine`, `runtimeVariant`, `gcVariant`, `output` and `sizeBytes`. The
`bundle` and `componentize` messages include `parseTypeScript: true` only when the TypeScript
parser is on. Toolchain output that `PUMPKIN_PLUGINS_VERBOSE_BUILD=1` adds stays plain text.

In an interactive terminal, the executable checks npm for a newer builder release in the background
and may print an update notice. Results are cached for three hours, and registry errors do not affect
the build. Pass `--no-update-cache` to check npm without reading or writing the cache. The check is
skipped for help and version output, CI, development mode (`PUMPKIN_DEV_MODE=1`), and non-interactive
output. To opt out, pass `--no-update-notifier` or set
`PUMPKIN_PLUGINS_NO_UPDATE_NOTIFIER=1`. If you see an update notice, preview the migration from the
plugin directory with `pnpm dlx @pumpkin-plugins/codemod update-build .`.

## WASI capability metadata

The builder and migration codemod use the shared, dependency-free
[`@pumpkin-plugins/wasi-capabilities`](../../wasi-capabilities/README.md) package for capability names,
WIT interfaces, and the pinned WASI version. These capabilities describe the services a plugin needs;
they do not infer its Pumpkin permissions.

That package's `WASI_VERSION` is the only owner of the WASI version. The builder's
`wasi-wit.lock.json` pins the WIT files for that release, and the builder stops with an error that
names both files if the lock's `version` differs. To move to a new WASI release, change
`WASI_VERSION` and refresh the lock in the same change.

## Build constraints

Static Hermes uses the pinned Pumpkin API WIT and WASI 2. Keep the workspace's Pumpkin API version
aligned with the test harness server version. Declare the WASI capabilities and Pumpkin permissions
required by the APIs your plugin uses.

Building the same source twice does not guarantee identical bytes. For signing or publishing, use
the exact artifact produced by the build job instead of rebuilding it later.
