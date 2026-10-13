# __PLUGIN_NAME__

A minimal Pumpkin plugin written in TypeScript.

```sh
npm install
npm run typecheck
npm run build
```

On a fresh project, the first `typecheck` or `build` needs network access: `typecheck` fetches the API's
pinned Pumpkin WIT with Git, and a Static Hermes build may also download pinned tools and prepare
Hermes. See the [build guide](https://filiphsps.github.io/pumpkin-plugins/guides/building) and
[Static Hermes Runtime guide](https://filiphsps.github.io/pumpkin-plugins/tools/static-hermes-runtime/README)
for prerequisites and cache options.

The plugin targets the Pumpkin plugin WIT ABI `0.1.0`. Keep the API package and server ABI aligned when upgrading.
