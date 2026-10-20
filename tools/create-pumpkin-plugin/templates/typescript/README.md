# __PLUGIN_NAME__

A minimal Pumpkin plugin written in TypeScript. Start here to check its types and build the WebAssembly component.

```sh
__PACKAGE_MANAGER__ install
__PACKAGE_MANAGER__ run typecheck
__PACKAGE_MANAGER__ run build
```

On a fresh project, these commands may need network access. `typecheck` fetches the Pumpkin WIT
revision pinned by the API package. The first Static Hermes build may also download its pinned
toolchain and prepare Hermes; later runs can reuse the cache. See the [build guide](https://filiphsps.github.io/pumpkin-plugins/guides/building)
and [Static Hermes Runtime guide](https://filiphsps.github.io/pumpkin-plugins/tools/static-hermes-runtime/README)
for prerequisites and cache options.

This starter uses Pumpkin plugin WIT ABI `0.1.0`. The `@pumpkin-plugins/pumpkin-api` package
provides that ABI's WIT definitions; when upgrading it, make sure the Pumpkin server you run uses
the matching ABI. The API package version and WIT ABI version are separate. See the
[ABI and runtime guide](https://filiphsps.github.io/pumpkin-plugins/plugin-api/abi-and-runtime) for
compatibility details.
