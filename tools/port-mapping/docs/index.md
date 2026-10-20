# Port mapping library

`@pumpkin-plugins/port-mapping` finds a router that supports UPnP or NAT-PMP and keeps requested
ports open on it. The library has no Pumpkin or WASI dependency, so a host can use it by providing
the network operations through its `Network` interface.

## Requesting a mapping

Create a `PortMapper` with a `Network` adapter and mapper options, then call `request` with a key
and a mapping specification. The key lets you check or release that request later. A request starts
as `pending`; call `tick` regularly to advance discovery and network work, then read its state to
learn whether it opened or failed. An open state includes the address and external port to use. If
the router cannot use the requested external port, the mapper tries another one. Call `release` when
the port is no longer needed; the router is told to close it on a later tick. During shutdown, use
`releaseAll` and let it finish so the mapper can clean up its open ports.

The mapper renews a lease halfway through its lifetime, or after five minutes if that comes first.
If discovery or a mapping operation fails, it retries with increasing delays and searches for the
router again. A machine with its own public address does not need a router mapping; the mapper
reports that address directly. If the router's internet-side address is not public, such as behind
carrier-grade NAT, an inbound mapping cannot make the server reachable.

## Network adapter and router screening

The `Network` adapter supplies the operations the host needs: opening UDP datagrams, dialing TCP,
finding the local address used to reach a destination, and reading the current time. These
operations return promptly rather than waiting for network activity. The mapper advances the
resulting work through `tick`, so callers can make progress without blocking a game tick.

When both protocols are enabled, the UPnP SSDP search and device-description reads finish before
NAT-PMP discovery starts. The UPnP SOAP and NAT-PMP requests then run together, and UPnP is preferred
when both find a router. If you provide a router-identification `screen`, the library checks UPnP
descriptions before sending protocol requests. When neither protocol finds a router, it probes the
web interface at the usual router addresses so a recognized router can be named. A screen can refuse
routers it recognizes as unsupported; routers that cannot be identified are left alone.

The package includes fake network and router implementations for deterministic tests. They let you
exercise discovery and mapping behavior without a live router.
