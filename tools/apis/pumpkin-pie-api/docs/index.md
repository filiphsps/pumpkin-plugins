# PumpkinPIE API

<!-- docs:begin overview -->
<!-- Generated from protocol/session constants, test/release.ts and package.json. Run `pnpm readme`. -->

Host-independent TypeScript client, expansion router and recovery session for
[PumpkinPIE (EXTERNAL)](https://github.com/Rennex07/PumpkinPIE) protocol 0.
<!-- docs:end overview -->

PumpkinPIE is an external plugin whose implementation and separate build tooling live in the
upstream [repository](https://github.com/Rennex07/PumpkinPIE); that project publishes the provider
through its [releases](https://github.com/Rennex07/PumpkinPIE/releases). This workspace package
provides the TypeScript client API and does not build or bundle the provider.

Its production dependency tree contains only `fflate`; consumers inject the host transport.

## Resolve a line

Use a standalone client for an occasional lookup. Call `ping()` before relying on the provider:

```ts
import { PieClient } from '@pumpkin-plugins/pumpkin-pie-api';
import { ipcSend } from '@pumpkin-plugins/plugin-kit/ipc';

const pie = new PieClient(ipcSend);
const provider = pie.ping(); // Throws IncompatibleError for an unsupported protocol.
const line = pie.resolve('Hello %player_name% — %server_online% online', 'Steve');
```

Read `line.text` for presentation and `line.unresolved` for raw unresolved identifiers. A token that
cannot resolve remains in the text as written. For example, `%player_name%` needs an online subject,
while server placeholders can resolve with the viewer omitted. Literal text is still sent; skip
literal-only work in consumer scheduling if appropriate.

`viewer` is the placeholder **subject's current player name**, never its UUID. A consumer rendering
information about several players passes each subject's name, which may differ from the screen
viewer's name. Refresh names when players change them. It is context, not an authorization credential.
`provider.version` is diagnostic; `provider.protocol` determines compatibility.

## Look up one value

Use an identifier without percent signs. Pass an argument separately for an argument-dependent
placeholder:

```ts
import { PieClient } from '@pumpkin-plugins/pumpkin-pie-api';
import { ipcSend } from '@pumpkin-plugins/plugin-kit/ipc';

const pie = new PieClient(ipcSend);
pie.ping();
const permission = pie.getValue('player_has_permission', 'Steve', 'Example:use');
const allowed = permission.known && permission.value === 'true';

function valueOrFallback(id: string, subjectName: string): string {
    const result = pie.getValue(id, subjectName);
    return result.known ? result.value : '(unknown)';
}
```

An unknown lookup is `{ known: false }`. A known empty value is `{ known: true, value: '' }` and stays
empty in this example; a truthiness fallback would erase that distinction. Both `getValue` and
`resolve` accept an optional third `argument` parameter. `pie.list()` returns built-in and
contributed advertised placeholders with their identifiers, descriptions, namespaces and sources.

## Resolve several subjects

Build one request per subject and keep the returned lines in the same order:

```ts
import { type Line, PieClient } from '@pumpkin-plugins/pumpkin-pie-api';
import { ipcSend } from '@pumpkin-plugins/plugin-kit/ipc';

const pie = new PieClient(ipcSend);
pie.ping();
const subjects = ['Steve', 'Alex'];
const requests: Line[] = subjects.map(name => ({
    text: '%player_name%: %player_ping%ms',
    viewer: name
}));
const resolved = pie.resolveBatch(requests);
const rows = subjects.map((name, index) => ({ subject: name, line: resolved[index] }));
```

`resolveBatch` validates every input, sends one message, and checks every output plus the exact
result count before returning. If it throws, discard that refresh before mapping or applying any
row. An oversized line cannot silently shift another subject's content into its position.

For larger input sets, replace the batch call with `pie.resolveMany(requests)`. It partitions valid
lines by encoded message bytes and line count and restores their order. The whole operation throws
on any failed chunk, so no partial overall result is returned. Limits apply to UTF-8 bytes, including
JSON escaping; partitioning does not make an individually oversized line valid.

## Consumer and expansion lifecycle

For recurring resolution and contributed placeholders, use one `PieSession` with one shared task.
The factory below takes the plugin's monotonic millisecond clock and returns explicit lifecycle
adapters. `greeting` uses only local callback context and declines when no subject is supplied:

```ts
import {
    IncompatibleError, type Line, PieSession, ProtocolError,
    RejectedError, type ResolvedLine, UnavailableError
} from '@pumpkin-plugins/pumpkin-pie-api';
import { ipcSend } from '@pumpkin-plugins/plugin-kit/ipc';

export function createPlaceholderApi(now: () => number) {
    const pie = new PieSession({
        send: ipcSend,
        now,
        onTransition: state => {
            // Connect transition-only availability logging here; omit IPC payloads.
        }
    });
    pie.registerExpansion('example', {
        greeting: context => context.viewer ? `Hello ${context.viewer}` : undefined
    }, { kind: 'ttl', ms: 5000 });

    function refresh(requests: readonly Line[]): readonly ResolvedLine[] | undefined {
        pie.tick();
        if (pie.state.kind !== 'ready') return undefined;
        try {
            return pie.client.resolveMany(requests);
        } catch (error) {
            if (error instanceof UnavailableError || error instanceof IncompatibleError ||
                error instanceof RejectedError || error instanceof ProtocolError) return undefined;
            throw error; // Surface invalid local input and accidental callback re-entry.
        }
    }

    return {
        refresh,
        handleIpcMessage: (sender: string, message: Uint8Array) => pie.router.handle(sender, message),
        appliedCache: () => pie.appliedCache('example'),
        stop: () => pie.stop()
    };
}
```

Call `refresh` after plugin load and from the plugin's shared scheduled task. A return of `undefined`
means no result is available; the caller chooses fallback presentation. A returned array is complete
and retains unresolved tokens. The next `tick()` performs negotiation and desired registration,
and periodic ticks handle recovery. `appliedCache()` exposes the provider's applied policy, rather
than assuming the requested TTL was accepted unchanged.

Export the plugin's `handleIpcMessage(sender, message)` and delegate PIE callbacks to the returned
adapter, passing the actual host sender. Preserve existing handlers for other IPC protocols.
Call `stop()` on unload; it unregisters all namespaces owned by the calling plugin once when
reachable. These adapters do not automatically register lifecycle hooks or tasks.

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

Standalone `PieClient.registerExpansion(registration)` returns registration details; read its `.cache`
field for the provider's applied cache policy.
TTL requests may exceed the [protocol cap](#batches-and-byte-limits), but the provider clamps them;
TTL zero may be echoed as `never`.
`PieSession.appliedCache(namespace)` exposes the latest applied policy, and clears it during outages.
There is no second stale-value cache in this library.

`PieClient.unregisterExpansions()` unregisters **every namespace owned by the calling plugin**.
`ExpansionRouter.remove(namespace)` drops only a local handler map; it does not unregister remotely.
Coordinate ownership centrally rather than letting independent components unregister each other.
`stop()` is permanent and attempts remote unregistration once when reachable.

## Scheduling, recovery and failures

<!-- docs:begin scheduling -->
<!-- Generated from protocol/session constants, test/release.ts and package.json. Run `pnpm readme`. -->

The session starts unavailable. Call `tick()` explicitly with a monotonic millisecond clock; there
are no global timers. Failed attempts use exponential backoff (1000–300000 ms).
Successful sessions ping and renew desired registrations every
30000 ms by default (`pingIntervalMs`: 1000–30000 ms).
<!-- docs:end scheduling -->

The package exports these intervals as `SESSION_TIMING`, so consumer docs can quote them without
copying the numbers.

Periodic registration detects identical-version provider replacement and restores namespaces; the
wire has no restart epoch. Renewal can invalidate the provider's expansion cache. `onTransition`
fires only when availability changes, suitable for transition warnings without repeated logs.
An incompatible provider is retried without registering namespaces until a compatible protocol
is available.

Errors distinguish local `InputError`, transport `UnavailableError`, provider `RejectedError`,
unsupported `IncompatibleError`, malformed/mismatched `ProtocolError`, and callback `ReentryError`.
Transport exceptions have generic messages: the injected byte transport (including `ipcSend`)
normalizes nested host failures and cannot reliably distinguish every IPC failure layer. The library
does not log request/reply payloads or carry their contents in diagnostic messages.

## Batches and byte limits

Messages are UTF-8 JSON objects with `op`, no invented version field. Successful replies require
the correct result wrapper. Unknown additive fields are ignored. Invalid UTF-8, JSON, required
fields, counts, cache policies, contradictory values or result variants fail validation.

<!-- docs:begin limits -->
<!-- Generated from protocol/session constants, test/release.ts and package.json. Run `pnpm readme`. -->

| Limit | Maximum |
| --- | --- |
| Encoded message | 1048576 bytes |
| Input/output text | 32768 bytes |
| Identifier, name, namespace, viewer or argument | 128 bytes |
| Lines per batch | 8192 |
| Expansion TTL cap | 60000 ms |
<!-- docs:end limits -->

Unicode is counted in UTF-8 bytes, and JSON escaping overhead counts toward message size.
Unpaired UTF-16 surrogates are refused locally.
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
const value = client.getValue('example_empty'); // { known: true, value: '' }
```

Test recovery with a virtual clock instead of sleeping. Initial failure is retried after one second:

```ts
import { expect, it } from 'vitest';
import { PIE_PROVIDER, PROTOCOL_VERSION, PieSession } from '@pumpkin-plugins/pumpkin-pie-api';
import { FakeClock, FakeTransport } from '@pumpkin-plugins/pumpkin-pie-api/testing';

it('recovers when the provider becomes available', () => {
    const clock = new FakeClock();
    const transport = new FakeTransport();
    transport.enqueue(new Error('provider is not loaded'));
    transport.enqueue({
        ok: true,
        ping: { protocol: PROTOCOL_VERSION, name: PIE_PROVIDER, version: 'test-provider', placeholders: 0, expansions: 0 }
    });
    const pie = new PieSession({ send: transport.send, now: clock.now });
    pie.tick();
    expect(pie.state.kind).toBe('unavailable');
    clock.advance(999);
    pie.tick();
    expect(pie.state.kind).toBe('unavailable');
    clock.advance(1);
    pie.tick();
    expect(pie.state.kind).toBe('ready');
    expect(transport.messages.map(message => message.request)).toEqual([
        { op: 'ping' }, { op: 'ping' }
    ]);
});
```

## Pinned provider integration fixture

Run the package's integration project from the repo root:

```sh
pnpm --filter @pumpkin-plugins/pumpkin-pie-api test:integration
```

<!-- docs:begin provenance -->
<!-- Generated from protocol/session constants, test/release.ts and package.json. Run `pnpm readme`. -->

Global setup downloads the exact
[PumpkinPIE v0.2.3 release](https://github.com/Rennex07/PumpkinPIE/releases/tag/v0.2.3), never `latest`,
and verifies its SHA-256 before loading it. The provider and server are resolved before workers start.
The provider is cached at `.cache/pumpkin-pie/v0.2.3-pumpkin_pie_plugin.wasm`; cached bytes are also
verified on every resolution. An interrupted or rejected download never becomes the cached artifact.
A checksum mismatch fails the run rather than silently selecting another release.

| Provenance | Pin |
| --- | --- |
| Provider asset | `pumpkin_pie_plugin.wasm` |
| Release tag | `v0.2.3` |
| Provider source commit | [`b7cbb14417b397bca71a36b62efa8caa1ba72354`](https://github.com/Rennex07/PumpkinPIE/tree/b7cbb14417b397bca71a36b62efa8caa1ba72354) |
| SHA-256 | `04c23e0ce814a461eb07efc3641457b893ad4519a073d6bad3dc5799b4d1e61f` |
| Provider license | GPL-3.0-only |
| Target Pumpkin release | `0.2.0+26.3-26.51` |
| Target Pumpkin source commit | `204a94ed895f041a845630d5a23c094705a0704e` |
| Target API artifact | `@pumpkin-plugins/pumpkin-api` v0.1.1 |
| Workspace tool license | MIT |

The pinned provider's [protocol contract](https://github.com/Rennex07/PumpkinPIE/blob/b7cbb14417b397bca71a36b62efa8caa1ba72354/docs/protocol.md)
and [wire definitions](https://github.com/Rennex07/PumpkinPIE/blob/b7cbb14417b397bca71a36b62efa8caa1ba72354/crates/pumpkin-pie/src/protocol.rs)
document the external protocol. No Rust implementation is translated or vendored.
Provider artifacts stay external and ignored, outside the workspace tool's production exports and shipped source files.
<!-- docs:end provenance -->

The fixture runs on the harness's checksum-verified pinned server (or explicit `PUMPKIN_BIN`
override), with no ABI upgrade. It fails if the harness release pin no longer matches the provider.
Tests prove the published provider loads, resolves `%server_online%` from the console, and preserves
unknown tokens and their unresolved identifiers. They also verify that the valid cache is reused
without downloading. A compiled guest fixture in `test/fixtures/consumer` uses `PieClient` and
`ExpansionRouter` over real host IPC: it pings, resolves `%server_online%`, registers an expansion
and resolves its own placeholder, so the provider calls back into the guest. Unit tests exercise failed downloads and corrupt cached artifacts without
network access; `pnpm test` and coverage select only the unit project.

Additional integration files can use `inject('pieProviderPath')` from Vitest after this global setup
and pass it to `startPumpkin({ plugins: [providerPath, consumerPath] })`. Build any guest consumer
before that test. Do not substitute Node unit transports for the compiled consumer's host IPC.

Integration tests in other workspace packages import `resolvePieProvider` and `PIE_RELEASE` from
`@pumpkin-plugins/pumpkin-pie-api/testing/provider`. The subpath resolves only inside this
repository: it depends on the private test harness and is removed from the published manifest.

Outage and recovery, and mapping placeholders to online players, are not covered here. The plugin
integration tests in Waypoints, TabDisplay and Distant Horizons Support exercise their own
expansions against the same provider.
