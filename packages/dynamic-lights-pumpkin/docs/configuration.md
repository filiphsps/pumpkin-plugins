# Configure light sources

Settings live in `plugins/data/DynamicLightsPumpkin/config.toml`. The plugin creates the file on
first load and manages the settings from its schema. Existing values are preserved; removed schema
settings are dropped. Apply edits with a server restart.

## Item light

Each `[sources."<item-id>"]` table sets a `light_level` from `0` through `15`. The item ID should
be the ID Pumpkin reports for that item, commonly namespaced, such as `minecraft:torch`.

```toml
[sources."minecraft:torch"]
light_level = 14

[sources."minecraft:lantern"]
light_level = 15

[sources."minecraft:custom_item"]
light_level = 10
```

Remove a source table or set its level to `0` to disable it. Non-block items can be sources too,
including a lava bucket. When both hands hold a configured source, the higher level is used.

## Entity light

`entities.enabled` controls entity lighting, and `entities.refresh_interval_ticks` controls how
often nearby entities are checked. A longer interval reduces checks but makes moving lights less
smooth. `entity_sources` maps Pumpkin entity names to levels:

```toml
[entities]
enabled = true
refresh_interval_ticks = 10

[entity_sources."blaze"]
light_level = 15

[entity_sources."glow-squid"]
light_level = 8
```

Only configured types emit light. Levels also range from `0` through `15`. The radius is a 15-block
cube around each player; entity lights update on the configured refresh interval.
