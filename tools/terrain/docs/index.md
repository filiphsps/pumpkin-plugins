# Terrain capture

`@pumpkin-plugins/terrain` provides reusable terrain capture and host access contracts. It does
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
unit. Call `observe()` after each step with the blocks it sampled to update its cost estimate;
`TerrainCapture.samples()` returns the running total, so the difference across a step is that
count. Pass your configured maximum to `next()`; the returned limit will not exceed it. The budget
leaves a configurable portion of the tick for the server and other plugins, making it useful for
incremental work that should slow down when the server is busy.

## Region readiness

`TerrainAccess` adds an optional `prepare(region)` check to a source. Your host adapter returns
`ready` when the region can be sampled, `pending` to try again later, or `unavailable` with a reason,
so your caller can defer a capture instead of sampling missing terrain.

These helpers do not choose a platform's world-data adapter or an output format. Your plugin supplies
the source, then decides how to store the captured columns or send them to clients.
