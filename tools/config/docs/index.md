# Plugin configuration library

Use `@pumpkin-plugins/config` to describe a plugin's settings once. From that schema, the library
builds typed values, manages a TOML file, validates changes, and produces the configuration section
for the plugin's README. The library handles the config data; your plugin supplies the small storage
adapter that reads and writes its data file.

## Declare settings

Use `bool`, `int`, and `str` for individual settings. Put fixed groups of settings in `section` and
use named `table` entries when users need to add their own groups, such as per-file overrides.
Defaults apply to new files; omit a default to make a field optional.

```ts
import { bool, defineConfig, int, section } from '@pumpkin-plugins/config';

export const configSchema = defineConfig('ExamplePlugin', {
    web: section({
        description: 'Web server settings.',
        fields: {
            enabled: bool({ description: 'Enable the server.', default: true }),
            port: int({ description: 'Listening port.', default: 8123, min: 1, max: 65535 })
        }
    })
});
```

Set integer bounds to safe whole numbers in ascending order; any integer default or example must
fall within those bounds. String checks can validate values and normalize accepted input. Defaults,
examples, and values read from the file all use the normalized form. You can also set `migrateFrom`
on a field to copy a value from an older key when the new key is absent; the new field's validation
still applies.

For custom fields, defaults can use TOML values: scalars (including `bigint`), plain tables, dense
arrays, and `Date` values. The library copies tables, arrays, and dates when it creates config
values, so changing one result won't affect another. Root `undefined` marks an optional field;
nested `undefined`, `null`, functions, symbols, symbol-keyed table entries, cycles, and other
JavaScript object types aren't supported.

## Load and maintain the file

Pass the schema and a storage adapter to `loadConfig`. The library doesn't access the filesystem
itself; your plugin connects the adapter to its data folder and uses the returned typed values.

On first load, the library writes the defaults. On later loads, it keeps valid user values, fills
in missing settings that have defaults, and removes keys the schema no longer recognizes. Invalid
values use defaults where available, produce a warning, and leave the file untouched so users can
correct it. Invalid TOML raises `ConfigSyntaxError` with a location and doesn't rewrite the file.

The same schema can produce the README options table and a TOML example for a fresh install, keeping
the documented settings in sync with the file. With `table({ defaults })`, initial entries and
defaults for their omitted fields appear in a fresh file; fields without defaults stay absent.
Users can remove an entry or the whole table later, and loading an existing file doesn't restore
those table defaults.
