# Port mapping library

`@pumpkin-plugins/port-mapping` discovers UPnP and NAT-PMP routers and manages leased port mappings.
It is independent of Pumpkin APIs and WASI: network operations are supplied through the small
`Network` interface, which also makes the discovery and retry behavior testable with fake routers.

## Mapping lifecycle

`PortMapper` discovers a gateway, requests mappings, renews leases, and removes mappings when they
are released. UPnP and NAT-PMP discovery can run together; UPnP is preferred when both respond.
Mappings can move to another external port when the requested one is unavailable. Failures are
retried with increasing delays, and a failed operation triggers router rediscovery.

The engine is tick-friendly. Network work is represented as yielded steps and advanced through a
`Task`, so callers can make progress without blocking a game tick. Supply a `Network` adapter that
implements datagrams, connections, and dialing for the host environment.

## Reachability limits

Port mapping cannot bypass carrier-grade NAT. If the router's internet-side address is not public,
the server remains unreachable through an inbound mapping. A machine with its own public address
does not need a router mapping. Callers can provide a router-identification screen to refuse known
unsupported hardware before sending mapping commands.

The package includes fake network and router implementations for deterministic tests; no live
router is required to test the mapping state machine.
