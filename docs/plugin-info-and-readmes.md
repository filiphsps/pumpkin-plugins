---
navigation:
    category: Plugin development
title: "Plugin info and READMEs"
description: "Define plugin metadata once, connect commands and settings, and generate the README"
---

# Plugin info and READMEs

A plugin's `src/info.ts` describes it for Pumpkin and the generated README. The root README also
uses the plugin's name and short description in its package list. Commands and settings have their
own declarations; `info.ts` points to those sources so the README describes what the plugin
registers and configures.

## Describe the plugin in `src/info.ts`

Each plugin exports one `info` object. Keep its runtime imports host-independent, and point it to
the command tree and configuration summary the plugin already uses:

```ts
import { commandInfos, type PluginInfo } from '@pumpkin-plugins/docs';
import { commands } from './commands/spec.ts';
import { configInfo } from './config/schema.ts';
import { PLUGIN_NAME } from './name.ts';

/** What the plugin is and offers. Feeds Pumpkin metadata and the generated README. */
export const info = {
    name: PLUGIN_NAME,
    description: 'Formats player list names and headers consistently.',
    permissions: [{ name: 'fs.read.data', reason: 'Read its config.' }],
    commands: commandInfos(commands),
    config: configInfo
} satisfies PluginInfo<typeof PLUGIN_NAME>;
```

`name` and `description` are required. You can also list `authors`, requested `permissions`,
`commands` and `config`, or provide extra generated README `blocks`. The `PluginInfo` type checks
the object while preserving its literal values.

Pass `info` and the package version to `PluginBase`:

```ts
import { PluginBase } from '@pumpkin-plugins/plugin-kit/plugin';

class MyPlugin extends PluginBase {
    constructor() {
        super(info, __PLUGIN_VERSION__);
    }
}
```

`__PLUGIN_VERSION__` is injected from the package version during builds and by the Vitest config
when tests run. Its type declaration ships with `@pumpkin-plugins/build`, so add
`node_modules/@pumpkin-plugins/build/globals.d.ts` to the `include` list in your `tsconfig.json`;
without it, TypeScript reports `Cannot find name '__PLUGIN_VERSION__'`. Plugins in this repository
include `../../tools/build/globals.d.ts` instead.

`PluginBase` uses the object and version to build Pumpkin's plugin metadata: name,
version, authors, description and requested permissions. The metadata also includes the automatic
update-check permission, `http.outbound`; the README lists it too, with its reason, even though you
don't need to add it to `info.permissions`.

The type catches mistakes before they reach the server:

- Each `permissions[].name` must be a permission Pumpkin supports: one of the values in
  `tools/docs/src/permissions.ts` or a `sys.env.<NAME>` permission. With `satisfies`, the names you
  list remain a literal union, so TypeScript can check code that uses those permissions.
- Command permission nodes must start with the plugin's name. `PluginInfo<typeof PLUGIN_NAME>`
  checks that prefix for every command listed in `info.commands`.

Plugin permissions and command permission nodes serve different purposes. For example,
`fs.read.data` is a host capability and doesn't have a plugin-name prefix. A command node such as
`MyPlugin:command.reload` is scoped to your plugin; Pumpkin rejects a command node with a different
prefix when it loads the plugin.

You can use `blocks` for additional README content that comes from the plugin's code. UPnPumpkin,
for example, renders its blocked-router table into a `routers` block. The names `summary`,
`permissions`, `commands`, `config` and `installation` are reserved. If the README has no markers for one of your
custom blocks, the generator skips it.

Build `config` from the plugin's configuration schema with `describeConfig(schema, file)` from
`@pumpkin-plugins/config`. The generated README then shows the actual default file and a row for each
setting. See [Plugin config](plugin-config.md).

The docs generator imports `src/info.ts` directly in Node, with TypeScript types stripped. Runtime
imports in that module must therefore work without Pumpkin or WASI. Plain modules such as a config
schema, constants and command declarations are fine; importing host runtime modules is not.

## Declare commands once

