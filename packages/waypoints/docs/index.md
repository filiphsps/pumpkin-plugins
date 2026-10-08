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
Use `/wp list` to see enabled waypoints you can access, `/wp info <name>` for details, and `/wp tp
<name>` to teleport yourself. Operators can use `/wp tp <name> @a` to teleport a player selector.

Only server operators can create, edit, enable, disable, grant, or delete waypoints. Every
administrative handler checks Pumpkin's operator list even if a command permission was manually
granted. Player grants resolve online names and store UUIDs. A group grant checks the permission
marker `Waypoints:group.<slug>`; another permission provider must assign that marker to group
members.

## Java waypoint HUD

Minecraft Java 26.3 players see each enabled waypoint they can access in the same dimension and
within its optional visibility range. The display shows the waypoint label (or name) in its color
and the rounded distance in meters. Each player's display packets are private to that player, so
restricted names and personalized distances are not sent to other clients.

The HUD uses client-only TextDisplay packets on a camera-relative plane about three blocks ahead,
updated once per server tick. Within ten blocks, each label eases into a world position two blocks
above its waypoint and stays anchored there within three blocks. Labels render through world
geometry so terrain does not hide them. Screen direction is eased to reduce movement jitter;
ordinary waypoints use stronger vertical stabilization, while destinations several blocks above or
below the player follow height changes faster. Small stationary camera-position and yaw changes are
also ignored. Other Java protocol versions and Bedrock clients do not receive the HUD. The stored
item icon is not displayed yet.

Malformed or unsupported storage is preserved and disables writes. Fix the file before expecting
changes to persist.
