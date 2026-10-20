# PumpkinPIE placeholders

Waypoints optionally registers the `waypoints` namespace with [PumpkinPIE](https://github.com/Rennex07/PumpkinPIE).
Install a compatible PumpkinPIE provider beside Waypoints to make these values available to other
plugins. Without the provider, Waypoints still loads and its commands and Java HUD continue to work.
The placeholders are server-side and do not depend on the viewer's Java or Bedrock edition or on a
HUD being enabled.

Every lookup requires an online viewer resolved by the provider's current player **name**. UUIDs,
name prefixes, console defaults and viewerless global queries are not accepted. Missing or offline
viewers leave every Waypoints token unresolved, including public counts. The consuming server plugin
supplies the viewer name; it is context for access checks, not end-user authentication. Treat this as
trusted server-plugin integration, not as proof of who will see a message.

## Access and selection

An accessible waypoint is enabled and passes Waypoints' current access rules for the viewer. Public
records are accessible to everyone; restricted records require a matching player UUID, permission
node or `Waypoints:group.<slug>` marker. Operators bypass those grants, but disabled waypoints remain
excluded. ACL changes, permission changes, movement and catalog edits affect the next lookup; the
namespace uses no value cache.

“Here” means the viewer's exact current world key. Waypoints does not scale or compare coordinates
between dimensions. Closest and nearest use accessible waypoints in that same world, regardless of
HUD visibility range. Visible means eligible for the existing HUD projection: enabled, accessible,
same world and inside the waypoint's optional 3D visibility range. It does not mean that a client
currently sees a marker on screen; focus, fade, display edition and client state are not considered.
Counts and lists only include records accessible to the supplied viewer. Waypoints does not publish a
private-by-default raw total or aggregate hidden records.

Closest uses raw 3D distance. Nearest ranks use raw 3D distance before formatting and break exact
ties by lowercase waypoint UUID in lexical order. Explicit UUID lookups can return authorized
metadata from another world, but cross-world distances and directions are unresolved.

## Catalog values

<!-- docs:begin catalog -->
<!-- Generated from src/placeholders/definitions.ts and the PumpkinPIE session timing constants. Run `pnpm readme`. -->

| Token | Description |
| --- | --- |
| `%waypoints_count%` | Accessible enabled waypoint count across all worlds. |
| `%waypoints_count_here%` | Accessible enabled waypoint count in the current world. |
| `%waypoints_count_world:world%` | Accessible enabled waypoint count in the exact argument world. |
| `%waypoints_public_count%` | Accessible public-record count across all worlds. |
| `%waypoints_restricted_count%` | Accessible restricted-record count across all worlds. |
| `%waypoints_visible_count%` | Same-world count eligible for the HUD visibility range. |
| `%waypoints_nearby_count:128%` | Same-world count within the 3D radius in blocks. |
| `%waypoints_names%` | Accessible waypoint names across worlds, joined by comma and space. |
| `%waypoints_names_here%` | Accessible same-world waypoint names, joined by comma and space. |
<!-- docs:end catalog -->

Name lists sort by Waypoints' normalized, case-insensitive name key, then UUID. They are display
text, not escaped identifiers; waypoint names can contain commas. Disabled, denied and
hidden-by-ACL records do not affect counts, names, existence checks or rank positions. A known empty
name list resolves to an empty string.

## Existence lookups

<!-- docs:begin exists -->
<!-- Generated from src/placeholders/definitions.ts and the PumpkinPIE session timing constants. Run `pnpm readme`. -->

| Token | Description |
| --- | --- |
| `%waypoints_closest_exists%` | Whether an accessible same-world closest waypoint exists. |
| `%waypoints_nearest_exists:2%` | Whether the requested accessible same-world rank exists. |
| `%waypoints_waypoint_exists:11111111-1111-4111-8111-111111111111%` | Whether the enabled UUID is accessible to the viewer. |
<!-- docs:end exists -->

## Waypoint fields

Substitute any field below in a closest, nearest or explicit UUID token. The same field rules apply
to all three families.

<!-- docs:begin fields -->
<!-- Generated from src/placeholders/definitions.ts and the PumpkinPIE session timing constants. Run `pnpm readme`. -->

| Field | Meaning | Output |
| --- | --- | --- |
| `id` | Canonical waypoint UUID. | canonical lowercase UUID |
| `name` | Complete saved waypoint name. | text |
| `label` | Saved display label, falling back to the name. | text |
| `description` | Saved description, or an empty string. | text |
| `world` | Exact saved world key. | text |
| `color` | Canonical waypoint color. | uppercase #RRGGBB |
| `icon` | Canonical item ID, or an empty string. | item ID or empty |
| `x` | Saved X coordinate. | locale-independent number; negative zero is 0 |
| `y` | Saved Y coordinate. | locale-independent number; negative zero is 0 |
| `z` | Saved Z coordinate. | locale-independent number; negative zero is 0 |
| `distance` | Raw three-dimensional distance. | blocks to one decimal, no suffix |
| `distance_horizontal` | Raw X/Z distance. | blocks to one decimal, no suffix |
| `distance_formatted` | Human-readable distance. | whole meters while it rounds below 1000; otherwise kilometers to one decimal |
| `delta_x` | Destination X minus viewer X. | blocks to one decimal |
| `delta_y` | Destination Y minus viewer Y. | blocks to one decimal |
| `delta_z` | Destination Z minus viewer Z. | blocks to one decimal |
| `bearing` | Horizontal compass bearing, north at zero. | degrees to one decimal |
| `direction` | Eight-point compass direction. | N, NE, E, SE, S, SW, W, NW, UP, DOWN, or HERE |
| `relative_direction` | Eight-point direction relative to the viewer yaw. | front, front_right, right, back_right, back, back_left, left, front_left, UP, DOWN, or HERE |
<!-- docs:end fields -->

Compass sectors are 45 degrees wide; a boundary belongs to the clockwise sector. Relative direction
uses the viewer's Minecraft yaw convention, where yaw zero faces south. If horizontal displacement
is zero, bearing is a known empty string. Direction fields return `HERE` at the same position,
`UP` above and `DOWN` below.

## Token forms and arguments

```text
%waypoints_closest_id%
%waypoints_nearest_id:2%
%waypoints_waypoint_id:11111111-1111-4111-8111-111111111111%
%waypoints_closest_exists%
%waypoints_nearest_exists:2%
%waypoints_waypoint_exists:11111111-1111-4111-8111-111111111111%
%waypoints_count_world:world%
%waypoints_nearby_count:128%
```

Closest has no argument. Nearest requires a decimal integer rank from 1 through 100. UUID arguments
must use the canonical hyphenated UUID shape; letter case is normalized. Unknown, disabled and
inaccessible UUIDs all return `false` for `waypoint_exists`; metadata fields remain unresolved.

Catalog arguments:

- `count_world` requires an exact, nonempty world key of at most 128 UTF-8 bytes.
- `nearby_count` requires a plain decimal radius greater than zero and at most 30,000,000 blocks.
  Exponent, hexadecimal, `Infinity` and `NaN` forms are rejected.
- `nearest_*` and `nearest_exists` require ranks from 1 through 100.
- `waypoint_*` and `waypoint_exists` require a canonical UUID.
- All other tokens reject arguments.

The PIE token grammar cannot represent every possible world key. For those keys, pass the world key
as the separate API argument rather than embedding it in token text:

```ts
import { PieClient } from '@pumpkin-plugins/pumpkin-pie-api';
import { ipcSend } from '@pumpkin-plugins/plugin-kit/ipc';

const pie = new PieClient(ipcSend);
pie.ping();
const count = pie.getValue('waypoints_count_world', 'Alex', 'custom world key');
const line = pie.resolve('Waypoints here: %waypoints_count_world%', 'Alex', 'world');
```

`getValue` preserves the distinction between `{ known: false }` and `{ known: true, value: '' }`.
`resolve` and `resolveBatch` retain unresolved tokens in returned text and list their identifiers in
`unresolved`. The caller sends resolved text through its own existing Pumpkin messaging API;
PumpkinPIE resolves placeholders but does not deliver chat or UI messages.

## Empty, unresolved and failed values

Zero counts and distances are known values (`0` and `0.0`). A missing closest or valid nearest rank
returns known empty strings for fields and `false` for existence checks. Missing optional description
and icon metadata are known empty strings. Invalid arguments, unknown tokens, inaccessible or
disabled explicit UUIDs, cross-world geometry, missing/offline viewers and values over 32 KiB UTF-8
remain unresolved. Storage and host-query failures also decline the value instead of returning a
misleading zero or partial result.

The callback returns plain text only. It does not resolve nested tokens, escape markup, build text
components or truncate oversized names. Waypoints logs a bounded identifier and reason once while a
query failure remains active; stored waypoint text and host errors are never logged.

<!-- docs:begin timing -->
<!-- Generated from src/placeholders/definitions.ts and the PumpkinPIE session timing constants. Run `pnpm readme`. -->

PumpkinPIE is optional. Provider retries use bounded exponential backoff capped at 5 minutes;
after reaching the cap, probes are no more frequent than once every 5 minutes. A ready
integration sends its registration heartbeat every 30 seconds and recovers automatically when
PumpkinPIE becomes available.
<!-- docs:end timing -->
