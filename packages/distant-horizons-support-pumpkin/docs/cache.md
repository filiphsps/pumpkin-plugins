# Manage the LOD cache

Distant Horizons Support keeps every captured LOD section in two caches: one in memory and one on
disk under `plugins/data/DistantHorizonsSupportPumpkin/cache/`. Each cache has its own entry limit.
The memory cache also holds at most `memory_cache_mb` of LOD data and evicts the least recently used
sections first; a section larger than that limit is kept only on disk. The plugin README's
configuration table explains how to change or disable these limits. Disk entries survive restarts,
and the plugin can send a cached section even after its chunks unload. If your settings file still
has the old shared `cache_entries` limit, the plugin copies its value to both new limits.

The `/dhs` commands below need operator access by default. Map, forced capture and recovery work on
the world you are standing in, so run them in game.

## See what is cached

Run `/dhs map` to see the cached sections around you, or `/dhs map <x> <z>` to center the map on
block coordinates. Add a radius in sections to look further. Up to radius 10, each cell is one
64 × 64 block section, which is four by four server chunks. Larger maps are scaled down to 21 × 21
cells so they fit in chat.

`/dhs cache status` shows how many entries and bytes each cache holds.

## Capture an area ahead of time

Run `/dhs generate` or `/dhs generate <x> <z>`, with an optional radius in sections, to capture an
area before players ask for it. The plugin skips sections that are already cached and tells you
when nothing needs capturing. Only one forced capture runs at a time. It gets up to 32,768 block
samples per tick, fewer when server MSPT and the measured cost per sample leave less spare tick
time. It reports its progress in chat about every 10%, and `/dhs status` shows the active job.

A forced capture uses only loaded terrain. It skips sections whose chunks aren't loaded, so bring
the area into range first, through normal play or a server chunk-loading tool. While it runs,
ordinary captures pause, but the plugin keeps sending cached sections to clients.

## Keep the cache current

A cached section is rebuilt once it is older than `refresh_seconds` and all of its chunks are
loaded. Until then, clients get the previous capture. Blocks placed or broken by players, crop
growth and fire spread clear the affected sections right away. Other changes, such as terrain
edited by another plugin, show up after the next refresh.

Live push updates are off, but clients can sync cached terrain when they log in.

## Rebuild one wrong section

An empty cache entry can be terrain that really contains only air, so the plugin never removes
these entries on its own.

If a cached area looks wrong, stand in that world, load the area's 16 chunks and run
`/dhs cache recover <x> <z>` with block coordinates inside the section. When any chunk is missing,
the plugin defers the recovery and leaves the entry as it is. Otherwise it copies the entry to
`cache-recovery/` in its data folder, removes that one section from the cache and captures it
again. If the chunks unload before that capture finishes, the plugin doesn't store an empty section
in its place. The backups stay until you delete them.

Recovery changes only the server's cache. It doesn't touch the cache that the Distant Horizons mod
keeps on each client.

## Clear the cache

`/dhs cache clear` empties both caches. `/dhs cache memory clear` and `/dhs cache disk clear` empty
one of them.

After you replace a world or change its height, stop the server, delete the `cache/` folder and
start the server again. The plugin assumes vanilla world heights unless you set
`worlds."<world>".height`.
