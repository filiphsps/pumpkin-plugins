# Waypoints

Waypoints stores shared named locations on the server. Each waypoint can have a display label,
description, color, item icon, and optional HUD visibility range. Waypoints are restricted by
default; operators can make them public or grant access to specific players, permission nodes, or
permission-marker groups. Players can find and teleport to enabled waypoints they can access. Records
have no creator ownership.

Optional PumpkinPIE placeholders expose live, access-filtered waypoint data. See the [placeholder guide](placeholders.md) for the complete contract.

Install `waypoints.wasm` in the Pumpkin server's `plugins/` directory and restart. The plugin has
no config file. It stores versioned records in `plugins/data/Waypoints/waypoints.json`. A v1
migration copies `locatorBar.color` to the waypoint's v2 `color`. The Java adapter's
`locatorBar.enabled` value did not control the whole waypoint, so it does not set v2 `enabled`, which
defaults to `true`. V2 has no matching style or platform-adapter fields for Java `javaStyleId` or
Bedrock `bedrockTexture`. The byte-identical `waypoints.v1.json` backup preserves all original v1
settings.

## Create and use waypoints

Admins can create a waypoint at their exact position with `/wp create "Home Base"`, or provide
absolute coordinates with `/wp create "Home Base" 120.5 64 -30`. X and Z must be within 30,000,000
blocks of the origin and Y within 20,000,000, the limits of vanilla `/tp`. Names are unique across
all dimensions.
Use `/wp list` to see enabled waypoints you can access, `/wp info <name>` for details, and
`/wp tp <name>` to teleport yourself. Admins can use `/wp tp <name> @a` to teleport a player selector.

Creating, editing, enabling, disabling, granting, and deleting waypoints needs the
`Waypoints:command.admin` permission. It defaults to operator level 3, and a permissions plugin can
grant it to other players. Server operators can see and teleport to every enabled waypoint,
regardless of its access rules.

The server console and RCON hold every permission, so they can run the admin commands too. The
exceptions are `/wp create` and `/wp relocate`, which use the sender's position or world and need a
player. Over RCON, `/wp set icon` fails because Pumpkin doesn't pass the item to the plugin.

Player grants resolve online names and store UUIDs. To revoke the grant of an offline player, pass
the UUID that `/wp access list` shows. A group grant checks the permission
marker `Waypoints:group.<slug>`; another permission provider must assign that marker to group
members.

## Java waypoint HUD

Only Java clients whose reported version exactly matches the gate below receive HUD updates:

<!-- docs:begin java-display-version -->
<!-- Generated from src/rendering/java-version.ts. Run `pnpm readme`. -->

Required Java version: `v-26-3`.
<!-- docs:end java-display-version -->

Players see each enabled waypoint they can access in the same dimension and within the optional
visibility range. Private display packets keep restricted names and personalized distances off other
clients. Names reveal after a settled look and stay visible near the destination; distant peripheral
markers show just their distance and icon. Labels use the waypoint color, a shadow, and a subtle
backdrop independent of world lighting. Iconless waypoints use a colored diamond.

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
state, so spyglass and modded zoom enlarge the labels. Other Java protocol versions do not receive the
HUD; the server log notes each such player once per session.
This HUD supports Java clients only. Waypoints does not currently render Bedrock HUDs.
Icons use vanilla atlas textures; block items use a representative model texture, and custom item IDs
require the corresponding `item/<path>` sprite in the client's resource pack. The map of block item
sprites comes from a Minecraft client JAR; after a Minecraft update, regenerate it with
`pnpm --filter @pumpkin-plugins/waypoints icons <client.jar>`.

Malformed or unsupported storage is preserved and disables writes. Fix the file before expecting
changes to persist.