Keep the command tree in a module without Pumpkin imports. The same declaration supplies the command
registration code and the README, so a description or permission doesn't need a second hand-written
copy:

```ts
// src/commands/spec.ts
import { defineCommands } from '@pumpkin-plugins/docs';
import { PLUGIN_NAME } from '../name.ts';

export const commands = defineCommands(PLUGIN_NAME, {
    myplugin: {
        description: 'Manage MyPlugin',
        permission: `${PLUGIN_NAME}:command.myplugin`,
        subcommands: {
            reload: {
                description: 'Reload the config',
                permission: `${PLUGIN_NAME}:command.myplugin.reload`
            }
        }
    }
});
```

```ts
// src/commands/register.ts
import { registerCommands } from '@pumpkin-plugins/plugin-kit/register-commands';

registerCommands(ctx, commands, {
    'myplugin reload': () => ['Reloaded.'] // lines sent back to the caller
});
```

`registerCommands` gives each handler a plugin-kit handler ID, and only the kit's `handleCommand`
knows those IDs. Export it from your entry point, together with `handleTask`, so the named exports
replace the API package's versions that `export *` would otherwise re-export:

```ts
// src/plugin.ts
export { handleCommand, handleTask } from '@pumpkin-plugins/plugin-kit/plugin';
export * from '@pumpkin-plugins/pumpkin-api';
```

Without the `handleCommand` export, Pumpkin calls the API package's handler, and every registered
command fails with `No handler for command ID`.

Set `info.commands` to `commandInfos(commands)`. That produces one README row for each runnable
command, such as `/myplugin reload`, with its description, permission and default access.

A command with subcommands is a group; only its runnable leaves appear in the README. If a
subcommand doesn't declare a permission, it inherits the nearest parent's node. Dotted nodes such as
`${PLUGIN_NAME}:command.myplugin.reload` form a permission tree, so Pumpkin can grant a parent node
access to its child nodes.

By default, level 3 operators and the console may run a command. Set
`defaultPermission: { tag: 'allow' }` to let everyone run it, or `{ tag: 'deny' }` to deny it by
default. The access setting belongs to each permission node, so you can make a read-only subcommand
public while keeping `reload` operator-only.

`CommandHandlers` checks your handlers against the declaration: a missing handler or a handler for
an unknown command fails type checking. If the command takes arguments, TypeScript also infers the
handler's argument values from the declaration.

`registerCommands` registers the permission nodes and checks each runnable subcommand against its
declared permission. The `buildCommands` helper in
`@pumpkin-plugins/plugin-kit/commands` builds the host command tree. Plugin tests can run that helper
with `FakeCommandHost` and compare the registered commands with `info.commands` (see
`src/commands/handlers.test.ts` in a plugin).

A handler returns lines to send to the caller: plain strings or `errorLine(text)` for a red line.
Throwing `CommandFailed(message)` fails the command and shows the message in red.

A command leaf can take arguments. `commandInfos(commands)` adds each argument name to its usage in
the README:

```ts
locate: {
    description: 'Find a location',
    permission: `${PLUGIN_NAME}:command.locate`,
    arguments: [
        { name: 'x', type: 'integer', min: -30_000_000, max: 30_000_000 },
        { name: 'name', type: 'string', mode: 'quotable' }
    ]
}
```

Use `argumentVariants` when one command should work with no arguments and accept several positional
forms. The declaration still drives the handler types, host command tree and README:

```ts
locate: {
    description: 'Find a location',
    permission: `${PLUGIN_NAME}:command.locate`,
    argumentVariants: [
        [{ name: 'radius', type: 'integer', min: 0, max: 16 }],
        [
            { name: 'x', type: 'integer' },
            { name: 'z', type: 'integer' }
        ],
        [
            { name: 'x', type: 'integer' },
            { name: 'z', type: 'integer' },
            { name: 'radius', type: 'integer', min: 0, max: 16 }
        ]
    ]
}
```

This gives you `/locate`, `/locate <radius>`, `/locate <x> <z>` and
`/locate <x> <z> <radius>`. `CommandHandlers` requires a handler for every form and infers its
argument values. You can't combine variants with fixed `arguments` or literal `subcommands`; shared
argument prefixes become one branch in the registered command tree.

