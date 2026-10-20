# Install and connect

## Check client compatibility

Before you install the server plugin, check its README for the supported Distant Horizons release
and protocol. Install the Distant Horizons mod on each Java Edition client that will connect;
Bedrock players can't establish Distant Horizons sessions.

## Install the server plugin

1. Download the latest Distant Horizons Support release.
2. Copy `distant-horizons-support-pumpkin.wasm` into the Pumpkin server's `plugins/` folder.
3. Start or restart the server. On first load, the plugin requests the permissions listed in its
   README. Approve the request in the server console; hot reload can't display this prompt.
4. Once the plugin loads, it writes its settings file to
   `plugins/data/DistantHorizonsSupportPumpkin/config.toml`. Change the settings there if needed
   and restart the server.
5. Connect with a compatible Java client.

The plugin README lists the available options, their defaults, and an example configuration.
Distant Horizons Support serves terrain from chunks Pumpkin has loaded, along with terrain it
captured earlier and cached. It can't load or generate distant chunks, so players see LODs for an
area only after it has been loaded once. To prepare an area in advance, see
[Manage the LOD cache](cache.md#capture-an-area-ahead-of-time).

After connecting, run `/dhs status` to check that the client has a session, and `/dhs cache status`
to see how much of the cache is in use.

PumpkinPIE is optional. Distant Horizons Support loads without it and reconnects automatically if
PumpkinPIE becomes available later. The `dhs` expansion gives PumpkinPIE consumers access to
session and cache values, without adding a required host plugin dependency. See the
[placeholder reference](placeholders.md) for identifiers, values, and retry behavior.
