# Troubleshooting

## The client disconnects or never opens a session

Confirm the client uses the supported Distant Horizons release listed in the plugin README. A
protocol mismatch closes the session. Distant Horizons sessions are only opened by Java Edition
players.

## Requests stay pending because terrain is unavailable

The plugin cannot load or generate chunks. It needs Pumpkin to have the requested area loaded, or a
previous capture available in its cache. Unavailable requests stay pending, and the plugin spaces
availability checks with exponential backoff. Bring the area into range of a player or arrange for
the server to load it; the client can cancel a request that is no longer needed. Pending requests
count against the configured queue limit. The plugin README lists the current section size and
capture requirements.

## A client sees old terrain

Cached captures are reused until they reach their configured refresh age and the server has the
terrain loaded to rebuild them. Block placement and breaking invalidate affected captures. After
replacing world data or changing a dimension's height, stop the server and remove this plugin's cache
folder, then start the server again. The plugin README lists the current commands for clearing
either cache tier or both.

## Requests stay queued or progress is slow

Check the plugin's status command. Its output includes pending requests and responses, logical
queued response bytes retained, DH packet bytes sent,
capture progress, completed and rejected requests, and the last rejection reason. Pending requests
for unavailable terrain retry with exponential backoff; `LOD request limit reached` means the
bounded queue is full. Cached sections can still be delivered while a forced capture or sampling
pause is active.

The client ETA includes time waiting since submission and does not measure network throughput. A
nonzero client bandwidth limit applies to outgoing fragments; a fragment waits until its byte credit
is available. The bucket burst is capped at one full DH fragment message; zero bandwidth is
unlimited. Client configuration changes receive negotiated acknowledgements, with generation and
sync settings handled independently. The plugin README lists the current queue and transfer
settings. Those defaults remain provisional pending real-runtime measurements.
