# Plugin configuration library

Use `@pumpkin-plugins/config` to describe a plugin's settings once. From that schema, the library
builds typed values, manages a TOML file, validates changes, and produces the configuration section
for the plugin's README. The library handles the config data; your plugin supplies the small storage
adapter that reads and writes its data file.

The [plugin config guide](../../../docs/plugin-config.md) covers declaring settings, loading and
upgrading the file, the load statuses and warnings, and generating the README section.
