# Troubleshoot Bedrock pack hosting

## Players cannot download a pack

Start by checking that `web.enabled` is true and that `/baddon list` shows the pack. Then make sure
the configured bind address and port are reachable through your server firewall. `web.public_url`
must point to the address your clients can use. If it is empty, BedrockAddonManager can ask
UPnPumpkin to forward the port when `web.port_forwarding` is enabled. If forwarding does not succeed,
it uses a loopback address, which works only for players on the server machine.

The built-in server uses plain HTTP. To serve packs over HTTPS, put a reverse proxy in front of it
and set `web.public_url` to the address clients use at the proxy. If you host packs elsewhere,
set a `download_url` override for each pack; you can also turn off the built-in server with
`web.enabled = false`.

## A pack is missing or has unexpected metadata

BedrockAddonManager scans the pack folder at server startup and when you run `/baddon reload`.
Check the server log for manifest errors, reload, and then use `/baddon list` to see what was found.
An `.mcaddon` may contain both behavior and resource packs; the plugin extracts only resource packs.
For those extracted packs, use the effective name shown by `/baddon list` as the override key. The
inner filename may be different.

To leave out a pack, set `overrides."<file>".enabled = false`; you can also change its position
with the `order` override. Config changes take effect after `/baddon reload` or a server restart.
BedrockAddonManager does not edit `pumpkin.toml`.

## Packs are not offered to joining players

BedrockAddonManager hosts pack files, but it does not send resource-pack offers when players join.
That means clients are not prompted to download the packs, and setting `packs.force` has no effect.
