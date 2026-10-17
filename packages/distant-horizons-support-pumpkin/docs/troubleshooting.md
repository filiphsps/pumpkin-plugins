# Troubleshooting

## The client disconnects or never opens a session

Check the plugin README for the supported Distant Horizons release and make sure the client is
running it. If the protocol versions differ, the plugin closes the session. Only Java Edition
players can open Distant Horizons sessions.

## Requests stay pending because terrain is unavailable

The plugin can read only chunks Pumpkin has loaded; it cannot load or generate them. If the requested
area isn't loaded and has no cached capture, the request stays pending while the plugin checks again
with increasing delays. Bring the area within range of a player or use a server chunk-loading tool.
The client can cancel a request it no longer needs, and each pending request uses space in the
configured queue. See the plugin README for the section size and capture requirements.

## A client sees old terrain

The plugin keeps serving a cached capture until it reaches its configured refresh age. It rebuilds
an expired capture in the background when the server has the terrain loaded; otherwise, the older
capture remains available. Block placement and breaking invalidate affected captures, while other
world changes are picked up on a later refresh. If you replace world data or change a dimension's
height, stop the server, remove this plugin's cache folder, and restart the server. The plugin README
lists commands for clearing either cache tier or both.

## Requests stay queued or progress is slow

Run `/dhs status` to see pending requests, queued responses and retained response bytes, DH packet
bytes sent, capture progress, completed and rejected requests, and the last rejection reason.
Requests for unavailable terrain retry with increasing delays. If the last rejection is `LOD request
limit reached`, the bounded request queue is full. Cached sections can still be delivered while a
forced capture pauses ordinary sampling.

The client's ETA includes time spent waiting since submission, so it doesn't measure network
throughput. A nonzero client bandwidth limit controls outgoing fragments: each waits until enough
byte credit is available, and the credit bucket can hold one full DH fragment message. A bandwidth
limit of zero means unlimited. When the client changes its configuration, generation and sync
settings are acknowledged independently. See the plugin README for current queue and transfer
settings; their defaults remain provisional until real-runtime measurements are complete.
