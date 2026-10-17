# Set up Bedrock packs

## Install and scan packs

1. Put `bedrock-addon-manager.wasm` in the Pumpkin server's `plugins/` directory.
2. Start or restart the server. When prompted, grant `fs.read.data`, `fs.write.data`, and
   `network.tcp.bind` so the plugin can read packs, create its config and extracted files, and serve
   downloads.
3. Copy `.mcpack` or `.mcaddon` files into `plugins/data/BedrockAddonManager/packs/`.
4. Run `/baddon reload`, then `/baddon list` to inspect the packs and their effective settings.

BedrockAddonManager scans the folder at startup and whenever you run `/baddon reload`, so it won't
pick up new files automatically. It creates and updates its own `config.toml` in the data folder;
configuration changes take effect after a reload or server restart.

## Choose a download address

The built-in server listens on `web.bind` and `web.port` (default `0.0.0.0:8123`). Choose a URL that
Bedrock clients can reach:

- If a reverse proxy or external host serves the files, set `web.public_url` to the base URL clients
  should use. Don't add a trailing slash. The built-in server uses plain HTTP, so terminate HTTPS at
  the proxy.
- To use UPnPumpkin port forwarding, leave `web.public_url` empty, keep `web.bind` at `0.0.0.0`,
  and enable `web.port_forwarding`. This requires a router that allows port mapping; it won't work
  behind carrier-grade NAT.
- Set `web.port_forwarding = false` when forwarding is managed manually.
- If packs are hosted elsewhere, set `web.enabled = false` and provide a `download_url` override
  for every enabled pack.

If forwarding doesn't succeed and you haven't set a public URL, the plugin gives clients a loopback
address. That address works only on the server machine.

## `.mcaddon` bundles and overrides

The plugin extracts resource packs from bundles into `packs/.extracted/` and leaves behavior packs
out. When a bundle contains one resource pack, its extracted filename follows the bundle name; if
it contains several, each filename also includes the pack name. Use the exact effective filename
shown by `/baddon list` as the key under `overrides`.

You can use `overrides` to change pack order, disable a pack, provide a different download URL, or
set manifest values such as `content_key` and `content_id`. Packs are ordered by `order`, then by
filename. The plugin doesn't edit the server's `pumpkin.toml`.
