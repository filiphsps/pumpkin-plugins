# UPnPumpkin plugin API

`@pumpkin-plugins/upnpumpkin-api` lets one plugin request a leased port mapping from UPnPumpkin
through Pumpkin plugin messages. It contains the message protocol, client, watcher, and helper for
turning a successful mapping into a public URL.

## Watch a mapping

Create a `PortMapClient` with the plugin message sender, then create a `MappingWatcher` with a
stable key, protocol, internal port, and description. Start the watcher after the plugin loads,
call `tick()` from the plugin's task handler, and call `stop()` when unloading or when the web
service no longer needs the port.

The watcher requests a mapping immediately and refreshes it while running. `openUrl` returns a URL
only when the reported state contains a usable public address. When UPnPumpkin is not installed or
has not loaded yet, the watcher reports an unavailable state; callers should handle it without
blocking their own service from starting.

When a watcher stops refreshing, UPnPumpkin eventually drops the request and closes its mapping.
The server's `REQUEST_TTL_MS` constant in the [forwarder](../../../../packages/upnpumpkin/src/forwarder.ts)
sets the inactivity window. UPnPumpkin also enforces the per-plugin limit configured by
[`plugins.max_requests_per_plugin`](../../../../packages/upnpumpkin/README.md#configuration). Stop
watchers when the port is no longer needed. The API package does not perform router discovery itself;
the server-side plugin owns that network work.
