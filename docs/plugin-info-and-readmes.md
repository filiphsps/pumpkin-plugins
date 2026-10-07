# Plugin info and READMEs

## `src/info.ts`

Each plugin describes itself in one small module that exports `info`:

```ts
import { commandInfos, type PluginInfo } from '@pumpkin-plugins/docs';
import { commands } from './commands/spec.ts';
import { configInfo } from './config/schema.ts';
import { PLUGIN_NAME } from './name.ts';

/** What the plugin is and offers. Feeds both its Pumpkin metadata and its generated README. */
export const info = {
    name: PLUGIN_NAME,
    description: 'Does a thing.',
    permissions: [{ name: 'fs.read.data', reason: 'Read its config.' }],
    commands: commandInfos(commands),
    config: configInfo
} satisfies PluginInfo<typeof PLUGIN_NAME>;
```

`permissions`, `commands` and `config` are optional. Plugins pass this object and the injected
package version to `PluginBase` from `@pumpkin-plugins/plugin-kit/plugin`. It builds Pumpkin
metadata from the same object, so the README can't drift from what the plugin actually asks for.
The shared metadata helper also adds `http.outbound` for the automatic Pumpkin Market update check;
it appears in the generated README even though plugins don't repeat it in `info.permissions`:

```ts
import { PluginBase } from '@pumpkin-plugins/plugin-kit/plugin';

class MyPlugin extends PluginBase {
    constructor() {
        super(info, __PLUGIN_VERSION__);
    }
}
```

`__PLUGIN_VERSION__` is the package version, injected by the build (and by the vitest config in
tests).

`info` is typed, so mistakes fail `pnpm typecheck` instead of surfacing at runtime:

- `permissions[].name` must be a permission Pumpkin knows (`PumpkinPermission`, listed in
  `tools/docs/src/permissions.ts`, plus `sys.env.<NAME>`). With `satisfies`, `typeof
  info.permissions[number]['name']` is the union of the names the plugin actually lists.
- `commands[].permission` must start with the plugin's name, because `PluginInfo<Name>` is
  parameterized by it.

`blocks` is optional too: extra generated README blocks by name, for content that comes from the
plugin's code. UPnPumpkin renders its table of blocked routers into the `routers` block this way. The
built-in names can't be used, and a block the README has no markers for is skipped.

`config` is normally not written by hand: `describeConfig(schema, file)` from
`@pumpkin-plugins/config` produces it from the plugin's config schema, so the README shows the real
default file and a table of every setting. See [Plugin config](plugin-config.md).

Info modules are loaded directly by Node with the types stripped, so they may import plain modules
(a config schema, constants, a command declaration) but nothing from Pumpkin or WASI.

Pumpkin requires a plugin's permission nodes to start with the plugin's name, as in
`MyPlugin:command.reload`. A node with any other prefix makes the plugin fail to load.

## Commands

Commands are declared once, in a module with no Pumpkin imports, and that one declaration both
registers them and documents them, so a command can't be in the README without existing or the other
way round:

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
    'myplugin reload': () => ['Reloaded.'] // the lines to send back
});
```

- `info.commands` is `commandInfos(commands)`: one README row per runnable command (`/myplugin
  reload`), including its permission and default access, taken from the declaration.
- A subcommand can declare its own `permission`; otherwise it inherits the nearest parent's node.
  Use dotted paths such as `${PLUGIN_NAME}:command.myplugin.reload` to create a waterfall. A parent
  permission grants its child nodes through Pumpkin's permission tree.
- Permissions default to operators at level 3 and the console. Set `defaultPermission: { tag:
  'allow' }` on a command to make it usable by everyone, or `{ tag: 'deny' }` to deny it by default.
  The setting is per permission node, so a read-only subcommand can be public while `reload` stays
  operator-only.
- The handlers are typed against the declaration (`CommandHandlers`): a command without a handler, or
  a handler for a command that doesn't exist, doesn't compile.
- `registerCommands` registers the permission nodes and checks each runnable subcommand against its
  declared permission. The tree is built by `buildCommands` in
  `@pumpkin-plugins/plugin-kit/commands`, which takes the host's command classes as an interface;
  a plugin's tests run it against `FakeCommandHost` and compare what it registers with
  `info.commands` (see `src/commands/handlers.test.ts` in a plugin).
- A handler returns lines: plain strings, or `errorLine(text)` for a line shown in red. Throwing
  `CommandFailed(message)` makes the command fail the way the server reports a failed command, with
  the message in red.
- A command with subcommands only groups them; only the leaves are runnable and listed. Commands with
  arguments aren't declared this way yet.

Descriptions are plain strings in the one declaration, so turning them into message keys for
translation later means changing that file and the two places that read it, not hunting through the
code.

## Generated README blocks

`pnpm readme` refreshes the blocks between `<!-- docs:begin NAME -->` and `<!-- docs:end NAME -->`
in a plugin's `README.md`:

| Block | Rendered from |
| --- | --- |
| `summary` | `info.description` |
| `permissions` | `info.permissions` plus the automatic updater permission |
| `commands` | `info.commands` |
| `config` | `info.config`: the options table and the default file contents |
| anything else | `info.blocks`: the markdown the plugin gave under that name |

Everything outside the markers is yours to write. A block the README doesn't contain is skipped.
Unbalanced or duplicated markers are an error.

The README has to exist. `pnpm gen` creates it from `turbo/generators/templates/plugin/README.md.hbs`,
a barebones file with a title and the four blocks, and the first `pnpm readme` fills them in. A
missing README is an error rather than something the tool invents.

Versions are deliberately not part of generated content, because release-please changes them in
the release PR and the README would be stale the moment it merged.

## The root README

The tables in the root `README.md` are rebuilt by `pnpm readme`. The Actions table has one row per
folder in `actions/` with an `action.yml` or `action.yaml`, using its top-level `name` and
`description` and linking to the folder. The package tables have one row per folder in `packages/`
and `tools/`, also linked to the folder. Plugins are listed by their `info.name` and
`info.description`, tools by their `package.json`.
The package tables show the `license` from each package's `package.json`. A package with its own
`LICENSE`, `LICENSE.md` or `LICENSE.txt` file (case-insensitive) gets a relative link to that file.
Packages using the repository's root license show the license as plain text.

Tools aren't generated: each one has a small hand-written README (a title that is its package name,
what it is for, and a link to the doc that covers it), and `pnpm check` fails when one is missing.

## When it runs

- `pnpm readme` regenerates everything locally. `pnpm readme:check` fails if anything is stale.
- CI only checks that generation succeeds, so contributors don't have to commit regenerated
  READMEs.
- Each time release-please creates or updates the release PR, the release job regenerates the
  READMEs and commits them to the PR branch. See [CI and releases](ci-and-releases.md).
- `pnpm gen` generates the new plugin's README and updates the root table straight away.
