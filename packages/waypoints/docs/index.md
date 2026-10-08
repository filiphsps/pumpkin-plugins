# Waypoints

Waypoints stores shared named positions on the server. Waypoints are restricted by default; an
operator can make one public or grant access to players, permission nodes, or permission-marker
groups. Records have no creator ownership.

Install `waypoints.wasm` in the Pumpkin server's `plugins/` directory and restart. The plugin has
no config file. It stores versioned records in `plugins/data/Waypoints/waypoints.json` and keeps a
byte-identical `waypoints.v1.json` backup when migrating the previous schema.

## Create and use waypoints

Operators can create a waypoint at their exact position with `/wp create "Home Base"`, or provide
absolute coordinates with `/wp create "Home Base" 120.5 64 -30`. Names are unique across dimensions.
Use `/wp list` to see enabled waypoints you can access, `/wp info <name>` for details, and
`/wp tp <name>` to teleport yourself. Operators can use `/wp tp <name> @a` to teleport a player selector.

Only server operators can create, edit, enable, disable, grant, or delete waypoints. Every
administrative handler checks Pumpkin's operator list even if a command permission was manually
granted. Player grants resolve online names and store UUIDs. A group grant checks the permission
marker `Waypoints:group.<slug>`; another permission provider must assign that marker to group
members.

## Java waypoint HUD

Minecraft Java 26.3 players see each enabled waypoint they can access in the same dimension and
within its optional visibility range. Private display packets keep restricted names and personalized
distances off other clients. Names reveal after a settled look and stay visible near the destination;
distant peripheral markers show just their distance and icon. Labels use the waypoint color, a
shadow, and a subtle backdrop independent of world lighting. Iconless waypoints use a colored diamond.

The HUD uses client-only TextDisplay entities along each waypoint's world direction. A smooth depth
curve approaches a maximum of 24 blocks from the player's eyes, reducing the apparent movement
caused by delayed position samples. Labels face the viewer and render through terrain. Camera rotation
does not move or replace them. Between sixteen and three blocks from a waypoint, the projection blends
into a world anchor two blocks above its stored Y coordinate. It never passes the destination during
the blend; within three blocks it stays at the anchor. The transition works in both directions.

Perspective sizing uses camera-forward depth to avoid enlarging labels at the screen edges, and
keeps their apparent size consistent through the approach at a fixed field of view. Labels are limited
to 32 characters on the HUD; `/wp info` retains the complete text. Distances use meters below one
kilometer and tenths of kilometers above it, with hysteresis to prevent rounding flicker. Text, icons,
and backdrop fade between two and 0.75 blocks from the destination, leaving the immediate view clear.

Waypoints stored in the same half-block grid cell get a stable vertical stack, ordered by identifier,
without camera-dependent rearrangement. Distinct waypoints along the same bearing may still overlap.
Steps and jumps receive strong elevation damping while steep vertical destinations respond faster.
Damping eases off near the world anchor. Position and scale updates interpolate over one client tick;
unchanged text is not resent for appearance-only updates.

This approximates a first-person HUD: network latency, client view bobbing, and third-person camera
offsets can still affect alignment. The server cannot read client FOV or reliably detect Java item-use
state, so spyglass and modded zoom enlarge the labels. Other Java protocol versions and Bedrock clients
do not receive the HUD. Icons use vanilla 26.3 atlas textures; block items use a representative model
texture, and custom item IDs require the corresponding `item/<path>` sprite in the client's resource pack.

Malformed or unsupported storage is preserved and disables writes. Fix the file before expecting
changes to persist.

See the [preview setup and test checklist](hud-preview.md) for building and trying the current HUD.
