# Configure light sources

Edit `plugins/data/DynamicLightsPumpkin/config.toml` to change the light sources. DynamicLightsPumpkin
creates the file when it first loads, adds settings when its configuration schema grows, and removes
settings that the schema no longer supports. Your values for supported settings are kept. Restart the
server to apply your edits.

## Item lights

Each `[sources."<item-id>"]` table sets the light level for a held item and for dropped items the
plugin observes. Set `light_level` from `0` through `15`. Use the item ID with its namespace, such
as `minecraft:torch`; an ID without one, such as `torch`, means `minecraft:torch`:

```toml
[sources."minecraft:torch"]
light_level = 14

[sources."minecraft:lantern"]
light_level = 15

[sources."minecraft:custom_item"]
light_level = 10
```

Remove a source table or set its level to `0` to disable it. Items don't need to be blocks to emit
light; for example, a lava bucket can be a source. If both hands hold configured sources, the brighter
one determines your light level.

## Entity light

Set `entities.enabled` to `false` to turn off entity lighting, including dropped items. When it's enabled, the plugin checks
nearby entities every `entities.refresh_interval_ticks` ticks (default `10`, allowed range `1` to
`1200`). A longer interval means fewer checks, but moving lights update less smoothly. Add an
`entity_sources` table for each Pumpkin entity name you want to emit light:

```toml
[entities]
enabled = true
refresh_interval_ticks = 10

[entity_sources."blaze"]
light_level = 15

[entity_sources."glow-squid"]
light_level = 8
```

Only configured types emit light; set `light_level` from `0` through `15`. The plugin checks entities
within 15 blocks of each player along each axis, then updates their lights on the configured interval.
