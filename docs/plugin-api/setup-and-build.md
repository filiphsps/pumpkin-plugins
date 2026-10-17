---
navigation:
    category: Plugin API
title: "Plugin API: setup and build"
description: "Install the API and build tool, generate TypeScript declarations, and build a standalone plugin"
---

# Set up and build a plugin

To build a standalone TypeScript plugin, install the Pumpkin API and the build tool. The API is what your plugin imports; the build tool generates its host declarations and creates the WebAssembly component. Use Node.js 24.21.0 or later.

From your plugin's project directory, install those packages and TypeScript:

```sh
pnpm add @pumpkin-plugins/pumpkin-api @pumpkin-plugins/build
pnpm add -D typescript
```

## Configure the plugin

Add build scripts and a `pumpkinPlugin` section to `package.json`. Set `entry` to your plugin's source file and `output` to where you want the component written. The example uses Static Hermes, which is the default engine, and requests no additional WASI capabilities:

```json
{
  "scripts": {
    "build": "pumpkin-plugins-build",
    "typecheck": "pumpkin-plugins-build --types-only && tsc --noEmit"
  },
  "pumpkinPlugin": {
    "entry": "src/plugin.ts",
    "output": "build/my-plugin.wasm",
    "engine": "static-hermes",
    "wasi": []
  }
}
```

Make sure `tsconfig.json` includes both your source and the generated declarations:

```json
{
  "include": ["build/types/bindings/**/*.d.ts", "src/**/*.ts"]
}
```

## Generate declarations and build

Run the typecheck script to generate guest declarations before TypeScript checks your plugin. The declarations go in `build/types/bindings/`, so your editor can use them too. Then build the component:

```sh
pnpm run typecheck
pnpm run build
```

The type generator reads the WIT lockfile shipped with your installed `@pumpkin-plugins/pumpkin-api` package. That lock pins the upstream Pumpkin plugin interface to a specific commit under `v0.1`, so the declarations don't change just because the upstream branch moves. On first use, or after the lock changes, the build tool fetches the pinned commit with Git and caches it under `.cache/pumpkin-api-wit/<lock-digest>/`. That first fetch needs Git and network access; a valid cached pin can be reused offline. The API package ships the lockfile rather than a vendored WIT tree, so the fetched files stay in your project's cache instead of `node_modules`.

With the default Static Hermes engine, the build tool also prepares the runtime and may download its pinned toolchain on a fresh build. See [Building](../building.md) for cache options and runtime caveats, and the [Static Hermes Runtime guide](../../tools/static-hermes-runtime/README.md) for host tool requirements and the versions used by packed consumer builds.

The [external-consumer workflow](../../.github/workflows/external-consumer.yml) packs and installs the public packages, then runs typecheck and build with pnpm across its platform matrix. The plugin creator also prints launch commands for npm, Yarn, and Bun, but their full install and build flows are outside that workflow's support contract.

Generated declarations describe the API package's pinned interface; they don't guarantee that a Pumpkin server supports every operation. Check [ABI and runtime support](abi-and-runtime.md) when choosing a server version and engine.
