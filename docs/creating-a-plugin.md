---
navigation:
    category: Getting started
title: "Creating a plugin"
description: "The `pnpm gen` generator, what it creates, and what to do next"
---

# Creating a plugin

Use `pnpm gen` to add a plugin package to this repository. The generator creates a working starter,
registers it for releases, installs its workspace dependencies, and updates the generated README
content. It leaves the changes in your working tree for you to review and develop; it doesn't commit
them.

If you're building a plugin in its own repository, skip to [Standalone projects](#standalone-projects).

## Create the package

Run the generator from the repository root:

```sh
pnpm gen
```

This runs the `plugin` [Turborepo generator](https://turborepo.dev/docs/guides/generating-code)
defined in `turbo/generators/`. It asks for a folder name, the name Pumpkin displays, and a short
description. These answers shape the package, its release tag, and its generated metadata, so choose
them before you start adding behavior:

| Prompt | Example | What to enter |
| --- | --- | --- |
| Folder name | `my-plugin` | A new kebab-case name for `packages/`. It becomes the npm package suffix, release tag prefix, and `.wasm` file name. The folder must not already exist. |
| Plugin name | `MyPlugin` | A PascalCase name that Pumpkin displays and uses for `plugins/data/MyPlugin/`. It defaults to the folder name converted to PascalCase. |
| Description | `Does a thing` | A non-empty, single-line description of at most 70 characters. It appears in package metadata, the plugin README, and the root README package list; add a fuller explanation to `src/info.ts` later. |

To provide the same answers without prompts, pass them in that order:

```sh
pnpm gen --args my-plugin MyPlugin "Does a thing"
```

## What the generator sets up

The new `packages/<folder>/` directory contains the files you need to begin:

- `package.json`, `tsconfig.json`, `vitest.config.ts`, and `turbo.json` configure the package, build,
  tests, and the Turbo typecheck cache.
- `src/name.ts`, `src/info.ts`, `src/commands/spec.ts`, and `src/plugin.ts` define the plugin name,
  metadata, starter command, and behavior. The plugin name and command permission each have one
  source declaration.
- `test/plugin.itest.ts` loads the built plugin on a real Pumpkin server and checks that its starter
  command works. The command and its permission are named after the folder, such as `/my-plugin`
  with `MyPlugin:command.my-plugin`, so they don't clash with Pumpkin's built-in commands. The
  integration-test task builds the package first.
- `README.md` starts with the plugin title and generated-content markers, including the component
  reference marker.

The generator also registers the package in both Release Please files. It starts the package at
`0.0.0` and pins its first release to `0.0.1`, regardless of the first commit type. The package
metadata includes the repository's standard license and repository fields. `pnpm check` validates
the description, those fields, and both release registrations. See [Registering a plugin for
releases](ci-and-releases.md#registering-a-plugin-for-releases) for how the first-release pin works.

The generator doesn't add the package's `plugin: <Name>` label. Add one to `.github/labels.yml`,
naming `packages/<folder>/` in its `ai_apply_when` like the existing plugin labels, then run
`node .github/scripts/coderabbit-labels.mjs` and commit both files. The issue form and label
validation workflow fails for a plugin package without a label. See
[Label management](ci-and-releases.md#label-management) for the catalog.

After writing the files, the generator runs `pnpm install`, fills the plugin README from `src/info.ts`,
adds its docs-site API reference link, updates the root README package list, and formats the new files
with Biome. The `🧬 Generator` CI job also creates a throwaway plugin and typechecks, builds, and
integration-tests it when the scaffold, generator setup, or generated plugin dependencies change.
That check catches templates that have drifted out of working shape.

## Make it your plugin

### Choose edition support

Plan for useful behavior on both Java and Bedrock. Features can differ, but a plugin that loads while
leaving an edition's relevant experience unchanged doesn't count as supported on that edition.

Use the pinned Pumpkin API to identify host limits, and verify client-dependent behavior with the
relevant real client before claiming it works. If the plugin's purpose requires a mod for one edition,
or a required Pumpkin API or client capability is unavailable, document the unsupported edition and
the reason in the plugin README. Keep behavior without real-client evidence marked as unverified.

Start with the metadata and starter command:

1. Describe the plugin in `src/info.ts`, including any permissions, commands, or config. Replace or
   extend the starter command in `src/commands/spec.ts` with `defineCommands`, and keep listing the
   commands in `info.commands` with `commandInfos` so the README documents what is registered. Keep
   the permission under the `COMMAND_PERMISSION` constant.
   [Plugin info and READMEs](plugin-info-and-readmes.md) explains how these declarations feed Pumpkin
   metadata and the generated README.
2. Add plugin behavior in `src/plugin.ts`, inside the `onPluginLoad` hook. The starter extends
   `PluginBase` and calls `registerPlugin`; together they provide shared metadata, lifecycle logging,
   and the automatic update check. Read [Building](building.md) before choosing APIs: Static Hermes
   is the default runtime and has runtime-specific API limits. Follow [Code style](code-style.md);
   public code needs JSDoc descriptions, and `pnpm lint` checks them.
3. If the plugin needs settings, declare them with `@pumpkin-plugins/config` and add that package as
   a dev dependency. See [Plugin config](plugin-config.md).
4. Build and test the package:

   ```sh
   pnpm build --filter @pumpkin-plugins/my-plugin
   pnpm turbo run test:integration --filter=@pumpkin-plugins/my-plugin
   ```

   Replace `my-plugin` with the package's folder name. The integration test loads the built plugin
   on a real Pumpkin server.

### Files and network access

The starter already enables the `http` capability for its automatic update check. To use file or
socket APIs, include their WASI capabilities in `pumpkinPlugin.wasi` in `package.json`. For example:

```json
"pumpkinPlugin": { "entry": "src/plugin.ts", "output": "build/my-plugin.wasm", "wasi": ["filesystem", "sockets", "http", "udp"] }
```

Declaring a capability makes its interface available to the plugin, but Pumpkin must also grant the
matching permissions. Shared plugin metadata adds `http.outbound` for the automatic updater; list
other permissions in `info.permissions`:

| Capability | Permissions you may need |
| --- | --- |
| `filesystem` | `fs.read.data` to read, `fs.write.data` to write. Both are limited to the plugin's own data folder, preopened as `data`. |
| `sockets` | `network.tcp.bind` to listen, `network.tcp.connect` to connect out. |
| `udp` | `network.udp.bind` to receive, `network.udp.outgoingdatagram` to send to any address, `network.udp.connect` to talk to one address. |
| `http` | `http.outbound` for HTTP or HTTPS requests. The automatic updater already adds this permission. |

## Without the generator

For a plugin in this monorepo, the generator handles several pieces that are easy to miss. If you
create the package by hand, you can copy `packages/dynamic-lights-pumpkin`, a released plugin with
commands, config and tests, and delete its `CHANGELOG.md`. You can also create a generated plugin
and remove what you don't need. Then check that you:

- Register it in both `release-please-config.json` and `.release-please-manifest.json`, and start
  its `package.json` version at `0.0.0`. The first-release config entry needs
  `"release-as": "0.0.1"`. See [Registering a plugin for releases](ci-and-releases.md#registering-a-plugin-for-releases);
  `node scripts/check-release-config.mjs` reports missing registration.
- Run `pnpm install` so pnpm links the package into the workspace.
- Run `pnpm readme` so the root package table and generated docs-site reference links include it.

## Standalone projects

For a plugin in a separate repository, use [`create-pumpkin-plugin`](../tools/create-pumpkin-plugin/README.md).
It offers TypeScript and JavaScript starters with the API and build dependencies, but it doesn't
include `plugin-kit`, Release Please registration, or this repository's integration-test scaffolding.

```sh
pnpm create pumpkin-plugin my-plugin
pnpm create pumpkin-plugin my-plugin --ts
pnpm create pumpkin-plugin my-plugin --js
```

The interactive command asks which language to use. Add `--skip-install` to create the files without
installing dependencies. The creator refuses an existing destination. Its README also documents
npm, Yarn Classic, Yarn Modern, and Bun launch forms; the validated packed-consumer build contract
covers pnpm only. See the [Plugin API guide](plugin-api/index.md) for API setup, lifecycle, ABI, and
migration details.
