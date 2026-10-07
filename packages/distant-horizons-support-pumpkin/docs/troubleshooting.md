# Troubleshooting

## The client disconnects or never opens a session

Confirm the client uses the supported Distant Horizons release in the generated
[compatibility reference](../README.md#compatibility-and-terrain). A protocol mismatch closes the
session. Distant Horizons sessions are only opened by Java Edition players.

## Requests are rejected because terrain is unavailable

The plugin cannot load or generate chunks. It needs Pumpkin to have the requested area loaded, or a
previous capture available in its cache. If the server reports that a chunk is not loaded, bring the
area into range of a player or arrange for the server to load it before the request. The generated
[terrain reference](../README.md#compatibility-and-terrain) describes the section size and capture
requirements.

## A client sees old terrain

Cached captures are reused until they reach their configured refresh age and the server has the
terrain loaded to rebuild them. Block placement and breaking invalidate affected captures. After
replacing world data or changing a dimension's height, stop the server and remove this plugin's cache
folder, then start the server again. The generated [Commands](../README.md#commands) reference also
lists commands for clearing either cache tier or both.

## Requests stay queued or progress is slow

Check the plugin's status command from the generated [Commands](../README.md#commands) reference.
Its output includes pending requests and responses, logical queued response bytes retained, DH packet bytes sent,
capture progress, completed and rejected requests, and the last rejection reason. `Chunk ... is not
loaded` means terrain is unavailable to capture; `LOD request limit reached` means the bounded
queue is full. Cached sections can still be delivered while a forced capture or sampling pause is
active.

The client ETA includes time waiting since submission and does not measure network throughput. A
nonzero client bandwidth limit applies to outgoing fragments; a fragment waits until its byte credit
is available. The bucket burst is capped at one full DH fragment message; zero bandwidth is
unlimited. Client configuration changes receive negotiated acknowledgements, with generation and
sync settings handled independently. Review the current queue and transfer settings in the generated
[Configuration](../README.md#configuration) reference. Those defaults remain provisional pending
real-runtime measurements.
