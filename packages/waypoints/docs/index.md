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
within its optional visibility range. The display shows the waypoint label (or name) in its color
and the rounded distance in meters, with its configured item sprite centered on a line below.
Each player's display packets are private to that player, so
restricted names and personalized distances are not sent to other clients.

The HUD uses client-only TextDisplay entities up to eight blocks from the player's eyes along each
waypoint's world direction. The farther projection reduces the apparent movement caused by delayed
position samples. Labels face the viewer and render through terrain. Camera rotation does not move
or replace them. Between ten and three blocks from a waypoint, the projection blends into a world
anchor two blocks above its stored Y coordinate. It never passes the destination during the blend;
within three blocks it stays at the anchor. The transition works in both directions.

Text and icons keep a consistent apparent size throughout the transition, including close approach.
Waypoints stored in the same half-block grid cell get a stable vertical stack, ordered by identifier,
without camera-dependent rearrangement. Distinct waypoints along the same bearing may still overlap.

Steps and jumps receive strong elevation damping while steep vertical destinations respond faster.
Damping eases off near the world anchor. Position and scale updates interpolate over one client tick;
unchanged text is not resent for scale-only updates. This approximates a first-person HUD: network
latency, client view bobbing, and third-person camera offsets can still affect alignment. Other Java
protocol versions and Bedrock clients do not receive the HUD. Icons use vanilla 26.3 atlas textures;
block items use a representative model texture, and custom item IDs require the corresponding
`item/<path>` sprite in the client's resource pack.

Malformed or unsupported storage is preserved and disables writes. Fix the file before expecting
changes to persist.
