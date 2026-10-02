# Creating a plugin

```sh
pnpm gen
```

This runs the `plugin` generator (a [Turborepo generator](https://turborepo.dev/docs/guides/generating-code),
defined in `turbo/generators/`). It asks for three things:

| Prompt | Example | Used for |
| --- | --- | --- |
| Folder name | `my-plugin` | `packages/my-plugin/`, the npm package name, the release tag prefix and the `.wasm` file name. Kebab-case, and the folder must not exist yet. |
| Plugin name | `MyPlugin` | The name Pumpkin shows and the data folder name (`plugins/data/MyPlugin/`). PascalCase. Defaults to the folder name converted. |
| Description | `Does a thing` | The plugin's metadata, its README, its `package.json` and the package table in the root README. At most 70 characters, since it is also the package description; `src/info.ts` can say more later. |

To skip the prompts, pass the answers in that order:

```sh
pnpm gen --args my-plugin MyPlugin "Does a thing"
```

## What it does

1. Creates `packages/<folder>/` with a working plugin: `package.json`, `tsconfig.json`,
   `vitest.config.ts`, `src/info.ts`, `src/plugin.ts`, a barebones `README.md` (a title and the
   generated blocks) and an integration test that loads the built plugin on a real Pumpkin server.
2. Registers the plugin for releases: an entry in `release-please-config.json` (with
   `"release-as": "0.0.1"`) and one in `.release-please-manifest.json`, with the plugin starting at
   version `0.0.0`, so that its first release is `0.0.1`. The `package.json` comes with the license,
   author, repository and funding metadata every package has. CI fails if a plugin isn't registered
   or its metadata is incomplete (`pnpm check`). See
   [Registering a plugin for releases](ci-and-releases.md#registering-a-plugin-for-releases).
3. Runs `pnpm install`, fills in the plugin's README from its `info.ts`, and adds the plugin to the
   package table in the root README.
4. Formats the new files with Biome.

It doesn't commit anything. A CI job (`🧬 Generator`) generates a throwaway plugin on every run
and typechecks, builds and integration-tests it, so the templates can't silently rot.

## Next steps

- Describe what the plugin needs in `src/info.ts` (permissions, commands, config), declaring commands
  with `defineCommands`. See [Plugin info and READMEs](plugin-info-and-readmes.md).
- Write the plugin in `src/plugin.ts`. Read [Building](building.md) first: the plugins run on
  QuickJS and a few API calls need workarounds. Follow [Code style](code-style.md): public code
  needs JSDoc descriptions and `pnpm lint` checks it.
- If the plugin needs settings, declare them as a schema with `@pumpkin-plugins/config` and add it
  as a dev dependency. See [Plugin config](plugin-config.md).
- Run `pnpm exec turbo run build test:integration --filter=@pumpkin-plugins/<folder>` to build the
  plugin and load it on a real server.

### Files and network access

A plugin can't read files or open sockets unless its WIT world imports the WASI interfaces. Opt in
per plugin in `package.json`:

```json
"pumpkinPlugin": { "entry": "src/plugin.ts", "output": "build/my-plugin.wasm", "wasi": ["filesystem", "sockets"] }
```

The server also has to grant the matching permissions, so list them in `info.permissions`:

| Capability | Permissions the plugin will typically request |
| --- | --- |
| `filesystem` | `fs.read.data`, `fs.write.data` (access is limited to the plugin's own data folder, preopened as `data`) |
| `sockets` | `network.tcp.bind` to listen, `network.tcp.connect` to connect out |
| `udp` | `network.udp.bind` to receive, `network.udp.outgoingdatagram` to send to any address, `network.udp.connect` to talk to one |

## Without the generator

Copy `packages/bedrock-addon-manager` or generate a plugin and delete what you don't need. Three
things are easy to forget:

- The plugin has to be registered for releases: an entry in `release-please-config.json` **and**
  one in `.release-please-manifest.json`, with the plugin at version `0.0.0`. The exact entries are
  in [Registering a plugin for releases](ci-and-releases.md#registering-a-plugin-for-releases), and
  `node scripts/check-release-config.mjs` tells you what is missing.
- `pnpm install` has to run so the workspace links are created.
- `pnpm readme` has to run so the package table in the root README lists it.
