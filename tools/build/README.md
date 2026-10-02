# @pumpkin-plugins/build

Builds a plugin to a `.wasm` file: bundles `src/plugin.ts`, adds the WASI imports the plugin asked for and generates the guest types. It provides the `pumpkin-plugins-build` command.

An internal package of [pumpkin-plugins](../../README.md): it is not published to npm, and the plugins in this repo use it as a workspace dependency. See [the docs](../../docs/building.md) for how it is used.
