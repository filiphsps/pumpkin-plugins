# Plugin config

Plugins that need settings use `@pumpkin-plugins/config` (`tools/config`). A plugin declares its
settings once, as a schema, and everything else comes from that one object:

- the config file a fresh install gets, with a comment for every setting,
- validation and typed values,
- the upgrade of an existing file when settings are added or removed,
- the options table and default file in the plugin's README.

Nothing is hardcoded: no default file text, and no second list of settings to keep in step.

## Declaring a schema

```ts
import { bool, defineConfig, int, section, str, table } from '@pumpkin-plugins/config';

export const configSchema = defineConfig('MyPlugin', {
    web: section({
        description: 'The web server.',
        fields: {
            enabled: bool({ description: 'Serve over HTTP.', default: true }),
            port: int({ description: 'Port to listen on.', default: 8123, min: 1, max: 65535 })
        }
    }),
    overrides: table({
        description: 'Per-file settings, keyed by file name.',
        entryName: 'file',
        exampleKey: 'a.txt',
        fields: {
            order: int({ description: 'Position in the list.', example: 10 }),
            token: str({ description: 'Optional access token.', example: 'secret' })
        }
    })
});

export type Config = ConfigValues<typeof configSchema>;
```

| Piece | |
| --- | --- |
| `bool`, `int`, `str` | Settings. Give a `default`, or leave it out to make the setting optional (its value is then `undefined` when unset). `int` takes `min` and `max`; `str` takes a `check` with its own `test` and `normalize`. Any field can use `migrateFrom: ['section', 'old_key']` to seed a newly added setting from an older value when its new key is absent. Multiple fields can read the same old key. |
| `section` | A fixed group of settings, written as `[name]`. |
| `table` | Named entries that share optional settings, written as `[name."entry"]`. Entries are user data and are kept as they are. |
| `ConfigValues` | The typed object `loadConfig` returns, inferred from the schema. |

Domain-specific checks (a URL, an IPv4 address, a folder inside the data folder) are small wrappers
around `str` in the plugin itself. See `packages/bedrock-addon-manager/src/config/fields.ts`.

Keys in the file and in the typed object are the same, so use `snake_case` names.

## Loading

```ts
const result = loadConfig(configSchema, store, { note: 'Changes apply after /myplugin reload.' });
result.values; // typed Config
```

`store` is anything with `read(): string | undefined` and `write(text)`. The library doesn't touch
the filesystem itself. A plugin adapts its data folder; see `src/config/load.ts` in the Bedrock
plugin, which also logs what happened.

What `loadConfig` does to the file:

| Situation | Result |
| --- | --- |
| No file | Writes the defaults. Status `created`. |
| File matches the schema | Nothing. Status `unchanged`. |
| A setting was added to the schema | Written with a migrated value when configured, otherwise its default. Listed in `added`. |
| A setting was removed from the schema | Dropped from the file. Listed in `removed`. |
| The user's values | Kept. |
| A value is invalid | The default is used and a warning is returned. **The file is not rewritten**, so what the user typed isn't lost. Status `kept`. |
| The file isn't valid TOML | Throws `ConfigSyntaxError` with the line and column. **The file is not touched.** |

When a field declares `migrateFrom`, an existing source value is validated with the new field's
rules and used in place of its default. The new field is still listed in `added`; the old source
key is removed with other unknown settings. If the source value is invalid for the new field, the
file is left untouched and a warning is returned.

Rewriting the file normalizes it, so comments the user adds are not kept. The header note says so.
The plugin writes through `DataFiles.writeFile`, which replaces the file atomically, so a crash
can't leave half a file.

## Documentation

```ts
export const configInfo = describeConfig(configSchema, 'config.toml', { note: '...' });
```

Pass the same render options as `loadConfig` so the README shows exactly the file a fresh install
gets. Use `configInfo` as `info.config`; see [Plugin info and READMEs](plugin-info-and-readmes.md).
