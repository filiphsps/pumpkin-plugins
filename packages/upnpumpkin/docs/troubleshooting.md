# Troubleshoot port forwarding

## No router is found

Confirm UPnP or NAT-PMP is enabled in the router settings and that the server host shares the
router's local network. If multicast discovery is blocked, set `router.upnp_search` to the router's
address and port. For NAT-PMP, set `router.nat_pmp_gateway` to the gateway address when automatic
local-address probing cannot find it.

Containers and networks with multiple routers can hide the gateway. Ensure the container has the
network access required to send and receive router discovery packets.

## A mapping is refused or players cannot connect

Check `/upnp status` for the router address and each port's state. A router with a non-public
internet-side address, including carrier-grade NAT, cannot provide an inbound route. A machine
that already has a public address does not need a mapping. Some routers are deliberately refused
because they do not support UPnP or NAT-PMP safely; create the port rules manually in that case.

Confirm the Java and Bedrock configured ports match the listeners and protocols. Java uses TCP;
Bedrock uses UDP. The router's mapping does not replace host firewall rules.

## A plugin's requested port closes

Check that `plugins.allow_requests` is enabled and that the requesting plugin stays active. Each
plugin can keep at most `plugins.max_requests_per_plugin` mappings open. Requests expire after five
minutes without a refresh and close when the requesting plugin stops its watcher or the server
stops.

Use `/upnp reload` after editing the config. If the plugin reports that its router is unsupported,
no mapping was opened; forward the port manually instead.
