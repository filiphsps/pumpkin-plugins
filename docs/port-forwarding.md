# Port forwarding

Players can only reach a server behind a home router when the router forwards the server's ports.
This repo does that with UPnP and NAT-PMP, in layers that a plugin can use at the level it needs.

| Layer | Package | What it is |
| --- | --- | --- |
| Engine | `@pumpkin-plugins/port-mapping` (`tools/port-mapping`) | Finds the router and keeps ports open on it. No Pumpkin or WASI imports: it runs on a small `Network` interface, so it is unit-tested with a fake router. |
| Plugin | UPnPumpkin (`packages/upnpumpkin`) | Runs the engine on WASI sockets, opens the Java and Bedrock ports, and answers other plugins. |
| API | `@pumpkin-plugins/upnpumpkin-api` (`tools/upnpumpkin-api`) | The messages, a client and a watcher for plugins that want a port opened. |
| Host | `@pumpkin-plugins/plugin-kit` (`tools/plugin-kit`) | What every plugin needs from the host: data folder, logging, scheduling, commands, IPC. |

BedrockAddonManager is the first user of the API: it asks UPnPumpkin to open its web port when
`web.public_url` is empty and `web.bind` is `0.0.0.0` (opt out with `web.port_forwarding = false`).

## How the engine works

Plugins run inside a game tick and can't wait, so the engine is written as generators that yield
while they wait for the network (`Steps<T>`, run by `Task`). `PortMapper` owns the work:

1. If this machine's address toward the internet is public, nothing is opened.
2. Otherwise `discover` looks for a router: UPnP (an SSDP search, then the router's description
   and a SOAP `GetExternalIPAddress`) and NAT-PMP (a request to the first and last address of the
   local /24, or the gateway from the config) side by side. UPnP wins when both answer.
3. A router whose own internet-side address isn't public (carrier-grade NAT) is reported as a
   failure, because no mapping can make the server reachable through it.
4. Each requested port is opened with a lease, renewed at half the lease, moved to another public
   port when the router says the first is taken, and closed when released or when the plugin stops.
5. Failures are retried with growing waits (30 s up to 10 min), and the router is searched for
   again when an operation fails. Each failure is logged once, not on every retry; it is logged
   again after the port opened and later failed anew, or when the reason changes.

### Telling routers apart

Pass `screen` in the discovery options and the engine identifies routers before it asks them to do
anything. The `screen` gets a `RouterIdentity` (manufacturer, model, model number, name) and returns
a reason to turn the router down, or nothing. Turned down, a router is never used or asked again: the
mapper's ports fail with the reason and `info().refused` is set. Without a `screen` nothing is
identified. The order is:

1. The router's web interface. Routers without UPnP or NAT-PMP can't describe themselves, so
   `identify.ts` has a short list of public pages that give them away (`WEB_FINGERPRINTS`: for now
   Telekom's Speedport login page). Only the first and last address of the local /24, or the
   configured NAT-PMP gateway, are asked, on port 80, with a short timeout.
2. UPnP devices: the SSDP search and the device description, whose `manufacturer`, `modelName`,
   `modelNumber` and `friendlyName` are the identity. No SOAP action is sent yet.
3. Only then the protocols themselves (the UPnP actions, NAT-PMP). NAT-PMP therefore waits for the
   UPnP search, which makes finding a router take up to the length of that search longer.

NAT-PMP has no way to ask a router what it is, so a NAT-PMP-only router is only recognized by its web
interface. A router that says nothing about itself is never turned down.

UPnPumpkin's `screen` is its blocklist, see below.

WASI has no way to list interfaces, read the routing table or join a multicast group, so the
engine only needs two things from the host: an outgoing address toward a destination (a UDP socket
pointed at it, which sends nothing) and sockets. That is the whole `Network` interface.

## The blocklist

`packages/upnpumpkin/src/blocklist.ts` lists the routers UPnPumpkin stays away from: a whole make
(Telekom, which has no UPnP or NAT-PMP at all) or only some models. A rule has a `manufacturer`
pattern, optional `models` and a short `reason`; a rule with models only blocks routers whose model
is known. When the router is on the list:

- the log gets one warning, when the router has been identified (a few seconds after the start),
- `/upnp reload` fails with the same text,
- `/upnp status` shows it in red,
- ports other plugins ask for fail with the reason.

The README table of blocked routers is generated from the list (`info.blocks.routers`, see [Plugin
info and READMEs](plugin-info-and-readmes.md)), so adding a rule updates the document with
`pnpm readme`.

## Asking UPnPumpkin for a port

```ts
import { ipcSend } from '@pumpkin-plugins/plugin-kit/ipc';
import { MappingWatcher, openUrl, PortMapClient } from '@pumpkin-plugins/upnpumpkin-api';

const watcher = new MappingWatcher(new PortMapClient(ipcSend), request, onChange, Date.now);
watcher.start();
```

Call `watcher.tick()` once per game tick and `watcher.stop()` when done. Messages are JSON in
Pumpkin's plugin messages (`ensure`, `status`, `release`, `info`; see `protocol.ts`). `ensure` is
idempotent, so the watcher repeats it to learn how the request is going. UPnPumpkin keeps each
plugin's keys apart, limits how many ports plugins may hold, and drops a request nobody has
repeated for five minutes.

UPnPumpkin is optional for the plugin that asks: while it is missing the state is `unavailable`
and the plugin carries on. Don't list it in `dependencies`, which would stop your plugin loading
without it.

## Testing

- Engine and API: unit tests with `FakeNetwork` and `FakeIgd` from
  `@pumpkin-plugins/port-mapping/testing`, which move a clock by hand and simulate a router (UPnP
  and NAT-PMP, taken ports, permanent-lease-only routers, CGNAT).
- UPnPumpkin: integration tests start a real server and a router on localhost
  (`@pumpkin-plugins/port-mapping/testing/router`: the same `FakeIgd` behind real UDP and HTTP
  sockets) and point the plugin at it with `router.upnp_search` and `router.nat_pmp_gateway`.
- BedrockAddonManager with UPnPumpkin: `test/forwarding.itest.ts` loads both on one server (see
  [Testing](testing.md)).
