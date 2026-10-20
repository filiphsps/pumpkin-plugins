# BedrockAddonManager

BedrockAddonManager scans Bedrock `.mcpack` and `.mcaddon` files, reads their manifests, and serves
enabled resource packs over HTTP. `/baddon export` prints the `pumpkin.toml` block that makes
Pumpkin offer those packs to Bedrock players when they join; see
[Offer the packs to players](setup.md#offer-the-packs-to-players).

## Typical setup

Install `bedrock-addon-manager.wasm` in the server's `plugins/` directory and start or restart the
server. Put pack files in `plugins/data/BedrockAddonManager/packs/`, then run `/baddon reload` to
scan them. Use `/baddon list` to see discovered packs and their effective settings. The plugin
keeps its configuration in its own data folder.

Choose a URL Bedrock clients can reach. Set `web.public_url` when serving packs through a known
address or reverse proxy. If it is empty, `web.bind` is `0.0.0.0`, and you set
`web.port_forwarding = true`, the plugin asks UPnPumpkin to forward `web.port`. If forwarding does not succeed, it uses a loopback
address that works only on the server machine. See [setup](setup.md) for network and pack-format
details, or [troubleshooting](troubleshooting.md) if clients cannot download a pack.

## Pack selection

The plugin reads each pack's `manifest.json` for its UUID, version, and flags. An `.mcaddon` may
contain both behavior and resource packs; only the resource packs are extracted and served.
Per-file overrides can disable a pack, change its order, or provide an external `download_url`.
For packs extracted from an `.mcaddon`, use the effective name shown by `/baddon list` as the
override key.

The built-in server uses plain HTTP. Put a TLS reverse proxy in front of it when clients need an
HTTPS URL, or host the files elsewhere and configure download URLs.
