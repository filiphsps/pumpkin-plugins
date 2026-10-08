# Troubleshoot Bedrock pack hosting

## Players cannot download a pack

Check that `web.enabled` is true, the pack appears in `/baddon list`, and the configured bind
address and port are reachable through the server firewall. Confirm that `web.public_url` names the
address clients use. If it is empty, check whether UPnPumpkin is installed and whether
`web.port_forwarding` is enabled. Without a successful forward, the fallback is loopback and is not
reachable from other machines.

The built-in server speaks plain HTTP. For HTTPS, configure a reverse proxy and set
`web.public_url` to the proxy's client-facing address. When using external hosting, configure a
`download_url` override for each pack and disable the built-in server if it is not needed.

## A pack is missing or has unexpected metadata

The plugin scans only at server startup and `/baddon reload`. Check the server log for manifest
errors, then run `/baddon list` after reloading. An `.mcaddon` can contain behavior packs and
resource packs; only resource packs are extracted. For extracted files, key overrides by the
effective name reported by `/baddon list`, not by an assumed inner filename.

Set `overrides."<file>".enabled = false` to omit one pack, or adjust its order there. Changes to
the plugin config take effect on reload or restart. The plugin never edits `pumpkin.toml`.

## Packs are not offered to joining players

This is a current Pumpkin API limitation: Pumpkin does not provide a resource-pack delivery API.
BedrockAddonManager can scan and serve files, but cannot send a pack offer or enforce downloads.
Accordingly, `packs.force` currently has no effect.
