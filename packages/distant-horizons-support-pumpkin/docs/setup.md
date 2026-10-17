# Install and connect

## Check client compatibility

Before you install the server plugin, check its README for the supported Distant Horizons release
and protocol. Install the Distant Horizons mod on each Java Edition client that will connect;
Bedrock players can't establish Distant Horizons sessions.

## Install the server plugin

1. Download the latest Distant Horizons Support release.
2. Copy `distant-horizons-support-pumpkin.wasm` into the Pumpkin server's `plugins/` folder.
3. Start or restart the server. On first load, the plugin requests the data-folder permissions
   listed in its README. Approve the request in the server console; hot reload can't display this
   prompt.
4. Connect with a compatible Java client. On first load, the plugin creates its settings file in
   its data folder.

The plugin README lists the available options, their defaults, and an example configuration.
Settings changes take effect after a server restart. Distant Horizons Support can serve terrain
from chunks Pumpkin has loaded, along with terrain it captured earlier and cached. It can't load or
generate distant chunks: the shared provider interfaces exist, but Pumpkin's current adapter marks
both operations as unavailable.

The server negotiates generation and sync request limits separately, and acknowledges client
configuration updates. A nonzero client bandwidth setting limits outgoing transfers from the
server. Its credit bucket can hold up to one full DH fragment message; zero means unlimited.

After connecting, use the plugin's status and cache commands to check which clients are connected
and how much cache is in use.

PumpkinPIE is optional. Distant Horizons Support loads without it and reconnects automatically if
PumpkinPIE becomes available later. The `dhs` expansion gives PumpkinPIE consumers access to
session and cache values, without adding a required host plugin dependency. See the
[placeholder reference](placeholders.md) for identifiers, values, and retry behavior.
