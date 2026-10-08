# Terrain capture

`@pumpkin-plugins/terrain` provides terrain capture primitives and chunk-provider contracts without
depending on Pumpkin APIs or Minecraft wire formats. A plugin supplies adapters for loading world
data and for encoding the result.

## Incremental capture

`TerrainCapture` samples a rectangular region within a caller-provided work budget on each step.
It groups material runs into columns and can skip empty blocks above a configured height bound.
Incremental work lets a plugin spread capture over server ticks instead of scanning an entire area
at once.

`AdaptiveWorkBudget` adjusts the work limit using rolling server MSPT and measured capture cost,
while respecting the caller's ceiling. Use it when the workload should use spare tick time and
back off as the server becomes busy.

## Chunk access adapters

`ChunkLoader` and `TerrainGenerator` describe optional host capabilities. `acquireChunk` checks
loaded chunks, requests a saved chunk when available, and requests generation only when the saved
chunk is missing or loading is unavailable. Explicit unavailable providers let platforms expose
their limits without pretending those operations succeeded.

The package does not load or generate chunks itself; its caller supplies the providers and decides
how captured columns are stored or sent to clients.
