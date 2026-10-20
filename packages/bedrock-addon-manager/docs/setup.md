# Set up Bedrock packs

## Install and scan packs

1. Put `bedrock-addon-manager.wasm` in the Pumpkin server's `plugins/` directory.
2. Start or restart the server. When prompted, grant the permissions it asks for: `fs.read.data`,
   `fs.write.data`, `network.tcp.bind` and `http.outbound`, so it can read packs, create its config
   and extracted files, serve downloads and check for plugin updates.
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
  and set `web.port_forwarding = true`. It is off by default because it changes your router. It
  needs a router that allows port mapping and won't work behind carrier-grade NAT.
- If packs are hosted elsewhere, set `web.enabled = false` and provide a `download_url` override
  for every enabled pack.

If forwarding doesn't succeed and you haven't set a public URL, the plugin gives clients a loopback
address. That address works only on the server machine.

## `.mcaddon` bundles and overrides

The plugin extracts resource packs from bundles into `packs/.extracted/` and leaves behavior packs
out. When a bundle contains one resource pack, its extracted filename follows the bundle name; if
it contains several, each filename also includes the pack name. Use the exact effective filename
shown by `/baddon list` as the key under `overrides`. Bundles are unpacked in memory, so one that is
larger than 256 MiB, packed or unpacked, is left out with a warning; put its resource packs in the
folder as `.mcpack` files instead.

You can use `overrides` to change pack order, disable a pack, provide a different download URL, or
set manifest values such as `content_key` and `content_id`. Packs are ordered by `order`, then by
filename. Apart from `enabled`, overrides reach players only through the exported block below.

## Offer the packs to players

Pumpkin builds the pack offer for joining Bedrock players from the `[resource_pack.bedrock]` section
of its `pumpkin.toml`, and a plugin can't add packs to it. BedrockAddonManager never edits
`pumpkin.toml`, so you copy the packs in yourself:

1. Set the download address first (see above), so the exported URLs are ones players can reach.
2. Run `/baddon export` on the server console. It prints a `[resource_pack.bedrock]` block with
   `enabled = true`, `force` from `packs.force`, and one `[[resource_pack.bedrock.packs]]` table per
   listed pack, with its exact size, download URL and overrides.
3. In `pumpkin.toml`, replace the existing `[resource_pack.bedrock]` section, including its
   `packs = []` line, with the printed block.
4. Restart Pumpkin. It reads `pumpkin.toml` only on start.

Export again and repeat these steps whenever packs, overrides or the download address change. The
server log says when the address changes.
