# __PLUGIN_NAME__

A minimal Pumpkin plugin written in JavaScript. JSDoc types let TypeScript check your code without
changing the source language.

Install the dependencies, check the plugin's types, then build its WebAssembly component:

```sh
__PACKAGE_MANAGER__ install
__PACKAGE_MANAGER__ run typecheck
__PACKAGE_MANAGER__ run build
```

The first `typecheck` fetches the Pumpkin WIT revision pinned by the API package, so Git and network
access are needed unless that revision is already cached. The default Static Hermes build may also
download its pinned tools and prepare Hermes. See the [build guide](https://filiphsps.github.io/pumpkin-plugins/guides/building)
and [Static Hermes Runtime guide](https://filiphsps.github.io/pumpkin-plugins/tools/static-hermes-runtime/README)
for prerequisites and cache options.

The starter targets Pumpkin plugin WIT ABI `0.1.0`. The API package version and host ABI version are
separate; when upgrading, choose an API package whose pinned ABI is supported by your Pumpkin server.
