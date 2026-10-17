---
navigation:
    category: Plugin development
title: "Plugin config"
description: "Define plugin settings once, then load, validate, migrate and document them from the same schema"
---

# Plugin config

If your plugin has settings, define them once with `@pumpkin-plugins/config` (`tools/config`). The
schema gives you typed values, a managed TOML file, validation and upgrades, plus the options table
and default file shown in the plugin's README. Keeping those outputs tied to one schema helps server
admins understand what they can change and lets your plugin read the same settings the docs describe.

## Define settings

Use `section` for a fixed group of settings and `table` when users need named entries, such as
per-file overrides:

```ts
import {
    bool,
    defineConfig,
    int,
    section,
    str,
    table,
    type ConfigValues
} from '@pumpkin-plugins/config';

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

Each field's `description` appears in the config file and README. `bool`, `int`, and `str` declare
boolean, whole-number, and text settings. Give a field a `default` if it should have a value when
missing; leave it out to make the field optional. An unset optional value is `undefined`, and its
`example` appears as a commented hint in the file.

`int` bounds must be safe integers, and `min` cannot exceed `max`. Defaults and examples must be
safe integers within any declared bounds. For `str`, `check.test` validates the input before the
optional `check.normalize` tidies an accepted value. Defaults, examples, and accepted file values
are normalized.

Each `table` entry can set any of its declared fields; none is required. Use `ConfigValues` to get
the type of the object returned by `loadConfig`, inferred from your schema.

You can give any field a `migrateFrom: ['section', 'old_key']` path. When the new key is absent,
the old value can seed it; the new field's validation still applies. More than one field can read
the same old key.

Keys in TOML are the same keys you use in the typed values object, so name them in `snake_case`.
For checks that are specific to your plugin, wrap `str` with a helper in the plugin itself; for
example, see `packages/bedrock-addon-manager/src/config/fields.ts`.

If `bool`, `int`, and `str` don't fit a setting, `field()` lets you provide its type label,
expected-value message, example, parser, and TOML formatter. Custom field defaults can contain
TOML-compatible values, including plain tables, arrays, and dates. Structured defaults are copied
each time the library supplies them, so changing one result won't change the next. The copier
rejects cycles and JavaScript values that TOML can't represent.

If you use `table({ defaults })`, those entries are included in a fresh config file. Any omitted
fields in a starter entry receive their field defaults; fields without defaults stay absent. Users
can remove an entry or the whole table later, and loading an existing file won't put those table
defaults back.

## Load settings and handle upgrades

`loadConfig` works with a small storage adapter, so the config package doesn't need direct access to
the filesystem. Implement `read(): string | undefined` and `write(text: string): void` against your
plugin's data folder, then pass that adapter as `store`:

```ts
import { loadConfig } from '@pumpkin-plugins/config';

const result = loadConfig(configSchema, store, {
    note: 'Changes apply after /myplugin reload.'
});
const config = result.values; // Config, inferred from configSchema
```

`loadConfig` returns the typed values, a `status`, paths in `added` and `removed`, and any
`warnings`. Here's how it handles the file:

- **First start (`created`):** writes a new file with the schema defaults and comments.
- **Valid TOML (`updated` or `unchanged`):** keeps valid values, fills missing fields that have
  defaults, and removes settings the schema no longer recognizes. It rewrites the file only when
  the rendered contents differ.
- **Invalid config values or a section with the wrong shape (`kept`):** uses field defaults where
  available. An invalid optional field without a default is omitted, and a malformed table entry
  is ignored. The loader returns warnings and leaves the entire file untouched so the user can fix
  it.
- **Invalid TOML syntax:** throws `ConfigSyntaxError` with the line and column. The file isn't
  touched.

On a successful rewrite, `added` lists missing section fields that have defaults, and `removed`
lists settings or sections the schema no longer recognizes. Defaults filled in for missing fields
inside table entries aren't included in `added`. An optional section field without a default still
appears as a commented example in the rendered file, but it has no value to report as added.

When a field has `migrateFrom`, the loader checks that old path only if the new key is absent. It
validates the old value with the new field's rules before using it. If migration succeeds and the
file can be rewritten, a target section field with a default appears in `added`; any old key the
schema no longer recognizes appears in `removed`. If the old value fails validation, the loader
returns a warning and leaves the whole file untouched, with empty `added` and `removed` lists. The
target field's default is used when it has one; an optional target with no default is omitted.

Whenever the loader rewrites a file, it renders the TOML from the schema. That keeps the file in a
consistent format, but comments added by a user are lost. The default header note explains this;
you can replace it with the `note` option. In the Bedrock addon plugin, the storage adapter writes
through `DataFiles.writeFile`, which replaces the file atomically.

## Document the settings

Use `describeConfig` to build the README's config section from the same schema and render options
you pass to `loadConfig`:

```ts
export const configInfo = describeConfig(configSchema, 'config.toml', { note: '...' });
```

Pass `configInfo` as `info.config`. The generated README will show the options table and the TOML a
fresh install gets. See [Plugin info and READMEs](plugin-info-and-readmes.md).
