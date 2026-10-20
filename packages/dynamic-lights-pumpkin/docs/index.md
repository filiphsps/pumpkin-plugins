# DynamicLightsPumpkin

DynamicLightsPumpkin gives players temporary light from supported held items, dropped items, and
configured entity types. It sends light-block changes to each player's client; it doesn't change the
server world. These lights are temporary and may disappear when the client reloads the area. The
light from a held item is shown only to the player holding it; other players don't see it.

The plugin supports Java Edition only. Pumpkin sends client-only block changes only to Java clients,
so Bedrock players get no light.

Install `dynamic-lights-pumpkin.wasm` in the Pumpkin server's `plugins/` directory and restart. On
first load, grant the plugin data-folder permissions in the server console. Players can run
`/dynamiclights` to turn the effect on or off for themselves; that choice is remembered across
restarts.

## Light sources

The generated `config.toml` lists the built-in item sources. Remove an entry or set its
`light_level` to `0` to disable it, or add an item ID with a level from `0` to `15`. Items in either
hand can provide light; when both qualify, the brighter one wins. See [Configure light sources](configuration.md)
for the item and entity settings.

Entity lighting is enabled by default and also covers dropped items. Every 10 ticks, the plugin
checks configured entity types within 15 blocks of each player along each axis, then sends changes
when a light moves, changes level, or leaves range. You can change the refresh interval in the
configuration; longer intervals mean less frequent checks and less smooth movement. Dropped items use
the matching held-item level when the plugin sees them spawn or can identify a player's drop. It
skips ambiguous drops and items already on the ground when the plugin starts.

## Updates and recovery

Player movement within the same block doesn't move a light. After item, inventory, teleport,
respawn, or world-change events, the plugin checks the completed state on the next tick. Turning the
effect off or unloading the plugin restores the real blocks to the affected clients. A recovery
reader also repairs temporary light levels left in the server world by an earlier plugin version.
