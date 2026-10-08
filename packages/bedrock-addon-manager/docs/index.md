# BedrockAddonManager

BedrockAddonManager scans Bedrock `.mcpack` and `.mcaddon` files, reads pack manifests, and serves
the selected resource packs over HTTP. Use it to prepare pack downloads for Bedrock players.

Pumpkin does not currently expose an API for sending resource-pack offers to players. The plugin
can host and describe packs, but it cannot make clients download or require them; the `packs.force`
setting has no effect until Pumpkin supports delivery.

## Typical setup

Install `bedrock-addon-manager.wasm` in the server's `plugins/` directory and restart. Put pack
files in `plugins/data/BedrockAddonManager/packs/`, then run `/baddon reload` or restart again.
`/baddon list` shows each discovered pack and its effective settings. The plugin does not modify
`pumpkin.toml`.

Choose a URL Bedrock clients can reach. Set `web.public_url` when serving packs through a known
address or reverse proxy. If it is empty and the server binds to `0.0.0.0`, the plugin can ask
UPnPumpkin to forward `web.port`; without a successful mapping it falls back to a loopback address,
which only works on the server machine. See the setup and troubleshooting pages in this section
for network and pack-format details.

## Pack selection

The plugin reads each pack's `manifest.json` for its UUID, version, and flags. An `.mcaddon` may
contain both behavior and resource packs; only its resource packs are extracted and served because
Pumpkin cannot use behavior packs. Per-file overrides can disable a pack, set its order, or provide
an external `download_url`. Overrides for extracted packs use the name shown by `/baddon list`.

The built-in server uses plain HTTP. Put a TLS reverse proxy in front of it when clients need an
HTTPS URL, or host the files elsewhere and configure download URLs.
