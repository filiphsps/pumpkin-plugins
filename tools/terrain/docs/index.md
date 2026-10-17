# Terrain capture

`@pumpkin-plugins/terrain` provides reusable terrain capture and chunk-access contracts. It does
not depend on Pumpkin APIs or Minecraft wire formats, so your plugin can connect it to its own world
data and encode the captured result for its needs.

## Incremental capture

Create a `TerrainCapture` for a rectangular region, then call `step(source, budget)` until it returns
`true`. Each call samples at most `budget` blocks from the region, working from the top of each
column downward. Adjacent blocks with the same material and light values are stored as one segment,
so the result contains a material table and a segment list for each column. You can also set a
maximum segment count to bound the result size.

If your source provides a column height with `top()` and you identify empty materials with
`isEmpty`, capture can skip empty blocks above that height. Because each step has a block budget, a
plugin can spread a large capture across server ticks instead of sampling the whole region at once.

`AdaptiveWorkBudget` chooses a work limit from recent server MSPT and the measured time per work
unit. Call `observe()` after each step to update its cost estimate, and pass your configured maximum
to `next()`; the returned limit will not exceed it. The budget leaves a configurable portion of the
tick for the server and other plugins, making it useful for incremental work that should slow down
when the server is busy.

## Chunk access adapters

`ChunkLoader` and `TerrainGenerator` describe optional host capabilities. `acquireChunk` first checks
for an already-loaded chunk, then asks the loader to load a saved chunk. It requests generation when
loading reports that the chunk is missing or loading is unavailable. A provider may report that an
operation is pending, unavailable, or failed, so your caller can decide how to handle each outcome.
The exported unavailable providers let a platform expose unsupported operations explicitly.

These helpers do not choose a platform's world-data adapter or an output format. Your plugin supplies
the providers and source, then decides how to store the captured columns or send them to clients.
