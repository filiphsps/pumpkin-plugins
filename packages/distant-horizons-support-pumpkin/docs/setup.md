# Install and connect

## Check client compatibility

Before installing, check the plugin README for the supported Distant Horizons release and protocol.
That README is generated from the plugin's compatibility metadata. Install the client mod separately
on each Java Edition client. Bedrock players do not establish Distant Horizons sessions.

## Install the server plugin

1. Download the latest Distant Horizons Support plugin release.
2. Put `distant-horizons-support-pumpkin.wasm` in the Pumpkin server's `plugins/` folder.
3. Start or restart the server. The first load asks for the data-folder permissions listed in the
   generated plugin README. Approve them from the server console; a hot reload cannot show the
   permission prompt.
4. Connect with a compatible Java client. The plugin creates its settings file in its data folder
   on first load.

The plugin README describes the current options, defaults and example config; these are generated
from the configuration schema. Changes apply after a server restart. The plugin serves terrain that
Pumpkin has already loaded or that the plugin has captured and cached before. Shared loading and
generation provider interfaces are in place, but Pumpkin's current adapter reports those operations
as unavailable.

The server negotiates generation and sync request limits independently and acknowledges client
configuration updates. A nonzero client bandwidth setting limits outgoing server transfers; its
credit bucket holds at most one full DH fragment message. Zero is unlimited. The generated README
documents the current bounded queues and their provisional defaults.

Use the plugin's status and cache commands to check connected clients and cache usage after
connecting.
