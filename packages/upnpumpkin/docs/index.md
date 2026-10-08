# UPnPumpkin

UPnPumpkin asks a home router to forward the server's Java TCP and Bedrock UDP ports using UPnP or
NAT-PMP. This lets players outside the local network connect without manually adding router rules
when the network supports automatic mapping.

Install `upnpumpkin.wasm` in the Pumpkin server's `plugins/` folder and restart. By default it
requests Java port `25565` and Bedrock port `19132`. Router leases are renewed halfway through
their configured lifetime and are closed when the server stops.

## Check the mapping

Operators can run `/upnp status` to see the discovered router, public address, and port states.
Run `/upnp reload` after changing `plugins/data/UPnPumpkin/config.toml` to re-read settings and
update the mappings. A server that already has a public address does not need a router mapping.

UPnPumpkin can also accept port requests from other plugins. Requests are enabled by default and
limited to 16 open ports per plugin. A requesting plugin must stop its watcher when it no longer
needs a port; unused requests expire after five minutes.

## Network requirements

The router must have UPnP or NAT-PMP enabled, and the host must have a public route through that
router. Carrier-grade NAT cannot be bypassed with a mapping. A second router or a container network
that blocks multicast can prevent discovery; configure the router search address when multicast is
blocked. UPnPumpkin refuses routers on its built-in unsupported-router list before opening ports.

UPnP is available to devices on the local network. Run it only on a network you trust. See the
troubleshooting page for common discovery and reachability failures.