Integer arguments can set signed 32-bit `min` and `max` bounds. Strings support `single-word`,
`quotable` and `greedy` modes; a greedy string must be the final argument. Argument handlers receive
a second parameter with inferred values, such as `(sender, { x, name })`. Commands without
arguments use a sender-only handler. Arguments follow the literal command path, and literal
subcommands can't follow an argument node.

Command descriptions are plain strings in the declaration. If you later move them to message keys
for translation, update the declaration and both places that consume it.

## What `pnpm readme` generates

`pnpm readme` refreshes the blocks between `<!-- docs:begin NAME -->` and `<!-- docs:end NAME -->`
in a plugin's `README.md`:

| Block | Source |
| --- | --- |
| `summary` | `info.description` |
| `permissions` | `info.permissions` plus the automatic updater permission |
| `commands` | `info.commands` |
| `config` | `info.config`: the options table and default file contents |
| `installation` | `pumpkinPlugin.output` in `package.json`; a plugin listed in `release-please-paused.json` gets build steps and the reason instead of a download link |
| Any other name | Markdown in `info.blocks` under that name |

Write your plugin overview, examples and installation guidance outside these blocks. The generator
leaves that prose alone. A block without markers is skipped; duplicated or unbalanced markers are
an error.

Market publishing combines `info.description` with the README's handwritten content. It omits
generated `docs:` blocks and the `## Installation` and `## Commands` sections. Command metadata is
sent separately from `info.commands`.

The README must already exist. `pnpm gen` creates a starter from
`turbo/generators/templates/plugin/README.md.hbs`, with a title and the four built-in blocks; the
first `pnpm readme` fills them in. If the file is missing later, generation reports an error instead
of inventing a replacement.

Each plugin, tool and action README also has a generated `reference` block. The repository-level
`pumpkin-plugins-docs root` command builds API links from package manifests and action metadata. If a
component has `docs/index.md`, the block also links to that guide. The public site base URL comes
from the root package's GitHub repository URL. Keep the markers in place and let `pnpm readme`
refresh the links from these sources; you don't need to copy component names, slugs or site URLs into
the README.

Generated content deliberately omits versions. Release Please updates package versions in its
release PR, so putting a version in the README would leave it stale as soon as the release merges.

## What goes in the root README

`pnpm readme` rebuilds the root README's component tables from repository metadata:

- The Actions table lists each folder in `actions/` with an `action.yml` or `action.yaml`, using its
  top-level `name` and `description` and linking to the folder.
- The Plugins table lists folders in `packages/` by `info.name` and `info.description`. The Tools
  table uses each tool's `package.json`; the VS Code extensions table uses extension metadata.
- Package tables show the `license` from `package.json`. When a package has its own `LICENSE`,
  `LICENSE.md` or `LICENSE.txt` file (case-insensitive), the table links to it. Packages that use
  the repository's root license show the license as plain text.

Tool README prose is handwritten: each file explains what its package does and links to relevant
guides. A tool can also generate custom README blocks from a typed `documents` module with
`pumpkin-plugins-docs generate`; see the [generator guide](../tools/docs/docs/index.md). The root
generator fills the API reference block, and `pnpm check` fails if a tool README is missing.

The root README's public documentation link comes from the same repository URL. The package and
action tables, site link, and component README references are all refreshed by `pnpm readme`.

## When to run it

Run `pnpm readme` after changing plugin information, command declarations, config schemas, action
inputs or outputs, package metadata, or component guides. It runs component generators, refreshes
action input/output tables and rebuilds the root tables, README references and docs index.

Run `pnpm readme:check` to find stale generated content without writing files. CI checks that the
generated content is current, so commit the generated README changes along with their source change.
Each time Release Please creates or updates its release PR, the release job regenerates the READMEs
and commits them to that PR branch. See [CI and releases](ci-and-releases.md).

When you use `pnpm gen` to create a plugin, the generator creates and fills its README and updates
the root package list as part of scaffolding.
