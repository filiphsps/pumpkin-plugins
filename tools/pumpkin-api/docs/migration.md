---
navigation:
    category: Plugin API
---

# Migrate From `@pumpkinmc/pumpkin-api-ts`

This guide moves a plugin from an audited API baseline to `@pumpkin-plugins/pumpkin-api` and its `pumpkin-plugins-build` command. The compatibility inventory records the public exports, types and WIT surface; the facade behavior changes are listed below. The package name and build setup also change.

## Before You Migrate

Each compatibility entry records the source package version it audits, its supported Pumpkin release, and a link to item-level decisions. Choose the row matching the package you are migrating:

<!-- docs:begin compatibility-matrix -->
<!-- Generated from compatibility/*.json. Run `pnpm readme`. -->

| Source baseline | Pumpkin release | Audited API surface | Details |
| --- | --- | --- | --- |
| `@pumpkinmc/pumpkin-api-ts` `v0.1.1` | `0.2.0+26.3-26.51` | 18 runtime exports; 7 public TypeScript types; 44 WIT interfaces; 987 WIT types; 957 operations | [Item-level decisions](../compatibility/v0.1.1.json) |
<!-- docs:end compatibility-matrix -->

The replacement package's npm version and WIT ABI version are separate. The compatibility matrix records the current ABI and the Pumpkin release it was audited against. Make sure the Pumpkin server you target supports that ABI.

The compatibility inventories record decisions for the runtime facade, public TypeScript types, and WIT API. The facade also changed event handler types, diagnostics, callback cleanup, metadata without a registered plugin and runtime tick validation; the sections below describe those changes.

## Updating the Upstream WIT Audit

The active compatibility matrix follows the Pumpkin release in `tools/test-harness/src/pumpkin-version.ts`. When `wit.lock.json` moves, run `pnpm --filter @pumpkin-plugins/static-hermes-runtime compatibility:refresh`. The command archives the previous reviewed matrix under `compatibility/history/<pumpkin-release>/<wit-subdirectory>/<commit>-<wit-sha256>.json`, then regenerates the active matrix and Static Hermes operation inventory. See the [audit history policy](../compatibility/history/README.md).

New, changed and removed WIT declarations are marked `review-required`; tests stay red until each has an explicit decision and migration note. Changed and removed declarations are recorded as breaking even when upstream reuses its existing release version. A Pumpkin release change starts a new active audit and keeps the previous release snapshot.

## 1. Choose How to Change the Package Name

For a large existing plugin with many imports, use a [pnpm alias](https://pnpm.io/aliases) to install the new API package under the old dependency name. Existing `@pumpkinmc/pumpkin-api-ts` imports and re-exports then keep resolving without a source-wide rename. Run:

```sh
pnpm add '@pumpkinmc/pumpkin-api-ts@npm:@pumpkin-plugins/pumpkin-api@^0.1.0' @pumpkin-plugins/build
```

pnpm records the alias in `package.json` like this:

```json
{
  "dependencies": {
    "@pumpkinmc/pumpkin-api-ts": "npm:@pumpkin-plugins/pumpkin-api@^0.1.0"
  }
}
```

The build tool follows this declared alias to read the installed API package's `wit.lock.json`, so
you do not need a second direct dependency under `@pumpkin-plugins/pumpkin-api`.

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

The old [`pumpkin-plugin-build <entry-file.ts> <output-file.wasm>` command](https://github.com/Pumpkin-MC/pumpkin-api-ts#building-your-plugin) takes positional paths. The new builder reads them from the `pumpkinPlugin` field and accepts no positional entry or output arguments. Add or adapt these fields in your existing `package.json`, keeping the dependencies that step 1 added:

```json
{
  "scripts": {
    "build": "pumpkin-plugins-build",
    "typecheck": "pumpkin-plugins-build --types-only && tsc --noEmit"
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

The old builder ran only QuickJS. The new builder defaults to Static Hermes when `engine` is missing, and the codemod sets a missing `engine` to `"static-hermes"`. Set `engine: "quickjs"` to keep the old runtime. Moving to Static Hermes is a separate runtime migration: the build fails if the plugin imports a WASI interface that Static Hermes has no adapter for. Copy the WASI capabilities your plugin uses into `wasi`; keep the empty list only if it uses none. See [Building](../../../docs/building.md) for supported engines and capabilities.

Add the generated declaration glob to the `include` list in `tsconfig.json`, keeping any source patterns your project already has:

```json
"include": ["build/types/bindings/**/*.d.ts", "src/**/*.ts"]
```

The `--types-only` command generates these declarations from the upstream WIT commit pinned by the installed API package's `wit.lock.json`. The build tool fetches the source on first use and after lockfile changes, then reuses the `.cache/pumpkin-api-wit/<lock-digest>/` consumer cache.

The builder writes downloaded inputs such as the fetched WIT to `.cache/`, and generated declarations and the plugin component to `build/`. If your `.gitignore` does not list them yet, add both so they are not committed:

```text
.cache/
build/
```

## 4. Regenerate Types and Build

Run type generation and type checking before producing the component:

```sh
pnpm typecheck
pnpm build
```

Review the resulting `.wasm` on the Pumpkin release you target. If the component reports missing or incompatible `pumpkin:plugin` imports, check the server's WIT ABI against the active compatibility matrix and confirm that your build used the intended engine.

## 5. Check Event Handler Types

`registerEvent` now takes the handler's payload type from the event type you register. `EventHandler` defaults to the union of event payloads instead of `any`, and handlers return `T | undefined` instead of `T | void`. Fix the handlers that `pnpm typecheck` reports:

- Let `registerEvent` infer the payload, or name it with `EventPayload`:

  ```ts
  import type { EventHandler, EventPayload } from '@pumpkin-plugins/pumpkin-api';

  const onJoin: EventHandler<EventPayload<'player-join-event'>> = (server, event) => {
      // event has the player-join payload type.
      return undefined;
  };
  ```

- Remove `: void` return annotations from event handlers. Return nothing to keep the event unchanged.

## 6. Update Tests That Check the Old Error Text

When no command-suggestion handler is registered, the new facade reports the requested ID:

```text
No command suggestion handler registered for ID <id>
```

The old implementation reported `undefined` in this error. Plugin source does not need to change, but tests that asserted the old message should use the corrected text.

## 7. Update Tests That Check IPC Rejection Diagnostics

When a plugin does not override `Plugin.handleIpcMessage`, the default now throws `Error('This plugin does not handle IPC messages')` instead of the string `This plugin cannot recieve messages`. Calling the exported `handleIpcMessage` before `registerPlugin()` now throws `Error('Cannot handle IPC messages before a plugin is registered')` instead of `Error('No plugin instance available?')`. Plugins that override the handler do not need a source change, but tests that assert either previous rejection value or message should be updated.

## 8. Account for Lifecycle Changes

The facade releases event, command, suggestion, AI-goal and chunk-generator callbacks when `onUnload()` finishes, including when the plugin's unload hook throws. It also removes event and command callbacks if registration with the host fails. A command resource may keep its assigned handler ID if host registration fails after assignment. Re-register callbacks from a later `onLoad()`; no migration is needed for plugins that already follow that lifecycle.

Use the new `cancelTask()` helper to cancel a task scheduled through the facade; it also releases the task's callback.

Call `registerPlugin()` in the plugin entry point. When Pumpkin asks for metadata and no plugin is registered, the facade now throws, so Pumpkin rejects the plugin instead of loading it as `unknown`.

## 9. Pass Runtime Tick Values With the Declared Types

Scheduled task helpers now reject runtime values other than numbers or bigints before coercion. JavaScript callers must pass a number or bigint; TypeScript call sites already checked against the declared types need no source change. Safe-integer, unsigned 64-bit range and positive repeating-period rules still apply.

The replacement package declares the MIT license; the old package declared `MIT OR Apache-2.0`. Update any dependency license inventory you maintain.
