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
Its output includes worker ticks, pending work, capture progress, served and rejected requests, and
the last rejection reason. If work advances but cannot keep up, review the per-tick request and
transfer budgets in the generated [Configuration](../README.md#configuration) reference. Changes
take effect after a server restart.
