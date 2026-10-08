# DynamicLightsPumpkin

DynamicLightsPumpkin shows temporary, client-only light around supported held items, dropped items,
and configured entity types. The server world is not changed, so temporary light cannot replace a
real block or remain after a crash.

Install `dynamic-lights-pumpkin.wasm` in the Pumpkin server's `plugins/` directory and restart. On
first load, grant its data-folder permissions in the server console. Players can run
`/dynamiclights` to toggle the effect for themselves; the choice is remembered.

## Light sources

Built-in item sources are listed in the generated `config.toml`. Remove an item entry to disable
it, set `light_level` to `0`, or add another item ID with a level from `0` to `15`. Either hand can
provide light; if both do, the brighter source wins.

Entity lighting is enabled by default. The plugin checks configured entities in a 15-block cube
around each player every 10 ticks by default, and sends changes when a source moves, changes level,
or leaves range. Dropped items use their held-item level when the plugin observes their spawn or a
player drop. Ambiguous drops and items already on the ground when the plugin starts are not guessed.

## Updates and recovery

Movement within a block is ignored. Item, inventory, teleport, respawn, world-change, and entity
events are applied using the completed state on the next tick. Disabling the effect or unloading
the plugin restores real blocks. The plugin retains a reader for recovery data from an earlier
version so it can repair temporary light levels written by that version.

See the configuration page for the item and entity tables and an example override.
