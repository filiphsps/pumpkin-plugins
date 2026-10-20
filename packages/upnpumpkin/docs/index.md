# UPnPumpkin

If players outside your local network need to reach your server, UPnPumpkin can ask your router to
forward the Java TCP port and the Bedrock TCP and UDP ports using UPnP or NAT-PMP. When the network
supports automatic mapping, you don't have to add those router rules by hand.

Install `upnpumpkin.wasm` in the Pumpkin server's `plugins/` folder, then restart the server. The
[configuration reference](../README.md#configuration) lists the default ports and other settings.
The router keeps each mapping for a limited lease; UPnPumpkin renews it halfway through that time,
or after five minutes if that comes first, and closes it when the server stops.

## Check the mapping

Run `/upnp status` to check which router UPnPumpkin found, the public address, and the state of each
port. After editing `plugins/data/UPnPumpkin/config.toml`, run `/upnp reload` to apply the settings
and update the mappings. If the server machine already has a public address, it doesn't need a
router mapping.

Other plugins can request their own port mappings. The `plugins.allow_requests` setting turns these
requests on or off, and `plugins.max_requests_per_plugin` sets how many mappings each plugin may keep
open; see the [configuration reference](../README.md#configuration). A plugin should stop refreshing
its request when it no longer needs the port. UPnPumpkin closes mappings that have not been refreshed
for five minutes.

## Network requirements

Your router needs to support and have UPnP or NAT-PMP enabled, and your server needs a route to the
internet through that router. A mapping cannot get around carrier-grade NAT or a second router in
front of yours (double NAT); `/upnp status` names the one it found. For double NAT, forward the
ports on the outer router or put it in bridge mode. A container network that blocks multicast can
prevent router discovery. If multicast is blocked, set the router search address in the
configuration. UPnPumpkin checks its unsupported-router list
before opening ports and refuses routers on that list.

UPnP is available to devices on your local network, so run it only on a network you trust. If a port
doesn't open or players still can't connect, see the [troubleshooting guide](troubleshooting.md).
