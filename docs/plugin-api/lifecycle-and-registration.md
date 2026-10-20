---
navigation:
    category: Plugin API
title: "Plugin API: lifecycle and registration"
description: "Register a plugin, manage its callbacks, and release scheduled work"
---

# Lifecycle and registration

Pumpkin calls `onLoad(context)` when it loads your plugin. Use it to initialize the plugin and
register its handlers. You can also implement `onUnload(context)`, which Pumpkin calls when it
unloads the plugin, to save state and release resources that belong to that load.

## Register your plugin

Extend `Plugin`, implement `metadata()` to describe the plugin to Pumpkin, and register one instance
when the module initializes:

```typescript
import { Plugin, registerPlugin } from '@pumpkin-plugins/pumpkin-api';
import type { Context } from 'pumpkin:plugin/context@0.1.0';

class ExamplePlugin extends Plugin {
    metadata() {
        return {
            name: 'example',
            version: '1.0.0',
            authors: ['Example'],
            description: 'An example plugin',
            dependencies: [],
            permissions: [],
        };
    }

    onLoad(context: Context) {
        // Initialize the plugin and register handlers with this context.
    }

    onUnload(context: Context) {
        // Save state and release resources owned by this plugin.
    }
}

registerPlugin(new ExamplePlugin());
```

Register event, command, command suggestion, AI-goal, and chunk-generator callbacks from `onLoad`
with the `Plugin` methods. Event and command registration also take the provided context. The
facade stores each callback and gives the host a numeric handler ID; its `handle*` dispatch
functions are internal and are not for plugin code. The [generated API
reference](/api/tools/@pumpkin-plugins/pumpkin-api/) lists the complete facade signatures.

These callbacks belong to one plugin load. After `onUnload` returns or throws, the facade clears the
event, command, suggestion, AI-goal, and chunk-generator callbacks. Register them again the next time
`onLoad` runs. If host registration of an event or command fails, the facade removes that callback
and rethrows the error. A command resource may still hold its assigned handler ID if the host call
fails after the ID was assigned.

## Event and command handlers

`registerEvent` registers a blocking handler unless you pass `blocking = false`. The difference
matters when a handler wants to change the event. Pumpkin runs every blocking handler for an event
before any non-blocking one, whatever their priority, so `priority` only orders handlers within each
group. Only a blocking handler can modify or cancel the event by returning it; Pumpkin ignores the
value a non-blocking handler returns.

A command handler returns a result code when the command succeeds. To fail the command, throw a
`command-error` variant from the WIT `command` interface, such as
`{ tag: 'command-failed', val: message }` where `message` is a text component. Pumpkin shows that
text to the sender as the command's error. The command helpers in `@pumpkin-plugins/plugin-kit` do this for you. A plain
`Error` isn't a command error: Static Hermes reports its message as an `invalid-consumption` error
instead.

## Static Hermes callbacks

The Static Hermes adapter dispatches all five AI-goal methods—`canStart`, `shouldContinue`, `start`,
`stop`, and `tick`—and chunk-generator callbacks. A chunk-generator callback receives a generation
phase of `biomes`, `noise`, `surface`, or `features`.
The server, entity, and chunk resources passed to these callbacks are disposed when the callback
returns, so do not keep them for later use. If an AI-goal callback throws, `canStart` and
`shouldContinue` return `false`; errors from void callbacks are logged.

The pinned Pumpkin host does not start custom WASM AI goals because its eligibility methods return
`false`. This host limitation is separate from Static Hermes' callback
dispatch; see the [Static Hermes Runtime guide](../../tools/static-hermes-runtime/docs/index.md).

## IPC messages

By default, `handleIpcMessage(sender, message)` rejects messages. Override it when your plugin
accepts IPC from other plugins.

## Scheduled tasks

`plugin.scheduleDelayedTask` and `plugin.scheduleRepeatingTask` return Pumpkin task IDs. A delayed
callback is removed from the facade before it runs, even if it throws. A repeating callback stays
registered until you cancel the task or the plugin unloads.

Tick counts follow WIT `u64`. Pass safe-integer `number` values or `bigint` values in the range `0`
through `18,446,744,073,709,551,615`; a repeating period must be at least one tick. At runtime,
values must actually be numbers or bigints: other types are rejected before the facade tries to
convert them.

Use `plugin.cancelTask(taskId)` for tasks created by either scheduling helper. This releases the
callback from the facade; calling the raw scheduler cannot update its callback registry. Completed
and unknown task IDs are ignored. If host cancellation throws, the callback remains registered so
the still-active task can continue. If scheduling fails, the facade releases the callback
immediately. During unload, it releases every task callback even if `onUnload` throws, and Pumpkin
disables the plugin's scheduled tasks.
