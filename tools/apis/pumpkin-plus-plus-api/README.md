# @pumpkin-plugins/pumpkin-plus-plus-api

This package is the typed TypeScript client for Pumpkin++, PumpkinMC's native extension layer. It
currently exposes the chunk-preparation protocol: submit a world and chunk coordinate, then poll
from a later callback while Pumpkin runs its usual loading or generation pipeline. A ready result
carries a finite lease so you can read the chunk through Pumpkin's ordinary world API. Release the
lease after capture, or cancel work you no longer need. No IPC call waits for generation.

This package contains the byte protocol, a low-level `PumpkinPlusPlusClient`, and a
`PumpkinPlusPlusSession` for optional-provider use. It imports no Pumpkin host interfaces, starts
no timers, and sends nothing during construction. The native provider must be installed separately;
see the [Pumpkin++ installation instructions](https://github.com/filiphsps/pumpkin-plugins/tree/master/native/pumpkin-plus-plus#readme).
The native compatibility and real-server lifecycle proofs belong to the bridge implementation;
portable API tests alone do not establish them.

## Use from a plugin

Install the API with `pnpm add @pumpkin-plugins/pumpkin-plus-plus-api`. In a Pumpkin plugin, inject
`ipcSend` from `@pumpkin-plugins/plugin-kit/ipc`, a monotonic millisecond clock, and your warning
logger. For example, a caller that already owns those dependencies can create its session like this:

```ts
import {
    PumpkinPlusPlusSession,
    type SendMessage,
} from '@pumpkin-plugins/pumpkin-plus-plus-api';

function createChunkProvider(
    send: SendMessage,
    now: () => number,
    warn: (message: string) => void,
) {
    return new PumpkinPlusPlusSession({ send, now, warn });
}
```

Keep one session for the consuming plugin load. On first use, `submit({ world, x, z })` probes
compatibility, then sends one submit request. `x` and `z` are **chunk coordinates** from -1,000,000
through 1,000,000; out-of-range values are rejected before IPC. World names identify currently loaded
worlds; the native provider resolves them and scopes operation
IDs and quotas to the host-supplied sender identity. Do not put a caller ID into the request.

Session calls return `{ ok: true, value }` or `{ ok: false, error }`. A successful submit returns
`{ operationId, state }`; preserve that plain operation handle across callbacks. Call
`poll(operationId)` later until its value is `ready`, or until an error reports a terminal outcome.
A ready value includes `leaseId` and `remainingLeaseMs`. That time is observed by the native
provider, so account for time spent in the control call before treating it as a local deadline.
Polling never renews the lease. Use `release(leaseId)` on completion or abandonment, and
`cancel(operationId)` for pending work. Cancellation can lose a race with completion and return a
ready lease; release it just as you would one returned by `poll`. The native provider validates every
request, scopes operation IDs and leases to the host-supplied sender, and enforces deadlines and cleanup.

Treat an uncertain submit failure deliberately: the session does not replay it, because the native
provider may already have accepted the job. Cancel and release operate by caller-owned IDs, and
release acknowledges a completed release again while its terminal record remains retained. That
record expires at `terminalRetentionMs` and may be evicted sooner when terminal-history limits are
reached. `busy` is a rejected admission;
`timeout`, `host_failure`, `cancelled` and `expired` can terminate admitted work. Neither an empty
chunk nor all-air terrain is an error signal in this API.

## Availability and warnings

`state` reads the last observation without IPC. `availability()` and normal operation calls probe
only when due. A successful probe is cached for 30 seconds. Failed probes retry after 1 second,
then double the delay up to 30 seconds. No retry runs while the consumer is idle.

The states are `unknown`, `available`, `missing`, `incompatible`, and `temporarily_unreachable`.
Any loaded plugin that can send host IPC to Pumpkin++ can use this client. Provider failures include a
`phase`: `probe` means reachability probing failed before the requested operation was sent, including
while a failed probe is in backoff; `operation` means probing succeeded and the requested IPC operation
was invoked, so a submit result may be uncertain. The host-supplied sender
name scopes operation IDs, leases, quotas and cleanup. A probe establishes compatibility and reports
the provider's exact host release/source metadata. Job errors such as `busy` do not mean the provider
is unavailable.

At the pinned Pumpkin release, `send-ipc-message` has an outer unit error for self-send or an
unavailable recipient. A failing IPC handler in another plugin can surface through the same
ambiguous exception, so the exception does not establish that the recipient is missing. The generated
TypeScript binding exposes only the inner byte-or-string result, while other host-call failures can
also throw, so the standard `ipcSend` wrapper cannot safely identify the outer error as recipient
absence. It therefore produces `temporarily_unreachable` for a generic exception, even before the
first successful probe, and cannot authoritatively report installation state. A transport with
positive evidence of recipient absence can throw
`new TransportError('missing')`; never infer that evidence from a generic IPC exception.
Malformed responses also report temporary unreachability; an explicit unsupported version,
provider identity, or `incompatible` error reports incompatibility.

Only confirmed missing or incompatible states produce installation guidance through the injected
logger. Default warning ownership is shared across all sessions in this module load, so recreating a
session does not warn again. If several copies of the package are loaded into one consumer, pass the
same `WarningScope` through the `warnings` option to all of them. Create that scope once per
consuming plugin load, not per session.

## Wire contract

Each request and response is scalar UTF-8 JSON of at most 8192 bytes. The envelope version is `v: 1`,
independent of the npm version, WIT package version and native ABI. Requests use `op: 'probe'`,
`'submit'`, `'poll'`, `'cancel'` or `'release'`. Probe has no payload; submit carries only `world`,
`x`, `z`; poll/cancel carry `operationId`; release carries `leaseId`. Strings are byte bounded:
world names at 128 bytes, ASCII operation/lease IDs at 64 bytes, host release at 128 bytes, source
commit at 40 lowercase hexadecimal characters, and optional error messages at 256 bytes. Text
rejects control characters and unpaired surrogates. Additive unknown fields are ignored, but
incompatible known variants, mismatched IDs and invalid fields are rejected.

The probe replies:

```json
{"v":1,"ok":true,"provider":"Pumpkin++","protocol":1,"hostRelease":"0.2.0+26.3-26.51","hostSourceCommit":"204a94ed895f041a845630d5a23c094705a0704e"}
```

Submit/poll success carries `ok: true`, `operationId` and `state: 'queued' | 'running' | 'ready'`.
Ready additionally requires `leaseId` and `remainingLeaseMs` from 1 through 60000. Cancel success
carries `operationId` and either `state: 'cancelled'` or `state: 'ready'` with `leaseId` and
`remainingLeaseMs`; the caller must release the lease when completion wins the cancellation race.
Release success carries `leaseId` and `released: true`.
Errors carry `ok: false` and a stable `code`: `incompatible`, `busy`,
`invalid_request`, `unknown_world`, `host_failure`, `not_found`,
`timeout`, `cancelled`, or `expired`.
Terminal poll errors retain `operationId`; timeout/cancelled/expired and poll host_failure require it.
A pre-admission submit host_failure may omit the operation ID. An optional
`message` is bounded diagnostic text. Consumers should branch on the code, not the text.

The low-level client returns the operation-specific success value or a `BridgeRejection` with
`code`; it throws `InputError`, `ProtocolError`, `IncompatibleError`, or `TransportError` for local
validation and transport failures. The session returns provider/bridge failures as typed results;
invalid caller arguments, including coordinates outside -1,000,000 through 1,000,000, and invalid or
backward clock values still throw `InputError` before IPC.
The probe records host metadata rather than asserting native ABI compatibility from a version number.

## Validation

Run `pnpm --filter @pumpkin-plugins/pumpkin-plus-plus-api test` and
`pnpm --filter @pumpkin-plugins/pumpkin-plus-plus-api typecheck` from the repository root.
The byte seam uses literal native-contract messages; the typed client seam injects transport,
clock and logger. It covers lazy recovery, bounded retry, terminal errors, ID correlation and
warning ownership. No native binary or server is required for these portable tests.

<!-- docs:begin reference -->
<!-- Generated by pumpkin-plugins-docs from package, action, extension, and component docs metadata. Run `pnpm readme`. -->

See the [API reference](https://filiphsps.github.io/pumpkin-plugins/api/tools/@pumpkin-plugins/pumpkin-plus-plus-api/) on the documentation site.
<!-- docs:end reference -->
