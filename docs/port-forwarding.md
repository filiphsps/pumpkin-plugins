---
navigation:
    category: Server operations
title: "Port forwarding"
description: "UPnP and NAT-PMP for plugins: the engine, UPnPumpkin, its API and how to test them"
---

# Port forwarding

If your Pumpkin server is behind a home router, players on the internet need the router to forward
the server's ports. This guide explains how the repository handles that with UPnP and NAT-PMP, and
how plugins can request additional mappings.

| Layer | Package | What it does |
| --- | --- | --- |
| Engine | `@pumpkin-plugins/port-mapping` (`tools/port-mapping`) | Finds a router and manages port mappings. It has no Pumpkin or WASI imports; it uses a small `Network` interface that unit tests can implement with a fake router. |
| Plugin | UPnPumpkin (`packages/upnpumpkin`) | Runs the engine over WASI sockets, opens the Java port (TCP) and the Bedrock port (TCP and UDP), and handles mapping requests from other plugins. |
| API | `@pumpkin-plugins/upnpumpkin-api` (`tools/apis/upnpumpkin-api`) | Provides the IPC message format, client, and watcher for plugins that need a port opened. |
| Host | `@pumpkin-plugins/plugin-kit` (`tools/plugin-kit`) | Gives plugins the host services UPnPumpkin uses: a data folder, logging, scheduling, commands, and IPC. |

BedrockAddonManager uses the API to open its web port when `web.port_forwarding` is true,
`web.public_url` is empty and `web.bind` is `0.0.0.0`. Forwarding is off by default.

## How the engine works

Plugins run inside game ticks and can't block while waiting for the network. The engine therefore
does its work in generators (`Steps<T>`) that yield between network operations; `Task` advances
them. `PortMapper` manages discovery and each requested mapping:

The engine is IPv4-only: it asks for IPv4 port mappings and opens no IPv6 firewall pinholes
(`WANIPv6FirewallControl`).

1. If this machine's address toward the internet is public, nothing is opened.
2. Otherwise, discovery looks for enabled protocols. With UPnP enabled, it completes the SSDP
   search and reads device descriptions before starting NAT-PMP. UPnP SOAP and NAT-PMP requests then
   run side by side; UPnP is preferred if both succeed. NAT-PMP tries the first and last address of
   the local /24, or the configured gateway.
3. If the router's internet-side address is not public, the mapping fails. The reason names the
   cause by the address range: `100.64.0.0/10` is carrier-grade NAT, a private range such as
   `192.168.0.0/16` means another router sits in front (double NAT), and `0.0.0.0` means the router
   has no internet connection right now.
4. Each mapping has a lease and is renewed halfway through it, or after five minutes if that
   comes first, so a router reboot or a new WAN address is noticed quickly. If the requested public
   port is taken, the engine tries another one. It closes the mapping when the request is released
   or the plugin stops.
5. After a failure, the engine searches again and retries with increasing delays, from 30 seconds
   up to 10 minutes. It logs a given failure once, then logs it again if the reason changes or after
   the mapping recovers and fails again.

Some routers advertise UPnP URLs that point to the wrong machine. The engine accepts `LOCATION`,
`URLBase`, and resolved WAN control URLs only when they use the IPv4 address that sent the SSDP
response. Their HTTP ports may differ from the SSDP port and from each other. Devices whose URLs
point to another host are skipped.

### Telling routers apart

The engine can identify routers before asking them to open ports. Pass a `screen` function in the
discovery options; it receives the router's `RouterIdentity` (manufacturer, model, model number,
and name) and can return a reason to reject it. A rejected router is not used or queried again;
mapping requests fail with that reason and `info().refused` is set. Without a `screen`, the engine
does not identify routers. Screening happens in this order:

1. UPnP device descriptions. The engine checks `manufacturer`, `modelName`, `modelNumber`, and
   `friendlyName` from each response before sending any SOAP action.
2. Protocol requests. UPnP SOAP actions and NAT-PMP requests run side by side. NAT-PMP waits for
   the UPnP search and description-screening pass to finish, so discovery can take longer than the
   search window alone.
3. The router's web interface, only when neither protocol found a router. A router without UPnP
   can't describe itself, so `identify.ts` has a short list of recognizable pages
   (`WEB_FINGERPRINTS`), currently Telekom's Speedport login page. The engine probes port 80 at the
   first and last address of the local /24, or at the configured NAT-PMP gateway, with a short
   timeout. A match turns the failure into a refusal that names the router.

The probe runs last so that another device at one of those addresses, such as a Speedport used as
an access point, can't hide the router that answers. NAT-PMP has no identity query, so a NAT-PMP
router that answers is used without being identified. The engine won't reject a router it can't
identify.

UPnPumpkin's `screen` is its blocklist, see below.

WASI has no way to list interfaces, read the routing table or join a multicast group, so the
engine only needs two things from the host: an outgoing address toward a destination (a UDP socket
pointed at it, which sends nothing) and sockets. That is the whole `Network` interface.

## The blocklist

`packages/upnpumpkin/src/blocklist.ts` lists routers UPnPumpkin avoids. A rule can block a whole
manufacturer (Telekom, which has no UPnP or NAT-PMP) or selected models. Each rule has a
`manufacturer` pattern, optional `models`, and a short `reason`. A rule with `models` only applies
when the router's model is known. When UPnPumpkin identifies a listed router:

- the log gets one warning, when the router has been identified (a few seconds after the start),
- `/upnp reload` fails with the same text,
- `/upnp status` shows it in red,
- ports other plugins ask for fail with the reason.

The README's blocked-router table comes from this list via `info.blocks.routers` (see [Plugin info
and READMEs](plugin-info-and-readmes.md)). Run `pnpm readme` after adding a rule to update it.

## Asking UPnPumpkin for a port

```ts
import { ipcSend } from '@pumpkin-plugins/plugin-kit/ipc';
import { MappingWatcher, openUrl, PortMapClient } from '@pumpkin-plugins/upnpumpkin-api';

const watcher = new MappingWatcher(new PortMapClient(ipcSend), request, onChange, Date.now);
watcher.start();
```

Call `watcher.tick()` once per game tick and `watcher.stop()` when you're done. The client sends JSON
in Pumpkin plugin messages using the `ensure`, `status`, `release`, and `info` operations (see
`protocol.ts`). `ensure` is idempotent, so the watcher can repeat it while checking the request's
status. UPnPumpkin keeps keys separate for each requesting plugin, limits how many ports each
plugin can hold, and drops a request if the plugin hasn't repeated it for five minutes.

The requesting plugin can work without UPnPumpkin. While UPnPumpkin is unavailable, the watcher
reports `unavailable` and your plugin can carry on. Don't add UPnPumpkin to `dependencies`; that
would prevent your plugin from loading when UPnPumpkin isn't installed.

## Testing

- Engine unit tests use `FakeNetwork` and `FakeIgd` from `@pumpkin-plugins/port-mapping/testing`.
  They control time directly and simulate UPnP and NAT-PMP routers, including taken ports,
  permanent-lease-only routers, and CGNAT.
- API unit tests give `PortMapClient` a send function that decodes each request and answers with an
  encoded reply, so no router or network is involved.
- UPnPumpkin integration tests run a real server with a localhost router from
  `@pumpkin-plugins/port-mapping/testing/router`. The fake IGD uses real UDP and HTTP sockets; set
  `router.upnp_search` and `router.nat_pmp_gateway` to point the plugin at it.
- `packages/bedrock-addon-manager/test/forwarding.itest.ts` loads BedrockAddonManager and UPnPumpkin
  together on one server. See the [Testing guide](testing.md).
