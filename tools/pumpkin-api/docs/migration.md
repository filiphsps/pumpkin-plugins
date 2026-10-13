---
navigation:
    category: Plugin API
---

# Migrate From `@pumpkinmc/pumpkin-api-ts`

This guide moves a plugin from an audited API baseline to `@pumpkin-plugins/pumpkin-api` and its `pumpkin-plugins-build` command. The facade and WIT API are compatible; the package name and build setup change.

## Before You Migrate

Each compatibility entry records the source package version it audits, its supported Pumpkin release, and a link to item-level decisions. Choose the row matching the package you are migrating:

<!-- docs:begin compatibility-matrix -->
<!-- Generated from compatibility/*.json. Run `pnpm readme`. -->

| Source baseline | Pumpkin release | Audited API surface | Details |
| --- | --- | --- | --- |
| `@pumpkinmc/pumpkin-api-ts` `v0.1.1` | `0.2.0+26.3-26.51` | 18 runtime exports; 6 public TypeScript types; 44 WIT interfaces; 987 WIT types; 957 operations | [Item-level decisions](../compatibility/v0.1.1.json) |
<!-- docs:end compatibility-matrix -->

The replacement package's npm version and WIT ABI version are separate. The compatibility matrix records the current ABI and the Pumpkin release it was audited against. Make sure the Pumpkin server you target supports that ABI.

The compatibility inventories record decisions for the runtime facade, public TypeScript types, and WIT API. The only facade behavior change is the missing command-suggestion-handler error described below.

## Updating the Upstream WIT Audit

The active compatibility matrix follows the Pumpkin release in `tools/test-harness/src/pumpkin-version.ts`. When `wit.lock.json` moves, run `pnpm --filter @pumpkin-plugins/static-hermes-runtime compatibility:refresh`. The command archives the previous reviewed matrix under `compatibility/history/<pumpkin-release>/<wit-subdirectory>/<commit>-<wit-sha256>.json`, then regenerates the active matrix and Static Hermes operation inventory. See the [audit history policy](../compatibility/history/README.md).

New, changed and removed WIT declarations are marked `review-required`; tests stay red until each has an explicit decision and migration note. Changed and removed declarations are recorded as breaking even when upstream reuses its existing release version. A Pumpkin release change starts a new active audit and keeps the previous release snapshot.

The install commands below require the first public releases of both replacement packages. This
repository configures the builder for public npm publication; wait for its release tag before
installing it from npm. Repository maintainers must configure npm trusted publishers before the
release workflow can publish packages; see [CI and releases](../../../docs/ci-and-releases.md#github-settings).

## 1. Choose How to Change the Package Name

For a large existing plugin with many imports, use a [pnpm alias](https://pnpm.io/aliases) to install the new API package under the old dependency name. Existing `@pumpkinmc/pumpkin-api-ts` imports and re-exports then keep resolving without a source-wide rename. After both packages are available from your registry, run:

```sh
pnpm add '@pumpkinmc/pumpkin-api-ts@npm:@pumpkin-plugins/pumpkin-api@^0.1.0' @pumpkin-plugins/build
```

pnpm records the alias in `package.json` like this:

```json
{
  "dependencies": {
    "@pumpkinmc/pumpkin-api-ts": "npm:@pumpkin-plugins/pumpkin-api@^0.1.0",
    "@pumpkin-plugins/build": "0.1.0"
  }
}
```

Use the alias only to reduce a broad rename in a large existing project. For an existing plugin with a manageable number of imports, use the new package name directly and update the imports in step 2:

```sh
pnpm remove @pumpkinmc/pumpkin-api-ts
pnpm add @pumpkin-plugins/pumpkin-api @pumpkin-plugins/build
```

For a new plugin, install the new packages directly; there is no old dependency to remove:

```sh
pnpm add @pumpkin-plugins/pumpkin-api @pumpkin-plugins/build
```

The alias changes how pnpm resolves the API dependency; it does not preserve the old build command. Update the builder setup in step 3 either way.

## 2. Update Imports and Re-Exports

If you chose the direct package name for an existing plugin in step 1, change every import and re-export of the old package, including those in tests, scripts and examples. New plugins should import the new package name directly:

```diff
- import { Plugin, registerPlugin } from '@pumpkinmc/pumpkin-api-ts';
+ import { Plugin, registerPlugin } from '@pumpkin-plugins/pumpkin-api';

- export * from '@pumpkinmc/pumpkin-api-ts';
+ export * from '@pumpkin-plugins/pumpkin-api';
```

Keep the `export *` in the plugin entry point so the facade's host callbacks are included in the component. Keep Pumpkin WIT import specifiers aligned with the locked source and generated declarations; an upstream WIT revision can change them even when Pumpkin keeps its existing release version.

## 3. Move the Build Command Into `package.json`

The old [`pumpkin-plugin-build <entry-file.ts> <output-file.wasm>` command](https://github.com/Pumpkin-MC/pumpkin-api-ts#building-your-plugin) takes positional paths. The new builder reads them from the `pumpkinPlugin` field and accepts no positional entry or output arguments. Add or adapt these fields in your existing `package.json`. This example uses the direct package name; if you chose an alias, keep the dependency key shown in step 1:

```json
{
  "scripts": {
    "build": "pumpkin-plugins-build",
    "typecheck": "pumpkin-plugins-build --types-only && tsc --noEmit"
  },
  "dependencies": {
    "@pumpkin-plugins/pumpkin-api": "0.1.0",
    "@pumpkin-plugins/build": "0.1.0"
  },
  "pumpkinPlugin": {
    "entry": "src/plugin.ts",
    "output": "build/plugin.wasm",
    "engine": "quickjs",
    "wasi": []
  }
}
```

Keep both packages under `dependencies`, as in the [standalone plugin template](../../create-pumpkin-plugin/templates/typescript/package.json).

Keep `engine: "quickjs"` if you want to retain the old QuickJS runtime. The new builder defaults to Static Hermes, so changing engines is a separate runtime migration. Copy the WASI capabilities your plugin uses into `wasi`; keep the empty list only if it uses none. See [Building](../../../docs/building.md) for supported engines and capabilities.

Add the generated declaration glob to the `include` list in `tsconfig.json`, keeping any source patterns your project already has:

```json
"include": ["build/types/bindings/**/*.d.ts", "src/**/*.ts"]
```

The `--types-only` command generates these declarations from the upstream WIT commit pinned by the installed API package's `wit.lock.json`. The build tool fetches the source on first use and after lockfile changes, then reuses the ignored `.cache/pumpkin-api-wit/<lock-digest>/` consumer cache.

## 4. Regenerate Types and Build

Run type generation and type checking before producing the component:

```sh
pnpm typecheck
pnpm build
```

Review the resulting `.wasm` on the Pumpkin release you target. If the component reports missing or incompatible `pumpkin:plugin` imports, check the server's WIT ABI against the active compatibility matrix and confirm that your build used the intended engine.

## 5. Update Tests That Check the Old Error Text

When no command-suggestion handler is registered, the new facade reports the requested ID:

```text
No command suggestion handler registered for ID <id>
```

The old implementation reported `undefined` in this error. Plugin source does not need to change, but tests that asserted the old message should use the corrected text.

The replacement package declares the MIT license; the old package declared `MIT OR Apache-2.0`. Update any dependency license inventory you maintain.
