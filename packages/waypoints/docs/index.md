# Waypoints

Waypoints stores named block positions on the server and lets players share them with public or
allowlist access. Java players can also show accessible waypoints in the vanilla Locator Bar.

Install `waypoints.wasm` in the Pumpkin server's `plugins/` directory and restart. Waypoints are
private by default. The plugin has no config file; it stores versioned records in
`plugins/data/Waypoints/waypoints.json`.

## Create and find a waypoint

Use `/wp mark "Home Base"` to save your current block, or `/wp add "Home Base" 120 64 -30` to
save coordinates. `/wp list` lists waypoints in the current dimension; `/wp list all` includes
other dimensions. Use the UUID shown in the output for operations such as `/wp show <id>` and
`/wp remove <id>`.

## Share access

Owners can keep a waypoint private, make it public, or switch it to allowlist access. Invite and
revoke online players by name; access records store their player UUIDs. Players can only inspect or
send waypoints they are allowed to access. Operators have separate admin commands to list or
remove any saved waypoint.

## Locator and map clients

Locator output is opt-in for each waypoint. It is sent only to Java players who can access the
waypoint and are in its dimension. Bedrock Locator Bar output is unsupported by the pinned Pumpkin
API. The registered `xaero-share` adapter currently reports unavailable, so send commands return
readable coordinates and do not claim client import or automatic map synchronization.

The store is preserved and writes stop if its JSON is malformed or uses an unsupported schema; fix
the file before expecting changes to persist.
