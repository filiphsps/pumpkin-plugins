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

“Here” means the viewer's exact current world key. Waypoints never scale or compare coordinates
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

| Token | Value |
| --- | --- |
| `%waypoints_count%` | Accessible enabled records across all worlds |
| `%waypoints_count_here%` | Accessible enabled records in the viewer's current world |
| `%waypoints_count_world:world%` | Accessible enabled records in the exact argument world |
| `%waypoints_public_count%` | Accessible public records across all worlds |
| `%waypoints_restricted_count%` | Accessible restricted records across all worlds |
| `%waypoints_visible_count%` | Same-world records eligible for HUD display range |
| `%waypoints_nearby_count:128%` | Accessible same-world records at 3D distance at most the radius, in blocks |
| `%waypoints_names%` | Accessible names across worlds, joined by `, ` |
| `%waypoints_names_here%` | Accessible same-world names, joined by `, ` |

Name lists sort by Waypoints' normalized, case-insensitive name key, then UUID. They are display
text, not escaped identifiers; waypoint names can contain commas. Disabled, denied and
hidden-by-ACL records do not affect counts, names, existence checks or rank positions. A known empty
name list resolves to an empty string.

## Waypoint fields

Substitute any field below in a closest, nearest or explicit UUID token. The same field rules apply
to all three families.

| Field | Value |
| --- | --- |
| `id` | Canonical lowercase UUID |
| `name` | Complete saved waypoint name |
| `label` | Saved display label, falling back to the name |
| `description` | Saved description, or an empty string |
| `world` | Exact saved world key |
| `color` | Canonical uppercase `#RRGGBB` |
| `icon` | Canonical item ID, or an empty string |
| `x`, `y`, `z` | Saved coordinates using locale-independent number formatting; negative zero is `0` |
| `distance` | Raw 3D distance in blocks, to one decimal, no suffix |
| `distance_horizontal` | X/Z distance in blocks, to one decimal, no suffix |
| `distance_formatted` | Rounded integer meters below 1000 blocks; otherwise one decimal kilometer |
| `delta_x`, `delta_y`, `delta_z` | Destination minus viewer coordinate, in blocks to one decimal |
| `bearing` | Horizontal compass bearing: north `0`, east `90`, south `180`, west `270`; one decimal |
| `direction` | `N`, `NE`, `E`, `SE`, `S`, `SW`, `W`, `NW`, `UP`, `DOWN` or `HERE` |
| `relative_direction` | `front`, `front_right`, `right`, `back_right`, `back`, `back_left`, `left`, `front_left`, `UP`, `DOWN` or `HERE` |

Compass sectors are 45 degrees wide; a boundary belongs to the clockwise sector. Relative direction
uses the viewer's Minecraft yaw convention, where yaw zero faces south. If horizontal displacement
is zero, bearing is a known empty string. Direction fields return `HERE` at the same position,
`UP` above and `DOWN` below.

## Token forms and arguments

```text
%waypoints_closest_<field>%
%waypoints_nearest_<field>:2%
%waypoints_waypoint_<field>:11111111-1111-4111-8111-111111111111%
%waypoints_closest_exists%
%waypoints_nearest_exists:2%
%waypoints_waypoint_exists:11111111-1111-4111-8111-111111111111%
```

Closest has no argument. Nearest requires a decimal integer rank from 1 through 100. UUID arguments
must use the canonical hyphenated UUID shape; letter case is normalized. Unknown, disabled and
inaccessible UUIDs all return `false` for `waypoint_exists` and leave metadata fields unresolved.

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
