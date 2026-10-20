# Troubleshooting

## The client disconnects or never opens a session

Check the plugin README for the supported Distant Horizons release and make sure the client is
running it. If the protocol versions differ, the plugin closes the session and logs a warning with
the client's and the server's protocol numbers. Only Java Edition players can open Distant Horizons
sessions.

Worlds in a custom dimension need a height in the plugin config. Without one, the plugin closes DH
sessions in that world and logs the `[worlds."<world>"]` key to add once per world.

## Requests stay pending because terrain is unavailable

The plugin can read only chunks Pumpkin has loaded; it cannot load or generate them. If the requested
area isn't loaded and has no cached capture, the request stays pending while the plugin checks again
with increasing delays. Bring the area within range of a player or use a server chunk-loading tool.
The client can cancel a request it no longer needs, and each pending request uses space in the
configured queue. See the plugin README for the section size and capture requirements.

## A client sees old terrain

The plugin keeps serving a cached capture until it reaches its configured refresh age. It rebuilds
an expired capture in the background when the server has the terrain loaded; otherwise, the older
capture remains available. Blocks placed or broken by players, crop growth and fire spread clear
the affected captures right away. Other changes can show up only after a later refresh. To rebuild
one wrong section now, use `/dhs cache recover <x> <z>` as described in
[Manage the LOD cache](cache.md#rebuild-one-wrong-section).

If you replace world data or change a dimension's height, stop the server, remove this plugin's
`cache/` folder, and restart the server.

## Requests stay queued or progress is slow

Run `/dhs status` to see worker ticks, capture progress, the capture budget, Pumpkin's reported
MSPT, queued responses and their bytes, DH packet bytes sent, and the served, rejected and
cancelled request counts. The counts start at zero when the plugin loads.

- If worker ticks stay at zero, the plugin's tick handler isn't running. Check the server log for
  plugin errors.
- If worker ticks and capture progress keep rising, the plugin is working through the queue. The
  client can keep adding requests while it does.
- If rejections rise with `Chunk ... is not loaded`, the requested terrain is still unavailable.
  See [Requests stay pending because terrain is unavailable](#requests-stay-pending-because-terrain-is-unavailable).
- If the last rejection is `LOD request limit reached`, the request queue is full. It drains as
  captures finish, or you can raise `pending_requests`.
- If cancellations rise, the client is dropping requests it no longer needs.

The capture budget shrinks as the server gets busier and drops to zero when Pumpkin reports 45
MSPT or more. Cached sections still go out while sampling is paused, including during a forced
capture. On the pinned Pumpkin release, the reported MSPT doesn't include this plugin's own tick
handler, so `/dhs status` also shows how long that handler took last tick.

The client's ETA counts time since the request was sent, including time in the queue, so it doesn't
measure network speed. A nonzero client bandwidth limit paces outgoing fragments, and zero means
unlimited. The defaults for the queue and transfer settings in the plugin README are provisional
until they have been measured on real servers.
