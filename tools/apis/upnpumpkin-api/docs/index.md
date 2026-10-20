# UPnPumpkin plugin API

`@pumpkin-plugins/upnpumpkin-api` lets your plugin ask UPnPumpkin to make a local port reachable
from the internet. It sends requests through Pumpkin plugin messages; UPnPumpkin handles router
discovery and port mapping. The package provides the message protocol, a client, a watcher that
keeps a request alive, and a helper for building a public URL when the port is open.

## Watch a mapping

Create a `PortMapClient` with your plugin's message sender, then pass it to a `MappingWatcher` along
with a request, a state-change callback, and a clock. The request needs a key that stays the same
for this mapping, the local port, its protocol (`tcp` or `udp`), and a description for the router.
Start the watcher after your plugin loads and call `tick()` from its task handler. The first request
happens immediately; later checks keep the request alive and report state changes through the
callback.

Use `openUrl(state)` when you need an HTTP base URL for the mapped port. It returns a URL only for
an `open` state; while the mapping is pending, failed, unknown, or UPnPumpkin is unavailable, it
returns `undefined`. An unavailable state can mean UPnPumpkin isn't installed, hasn't loaded yet, or
couldn't answer. Handle it without preventing your own service from starting, and use the state
callback to update the URL when the mapping opens.

Call `stop()` when your plugin unloads or the service no longer needs the port. By default, this
releases the mapping immediately; pass `{ releasePort: false }` only when you want UPnPumpkin to
keep it temporarily. If your plugin stops unexpectedly, UPnPumpkin removes requests after five
minutes without a refresh. It also limits how many ports each plugin can request, as configured by
[`plugins.max_requests_per_plugin`](../../../../packages/upnpumpkin/README.md#configuration).

UPnPumpkin only opens ports for plugins listed in
[`plugins.allowed`](../../../../packages/upnpumpkin/README.md#configuration), which lists only
BedrockAddonManager by default. Any other plugin gets a `failed` state whose reason names that
setting, so tell server owners to add your plugin's name to the list.
