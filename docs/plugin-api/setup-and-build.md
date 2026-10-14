---
navigation:
    category: Plugin API
---

# Setup and build

Standalone plugin projects use `@pumpkin-plugins/pumpkin-api` for the runtime facade and `@pumpkin-plugins/build` for the `pumpkin-plugins-build` command. Their npm names and dependency order are maintained in the [public-tool package metadata](../../scripts/utils/tool-packages.mjs). Install them after their functional Release Please releases are available on npm.

After release, add both dependencies:

```sh
pnpm add @pumpkin-plugins/pumpkin-api @pumpkin-plugins/build
```

Declare the plugin entry and output in `package.json`:

```json
{
  "pumpkinPlugin": {
    "entry": "src/plugin.ts",
    "output": "build/my-plugin.wasm",
    "engine": "static-hermes",
    "wasi": []
  }
}
```

Run `pumpkin-plugins-build --types-only` before `tsc --noEmit` to generate guest declarations from the upstream `v0.1` WIT commit pinned by the installed package's `wit.lock.json`. The first use, and each lockfile change, fetches that commit into the ignored `.cache/pumpkin-api-wit/<lock-digest>/` directory; cached pins need no network access. Run `pumpkin-plugins-build` to bundle and componentize the entry. The build tool prepares Static Hermes and keeps generated WIT, outputs and caches outside installed package files. See [Building](../building.md) for cache overrides and host toolchain details.

The packed-consumer CI matrix targets Node.js `24.21.0` and pnpm `12.11.2` on Linux x64, macOS arm64 and Windows x64. CMake, Ninja, Rust/Cargo, `wit-bindgen`, WASI SDK and Windows MSVC versions are listed in the [Static Hermes Runtime guide](../../tools/static-hermes-runtime/README.md). npm, Yarn and Bun creator launch forms are documented, but their install/build flows are not part of that support contract.
