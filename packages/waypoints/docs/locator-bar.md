# Java Locator Bar markers

New waypoints do not appear in the Locator Bar until their owner enables output. Use
`/wp locator on <id>` to enable it and `/wp locator off <id>` to remove it. The plugin sends a
marker only to Java players who can access the waypoint and are currently in the same dimension.

Set a marker tint with `/wp locator color <id> #RRGGBB`; use `reset` to clear the custom color.
An optional Java waypoint-style resource ID can be set with `/wp locator java-style <id>
<namespace:path>`, and cleared with `reset`. Custom styles require a client resource pack that
contains the matching waypoint-style assets.

Markers are removed when the waypoint is disabled or removed, the player changes dimension, or
their access is revoked. The client can also hide Locator Bar markers through its settings, and
server rules may disable the feature.

The plugin targets the pinned Pumpkin API release and has not manually verified vanilla client
behavior for custom colors or resource-pack styles. Bedrock output is unsupported because the API
does not expose a Bedrock waypoint packet or Locator Bar scripting interface.
