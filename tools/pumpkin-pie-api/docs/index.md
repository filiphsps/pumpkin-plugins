# PumpkinPIE API

`@pumpkin-plugins/pumpkin-pie-api` provides a synchronous protocol 0 client, expansion router and
plugin-wide recovery session. It is a private workspace package. Its production dependency tree
contains only `fflate`; it imports no Pumpkin, WIT, WASI, Node or TabDisplay modules.

## Consumer and expansion example

Add this package and `@pumpkin-plugins/plugin-kit` as workspace dependencies of the consuming plugin.
Inject the host adapter; the API package itself never imports it:

```ts
import { PieSession } from '@pumpkin-plugins/pumpkin-pie-api';
import { ipcSend } from '@pumpkin-plugins/plugin-kit/ipc';

const pie = new PieSession({
    send: ipcSend,
    now: () => Date.now(), // Prefer the host's monotonic clock when available.
    onTransition: state => {
        // Log availability transitions here; never log IPC payloads or private values.
    }
});
pie.registerExpansion('example', {
    greeting: context => context.viewer ? `Hello ${context.viewer}` : undefined
}, { kind: 'ttl', ms: 5000 });

// Call from plugin load and from ONE shared scheduled task (e.g. every second).
export function refresh(): void {
    pie.tick();
    if (pie.state.kind !== 'ready') return;
    const lines = pie.client.resolveBatch([
        { text: '%player_name%: %example_greeting%', viewer: 'Steve' },
        { text: '%server_online% online' }
    ]);
    // Use the full result or discard it on failure. Unresolved tokens remain in text.
    // Presentation and fallback policy belong to the consumer.
}

// Export this from the plugin's guest entrypoint; sender must be the actual host sender.
export function handleIpcMessage(sender: string, message: Uint8Array): Uint8Array {
    return pie.router.handle(sender, message);
}

// Call on unload. Upstream removes ALL namespaces owned by this calling plugin.
export function unload(): void {
    pie.stop();
}
```

If the plugin already handles other IPC, route its PIE callbacks here and preserve its other handlers.
Catch client errors at the consumer boundary; `tick()` handles provider failures itself. After a client
failure, discard that refresh and choose fallback presentation. Do not substitute partial results.
The example's `refresh`, `handleIpcMessage` and `unload` functions show adapter boundaries, not automatic
lifecycle registration. Connect them to the plugin's existing lifecycle and task handlers.

`viewer` means the placeholder **subject's current player name**, never its UUID. A tab renderer
chooses whether that subject is the screen viewer or the listed player. An omitted viewer resolves
without player context. Resolve player names again when they change.

`getValue(id, viewer?, argument?)` supports argument-dependent placeholders and returns either
`{ known: false }` or `{ known: true, value: string }`; a known empty string is distinct from unknown.
`resolve(text, viewer?, argument?)` sends even literal text. Consumers may skip literal-only work in
scheduling. `list()` returns advertised placeholders, and `ping()` negotiates protocol 0. Plugin
version strings are diagnostic; unsupported protocol versions throw `IncompatibleError`.

## Expansion ownership and callback safety

Use one `PieSession` per calling plugin. Its `client` and `router` share a `CallbackGuard`; if creating
these separately, pass the same guard to `new PieClient(send, { guard })` and
`new ExpansionRouter(guard)`. Share it with **every** PIE client in that plugin.

`registerExpansion(namespace, handlers, cache?)` snapshots normalized handlers and records desired
registration. The next `tick()` negotiates and registers them. Namespaces contain ASCII letters and
digits, start with a letter, and cannot be `player`, `server` or `pie`. Names contain ASCII letters,
digits and underscores. Registration normalizes case. The namespace is the part before the first
underscore, so `my_plugin_rank` belongs to namespace `my`.

The router checks the host sender against `PumpkinPIE` (or a configured provider), validates callback
bytes, and dispatches only locally owned handlers. An unknown name or unowned namespace returns
`{"ok":true,"on_request":{}}`; empty string returns a known value. Advertised names are **not**
upstream access control. Viewer names are untrusted context, not proof of permission. A waypoint
handler must resolve the online player and enforce waypoint access before revealing private names
or counts.

Callbacks are synchronous: return a string or undefined using local state only. Do not return a
Promise, start network requests, render, or call any PIE client from a callback. The guard rejects
accidental re-entry before sending and resets with `finally`, including resolver failures. Handler
failures return a generic rejection without secrets. There is no timeout or cancellation: this tool
cannot protect the server from a third-party callback that hangs.

