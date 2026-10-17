# Troubleshoot port forwarding

Start with `/upnp status`. It shows whether UPnPumpkin has found a router and whether each requested
port is open, still being opened, or failed. The command's state helps narrow down which part of the
network to check.

## No router is found

Make sure UPnP or NAT-PMP is enabled in the router settings and the server host is on the router's
local network. UPnP normally uses multicast discovery. If the server's network blocks multicast,
set `router.upnp_search` in `plugins/data/UPnPumpkin/config.toml` to the router's IPv4 address and
UPnP port, for example `192.168.1.1:1900`. Run `/upnp reload` to apply the change.

For NAT-PMP, set `router.nat_pmp_gateway` to the gateway's IPv4 address and port (usually
`192.168.1.1:5351`) if automatic probing does not find it. In a container or a network with
multiple routers, check that the server can reach the router and receive its replies; a container
network may not pass the discovery traffic the router needs.

## A port is not opened or players cannot connect

In `/upnp status`, look at the state and reason shown for the Java and Bedrock ports. Confirm
`java.port` and `bedrock.port` match the server listeners. Java uses TCP and Bedrock uses UDP. The
router mapping does not change host firewall rules, so allow the same ports and protocols through
the server's firewall.

The router also needs a public internet-side address to accept inbound connections. If its address
is private or shared through carrier-grade NAT, a mapping cannot make the server reachable from the
internet. A server machine that already has a public address does not need a router mapping.

If `/upnp status` reports that the router is unsupported, UPnPumpkin intentionally opens nothing
for that router. Forward the ports manually in the router settings instead.

## A plugin's requested port closes or is rejected

Check that `plugins.allow_requests` is enabled and the requesting plugin is still refreshing its
request. UPnPumpkin drops a request after five minutes without a refresh, and the requester should
stop its watcher when it no longer needs the port. Each plugin can hold up to
`plugins.max_requests_per_plugin` mappings at once; a request beyond that limit is rejected.

After changing settings in `plugins/data/UPnPumpkin/config.toml`, run `/upnp reload`. Changes also
take effect after a server restart.
