# Set up Bedrock packs

## Install and scan packs

1. Put `bedrock-addon-manager.wasm` in the Pumpkin server's `plugins/` directory.
2. Start or restart the server and grant the requested data-folder and TCP-listener permissions in
   the server console.
3. Copy `.mcpack` or `.mcaddon` files into `plugins/data/BedrockAddonManager/packs/`.
4. Run `/baddon reload`, then `/baddon list` to inspect the packs and their effective settings.

The folder is scanned at startup and on `/baddon reload`; new files are not detected automatically.
The plugin creates and updates its own `config.toml` in its data folder. Changes apply after a
reload or restart.

## Choose a download address

The plugin listens on the configured `web.bind` address and `web.port` (default `0.0.0.0:8123`).
Bedrock clients need an address they can reach:

- Set `web.public_url` to the public base URL when a reverse proxy or external host serves the
  files. Do not add a trailing slash. The plugin's built-in server is plain HTTP; terminate HTTPS at
  the proxy.
- Leave `web.public_url` empty to use UPnPumpkin port forwarding when `web.bind` is `0.0.0.0` and
  `web.port_forwarding` is enabled. This only works when the network permits router mapping and
  the host is not behind carrier-grade NAT.
- Set `web.port_forwarding = false` when forwarding is managed manually.
- If packs are hosted elsewhere, set `web.enabled = false` and provide a `download_url` override
  for every enabled pack.

If forwarding is unavailable and no public URL is configured, the fallback address is loopback and
only works for clients on the server machine.

## `.mcaddon` bundles and overrides

The plugin extracts resource packs from bundles into `packs/.extracted/`. Behavior packs are left
out. A single extracted pack is named after the `.mcaddon` file; multiple packs include the pack
name. Use the exact effective filename shown by `/baddon list` as the key under `overrides`.

Overrides can change order, disable a pack, replace its download URL, or provide manifest values
such as `content_key` and `content_id`. Packs sort by `order`, then filename. The server's
`pumpkin.toml` is not edited.