Standalone `PieClient.registerExpansion(registration)` returns the provider's applied cache policy.
TTL requests may exceed 60000 ms, but the provider clamps them; TTL zero may be echoed as `never`.
`PieSession.appliedCache(namespace)` exposes the latest applied policy, and clears it during outages.
There is no second stale-value cache in this library.

`PieClient.unregisterExpansions()` unregisters **every namespace owned by the calling plugin**.
`ExpansionRouter.remove(namespace)` drops only a local handler map; it does not unregister remotely.
Coordinate ownership centrally rather than letting independent components unregister each other.
`stop()` is permanent and attempts remote unregistration once when reachable.

## Scheduling, recovery and failures

The session starts unavailable. Call `tick()` explicitly with a monotonic millisecond clock; there
are no global timers. Failed attempts back off from 1 second to 30 seconds. Successful sessions ping
and renew desired registrations every 30 seconds by default (`pingIntervalMs`: 1000–30000).
Periodic registration detects identical-version provider replacement and restores namespaces; the
wire has no restart epoch. Renewal can invalidate the provider's expansion cache. `onTransition`
fires only when availability changes, suitable for transition warnings without repeated logs.
An incompatible provider is retried without registering namespaces until protocol 0 is available.

Errors distinguish local `InputError`, transport `UnavailableError`, provider `RejectedError`,
unsupported `IncompatibleError`, malformed/mismatched `ProtocolError`, and callback `ReentryError`.
Transport exceptions have generic messages: the injected byte transport (including `ipcSend`)
normalizes nested host failures and cannot reliably distinguish every IPC failure layer. The library
does not log request/reply payloads or carry their contents in diagnostic messages.

## Batches and byte limits

Messages are UTF-8 JSON objects with `op`, no invented version field. Successful replies require
the correct result wrapper. Unknown additive fields are ignored. Invalid UTF-8, JSON, required
fields, counts, cache policies, contradictory values or result variants fail validation.

Limits are 1 MiB per encoded message, 32 KiB per input/output text, 128 bytes per identifier, name,
namespace, viewer or argument, and 8192 lines per batch. Unicode is counted in UTF-8 bytes, and JSON
escaping overhead counts toward message size. Unpaired UTF-16 surrogates are refused locally.
The whole batch is validated before sending. Every output is checked, and result count must match
exactly before mapping positions: upstream silently drops oversized input lines.

`resolveBatch(lines)` sends one bounded batch. `resolveMany(lines)` preflights **all** lines, then
partitions by encoded bytes and count, preserving order. If any chunk fails, it throws without
returning partial results. It cannot roll back provider-side callbacks already performed.

## Testing and provenance

`@pumpkin-plugins/pumpkin-pie-api/testing` exports `FakeTransport` for queued literal JSON, raw bytes
or transport errors, and `FakeClock` for deterministic ticks. These are test boundaries, not a fake
placeholder engine or proof of host interoperability.

```ts
import { PieClient } from '@pumpkin-plugins/pumpkin-pie-api';
import { FakeTransport } from '@pumpkin-plugins/pumpkin-pie-api/testing';

const transport = new FakeTransport();
transport.enqueue({ ok: true, value: { known: true, value: '' } });
const client = new PieClient(transport.send);
client.getValue('example_empty'); // { known: true, value: '' }
```

The original TypeScript implementation follows the public
[protocol contract](https://github.com/Rennex07/PumpkinPIE/blob/6f89a3ab002d4e19b3238789f620a0cbf7a85224/docs/protocol.md)
and [wire definitions](https://github.com/Rennex07/PumpkinPIE/blob/6f89a3ab002d4e19b3238789f620a0cbf7a85224/crates/pumpkin-pie/src/protocol.rs)
at source commit `6f89a3ab002d4e19b3238789f620a0cbf7a85224` (workspace version 0.2.3).
No Rust implementation is translated or vendored. PumpkinPIE is GPL-3.0-only; this workspace tool
is MIT. Provider artifacts must stay external/ignored with source commit, license and SHA-256 recorded.

Local unit and type tests do **not** prove real IPC. Plan 016's TabDisplay/PIE integration fixture is
not implemented yet, so the real-provider gate remains **BLOCKED**. No provider artifact was loaded
or hashed for this work. The required ABI remains `@pumpkinmc/pumpkin-api-ts` v0.1.1 on Pumpkin
`0.2.0+26.3-26.51`; neither pin was changed. Close this gate only after the pinned provider's real IPC,
callback guard, outage/recovery and batch-context tests pass and its artifact SHA-256 is recorded.
