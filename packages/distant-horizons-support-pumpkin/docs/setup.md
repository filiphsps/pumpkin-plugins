# Install and connect

## Check client compatibility

Before installing, check the generated [Compatibility and terrain](../README.md#compatibility-and-terrain)
reference for the supported Distant Horizons release and protocol. Install that client mod separately
on each Java Edition client. Bedrock players do not establish Distant Horizons sessions.

## Install the server plugin

1. Download the latest
   [Distant Horizons support release](https://github.com/filiphsps/pumpkin-plugins/releases).
2. Put `distant-horizons-support-pumpkin.wasm` in the Pumpkin server's `plugins/` folder.
3. Start or restart the server. The first load asks for the data-folder permissions listed in the
   generated [Permissions](../README.md#permissions) reference. Approve them from the server
   console; a hot reload cannot show the permission prompt.
4. Connect with a compatible Java client. The plugin creates its settings file in its data folder
   on first load.

The [generated Configuration](../README.md#configuration) reference shows the current options,
defaults and example file. Changes apply after a server restart. The plugin serves terrain that
Pumpkin has already loaded or that the plugin has captured and cached before. Shared loading and
generation provider interfaces are in place, but Pumpkin's current adapter reports those operations
as unavailable.

Use the generated [Commands](../README.md#commands) reference to check connected clients and cache
usage after connecting.
