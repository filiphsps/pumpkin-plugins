# Plugin configuration library

`@pumpkin-plugins/config` lets a plugin declare settings once and derives typed values, a managed
TOML file, validation, schema upgrades, and README configuration output from that schema.

## Declare settings

Use `bool`, `int`, and `str` fields inside fixed `section` groups or named `table` entries. Defaults
are written for fresh installs; fields without defaults are optional. Integer bounds, string checks,
examples, and migrations from old keys belong on the field declaration.

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

Pass the schema and a small storage adapter to `loadConfig`. The library does not access the
filesystem itself. Plugins normally adapt their data folder and use the returned typed values.

## File and validation behavior

On first load, the library writes defaults. It adds new settings, removes keys no longer in the
schema, and preserves user values. Invalid values fall back to defaults with a warning while the
file remains untouched. Invalid TOML raises `ConfigSyntaxError` with a location and does not
rewrite the file. When a setting is renamed, `migrateFrom` can seed its new key from an old one.

The same schema can produce the README options table and a fresh-install TOML example, so plugin
settings and their documentation share one source.
