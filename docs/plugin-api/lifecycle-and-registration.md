---
navigation:
    category: Plugin API
---

# Lifecycle and registration

Extend `Plugin`, provide `metadata()`, implement `onLoad(context)` for startup registration, and optionally implement `onUnload(context)` to save state and release resources. Call `registerPlugin(instance)` once at module initialization so Pumpkin can invoke the lifecycle exports.

Event, command, suggestion, AI-goal and chunk-generator callbacks belong to one plugin load. The API releases these callbacks after `onUnload`, even when it throws, so register them again from a later `onLoad`.

If event or command registration with the host fails, the corresponding callback is removed from the dispatch registry before the error is rethrown. A command resource may keep its assigned handler ID if host registration failed after the ID was assigned.

The facade keeps event, command, suggestion, task, AI-goal and chunk-generator callbacks in handler maps and passes numeric IDs to the host. Register callbacks through the plugin context or `Plugin` helper methods; do not call the internal `handle*` dispatch functions from plugin code.

The default IPC handler rejects messages. Override `handleIpcMessage(sender, message)` when the plugin accepts IPC. The [generated reference](/api/tools/@pumpkin-plugins/pumpkin-api/) documents the complete facade signatures.

Scheduled helpers return Pumpkin task IDs. Delayed callbacks are released before they run, including
when they throw. Tick counts follow WIT `u64`: numbers must be safe integers, bigints must be between
0 and 18,446,744,073,709,551,615, and repeating periods must be at least one tick. Repeating callbacks
remain registered until cancellation or unload. Call
`plugin.cancelTask(taskId)` to cancel a task created by either helper and release its captured
resources; calling the raw scheduler cannot update the facade's callback registry. Completed and
unknown task IDs are ignored. If host cancellation throws, the callback remains registered so the
still-active task can continue. Failed scheduling releases the callback immediately. Unload releases
all task callbacks even when `onUnload` throws; Pumpkin disables the plugin's scheduled tasks. At
runtime, tick values must be numbers or bigints; other values are rejected before coercion.
