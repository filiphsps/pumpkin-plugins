# WASI in Static Hermes

Static Hermes plugins run as WebAssembly components. Their JavaScript executes inside a Hermes VM
linked into the component, while services such as files, HTTP, clocks, and sockets are exposed
through imported WASI interfaces. The build tool combines the plugin's WIT world, generated
JavaScript facades, WIT-to-C bindings, and a native JSI adapter so JavaScript can call those
interfaces.

This page describes the WASI path this repository builds from the version and files pinned in
[`wasi-wit.lock.json`](../../build/wasi-wit.lock.json). The capability table below lists the
interfaces it imports. The guide does not cover every WASI proposal or every service a Pumpkin
server may expose. This runtime does not implement WASI 0.3's native
`async`, `future<T>`, or `stream<T>` features.[^wasi-03] For the general plugin build flow, see
[Building](../../../docs/building.md); for the engine comparison, see
[Benchmarking](../../../docs/benchmarking.md).

Static Hermes is the default build engine; QuickJS remains supported. Both use the plugin's
configured WASI imports, but the JavaScript facades and JSI adapters described here are specific to
Static Hermes. QuickJS uses a separate componentization path.

## What WASI means here

WASI is a set of typed interfaces that a WebAssembly component can import from its host. The
component does not receive ordinary operating-system syscalls or ambient access to files and the
network. A WIT world declares the interfaces it needs; at instantiation, a compatible host must
provide them. WASI's design uses imported interfaces and resource handles as capabilities, and
defines no ambient authorities. The host still decides what resources and permissions to provide.
See the upstream WASI capability model[^wasi-capabilities] and design principles.[^wasi-principles]

In this repository there are two distinct interface families:

- `pumpkin:plugin/*` is Pumpkin's plugin API: lifecycle hooks, server and player operations, events,
  commands, and related host services.
- `wasi:*` is standardized WASI functionality such as HTTP, filesystem, clocks, I/O streams, and
  sockets.

Both use WIT contracts, but they have different owners and host implementations. The build obtains
Pumpkin WIT from the pinned `@pumpkin-plugins/pumpkin-api` dependency. The WASI lock records its
version, each file's SHA-256 digest, and any alternate source URLs. The plugin API version and WASI
version are separate compatibility inputs.

WIT is an interface-definition language for the WebAssembly Component Model. It describes
interfaces, functions, data types, resources, and the component's imports and exports. Generated
bindings lower those higher-level values through the Component Model's Canonical ABI. That ABI
defines how values cross a component boundary, including when values are passed directly and when
they are represented in linear memory. See the upstream WIT description[^wit] and Component Model
explainer.[^canonical-abi]

## From plugin configuration to a WASI component

The build has several steps. The first four determine the component's declared WASI imports; the
last step leaves those imports for the Pumpkin runtime to resolve.

1. **The plugin opts into a capability bundle.** `pumpkinPlugin.wasi` in the plugin's
   `package.json` accepts the names in the [capability table](#capability-bundles). An omitted list
   means no WASI interfaces are added.
2. **The build retrieves pinned WIT definitions.** `@pumpkin-plugins/build` reads the API package's
   `wit.lock.json` and [`wasi-wit.lock.json`](../../build/wasi-wit.lock.json). It fetches the
   upstream Pumpkin WIT commit on first use and when the API lock changes, caching it under
   `.cache/pumpkin-api-wit/<lock-digest>/`. It downloads any missing WASI files, checks each file
   against its SHA-256 hash, and caches them by WASI version. Complete caches need no network
   access; a missing or changed pin needs network access.
3. **The build prepares the WIT world it will consume.** When WASI imports are enabled, it combines
   the cached Pumpkin API WIT with only the locked WASI files, then adds the selected `wasi:*`
   imports to the `plugin` world in a private temporary directory. The component build consumes
   that copy and publishes another copy to `build/wit/` for inspection. With no WASI imports, the
   build uses the cached API WIT directly and removes any stale `build/wit/` snapshot.
4. **TypeScript declarations come from that world.** The build uses `jco guest-types` to generate
   declarations under `build/types/`. With WASI imports, `--types-only` prepares the combined WIT in
   a temporary directory and removes it afterward; it leaves no combined snapshot under
   `build/wit/`. Those declarations let the editor and TypeScript check imported WASI modules and
   resource methods against the same WIT used for the component.
5. **esbuild replaces the external imports with facades.** Versioned imports such as
   `wasi:http/outgoing-handler@<version>` remain external to the ordinary JavaScript bundle. For
   Static Hermes, an esbuild plugin checks that each imported interface is present in the prepared
   WIT world and generates an ES module facade from its declarations. TypeScript call analysis
   identifies which declared operations the plugin uses.
6. **The native adapters and component are built.** The build analyzes the source files esbuild
   bundled to identify called WIT methods. `wit-bindgen c` generates C bindings for the plugin world;
   the runtime generator emits JSI host functions and WASI adapters for selected operations.
   If source analysis cannot provide Pumpkin API selections, the runtime keeps every operation in
   the imported Pumpkin API interfaces because esbuild has already inlined their facades into the
   IIFE bundle.
   Hermes compiles the JavaScript bundle to bytecode, and the WASI SDK compiles and links that
   bytecode, Hermes, JSI, the generated bindings, and the runtime shim into a component.
7. **The server resolves the imports at runtime.** The component imports the declared interfaces
   from its host. Pumpkin must provide compatible WASI imports and the plugin must have the
   corresponding runtime permissions. The build declares and adapts interfaces; it does not grant
   server permissions by itself.

Operation selection prunes the JavaScript-to-native adapter code; it does not remove methods from
the imported WIT interface. The component's world still declares each selected interface with the
functions and types in that interface. The Pumpkin runtime must resolve that component import.
Adapter selection is a build detail, not a per-method permission boundary.

The component uses the WebAssembly Component Model,[^component-model] including WIT imports and
the Canonical ABI. Runtime maintainers who change supported imports or adapters should follow the
[WASI maintenance guide](maintaining-wasi.md).

## Capability bundles

`pumpkinPlugin.wasi` uses a small set of repository-level names. The table and shared imports below
are generated from the build tool's capability map and the locked WASI version.

<!-- docs:begin capability-bundles -->
<!-- Generated from tools/wasi-capabilities/src/index.ts and tools/build/wasi-wit.lock.json. Run `pnpm readme`. -->

| Capability | Interfaces imported by the build |
| --- | --- |
| `http` | `wasi:http/types@0.2.3`<br>`wasi:http/outgoing-handler@0.2.3` |
| `filesystem` | `wasi:filesystem/types@0.2.3`<br>`wasi:filesystem/preopens@0.2.3` |
| `sockets` | `wasi:sockets/network@0.2.3`<br>`wasi:sockets/instance-network@0.2.3`<br>`wasi:sockets/tcp@0.2.3`<br>`wasi:sockets/tcp-create-socket@0.2.3` |
| `udp` | `wasi:sockets/network@0.2.3`<br>`wasi:sockets/instance-network@0.2.3`<br>`wasi:sockets/udp@0.2.3`<br>`wasi:sockets/udp-create-socket@0.2.3` |

Every selected capability also imports these support interfaces at version `0.2.3`:
`wasi:io/poll@0.2.3`, `wasi:io/streams@0.2.3`, `wasi:clocks/monotonic-clock@0.2.3`.
The build deduplicates shared imports when bundles overlap.
<!-- docs:end capability-bundles -->

These bundles are maintained by this repository; a package cannot add an arbitrary capability name.
An interface also brings its WIT dependencies into the prepared world, but the build copies only the
files listed in the lock. After a component build with WASI imports, inspect the exact imports in
`build/wit/plugin.wit`.

The lock and generated declarations define the precise signatures available to plugin code. Adapter
coverage and implementation details are documented in the [WASI maintenance guide](maintaining-wasi.md).

For example, a plugin that makes outgoing HTTP requests declares:

```json
{
  "pumpkinPlugin": {
    "entry": "src/plugin.ts",
    "output": "build/plugin.wasm",
    "wasi": ["http"]
  }
}
```

It can then import the generated WASI bindings by their versioned interface names:

<!-- docs:begin versioned-http-imports -->
<!-- Generated from tools/wasi-capabilities/src/index.ts and tools/build/wasi-wit.lock.json. Run `pnpm readme`. -->

```ts
import { handle } from 'wasi:http/outgoing-handler@0.2.3';
import { Fields, OutgoingRequest, RequestOptions } from 'wasi:http/types@0.2.3';
```
<!-- docs:end versioned-http-imports -->

The repository's [HTTP request helper](../../../tools/update-check/src/http-request.ts) shows the
resource lifecycle, timeout setup, response polling, and stream-reading pattern used by a real
plugin utility. For files, [`WasiDataDir`](../../../tools/plugin-kit/src/data-dir.ts) works with
Pumpkin's `data` preopen. The interfaces can expose more operations than a particular plugin is
permitted to use; the host policy remains authoritative.

## What happens during a WASI call

The JavaScript call path is:

1. The plugin calls an imported function or resource method generated from the WIT declarations.
2. The facade calls a JSI host function installed by the Static Hermes Runtime shim.
3. The native adapter converts JavaScript values to the WIT C representation, then calls the
   function emitted by `wit-bindgen`.
4. The generated binding crosses the component boundary using the Canonical ABI; the host's WASI
   implementation performs the operation.
5. The adapter converts the returned WIT value into a JavaScript value. Resource handles become
   guarded JavaScript wrappers, and owned WIT allocations are freed by generated cleanup code.

Here, “JSI host function” means the C++ callback installed in Hermes by the runtime shim. It is
separate from the Pumpkin server's WASI host implementation, which resolves the component import.

The boundary is typed, not JSON-based. The current converters handle WIT unit values, primitives,
strings, enums, flags, records, variants, options, results, tuples, lists, and resources where their
nested types have a supported conversion. Examples of the JavaScript representation include:

| WIT value | JavaScript representation used by the bindings |
| --- | --- |
| unit | `undefined` |
| `u64` or `s64` | `bigint` |
| `string` | `string` |
| `list<u8>` | `Uint8Array` |
| `record` | Object with the WIT field names converted to JavaScript property names |
| `enum` | String case name |
| `variant` | Tagged object, usually `{ tag, val }` when the case has a payload |
| `option<T>` | `null` when absent, otherwise the converted value |
| owned resource | Generated resource wrapper with explicit drop/dispose behavior |

Use generated TypeScript declarations instead of hand-written approximations, especially for
64-bit values and result shapes. A top-level WASI `result` error is surfaced by the Static Hermes
facade as a JavaScript `Error`; nested result/variant data is represented as tagged values. Resource
wrappers guard use after disposal or ownership transfer. Drop resources when finished, including
error paths; `Symbol.dispose` is available for WASI resources that have a generated drop operation.

Value conversion adds work at the boundary: byte lists are copied into typed arrays, and records or
lists can allocate JavaScript objects or arrays. A plugin making many small WASI calls can be more
sensitive to that cost than one that batches data; long-running operations also include host and I/O
time. The repository's [engine comparison](../../../docs/benchmarking.md) measures guest-side
JavaScript workloads and selected Pumpkin API behavior, not WASI calls. Its engine ratios do not
describe WASI throughput. Measure a representative plugin against the target host before drawing a
performance conclusion.

I/O through the imported interfaces commonly uses resource objects such as pollables, streams, and
HTTP response futures. Named `future-*` resources are part of the WIT interface. They are distinct
from the Component Model's native `future<T>`, `stream<T>`, and `async` features in WASI 0.3.[^wasi-03]
Code may need to advance operations through polling or other explicit steps; the build does not
turn them into browser `fetch` calls or JavaScript promises. The
[update-check HTTP helper](../../../tools/update-check/src/http-request.ts) uses a generator to yield
pollables to the plugin scheduler. It constructs a request, subscribes to the response future,
yields the resulting pollable, retrieves the response, consumes its body, reads the input stream in
chunks, then disposes owned resources in reverse order. The
[WASI socket adapter](../../../packages/upnpumpkin/src/platform/wasi-network.ts) follows the same
stepwise model for TCP: it starts a connection, polls `finishConnect()`, and treats `would-block` as
pending work rather than a completed connection.

## Host permissions and sandboxing

Declaring `wasi: ["filesystem"]` or `wasi: ["sockets"]` makes the component import the matching
interfaces. It does not give the plugin a directory or open network access. The Pumpkin server
must resolve those imports and apply its permission policy. The repository's
[plugin-creation guide](../../../docs/creating-a-plugin.md#files-and-network-access) documents the
permission names currently used for filesystem, TCP, UDP, and outbound HTTP:

| Build capability | Pumpkin permission metadata |
| --- | --- |
| `filesystem` | `fs.read.data` and/or `fs.write.data`; access is limited to the plugin's own `data` preopen |
| `sockets` | `network.tcp.bind` to listen, `network.tcp.connect` to connect out |
| `udp` | `network.udp.bind` to receive, `network.udp.outgoingdatagram` to send to any address, `network.udp.connect` to connect to one |
| `http` | `http.outbound` for HTTP or HTTPS |

Declare the permissions needed by the plugin in its `info.permissions` metadata as well as the
matching `pumpkinPlugin.wasi` build capability. These are separate requirements. The build
configuration does not pin a minimum Pumpkin server version for each `wasi:*` host import, so
verify the import and permission behavior on the server version you deploy.

WASI imports and resource handles refer to specific host-provided resources. Plugins still need to
handle missing mounts, denied permissions, and host errors. Standards define the interfaces; Pumpkin
server releases determine which imports they resolve and which permissions they grant. Verify both
on the server version you deploy.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Build reports an unknown WASI capability | Choose a name from the [capability table](#capability-bundles). |
| TypeScript cannot resolve a `wasi:*` import | Confirm the matching capability is declared and regenerate guest declarations with the plugin's typecheck/build workflow. |
| Build says an interface is not imported by the plugin WIT world | The module import does not match the selected capability bundle or its locked WIT dependencies. |
| First build cannot download WIT files | The first build needs network access unless the pinned files are already cached. Check their URLs and SHA-256 entries in the lock. |
| Component builds but fails when loaded or called | Check that the Pumpkin server resolves the imported interface and that `info.permissions` grants the matching operation. Inspect the server's error for a denied host capability. |
| A WASI resource throws after use | Check ownership transfer and disposal paths. Do not reuse a consumed resource; release resources on success and error paths. |

## References

### Repository implementation

- [Build and runtime caveats](../../../docs/building.md)
- [Plugin capability and permission setup](../../../docs/creating-a-plugin.md#files-and-network-access)
- [Static Hermes toolchain and runtime coverage](../README.md)
- [WASI HTTP request helper](../../../tools/update-check/src/http-request.ts)
- [WASI filesystem data helper](../../../tools/plugin-kit/src/data-dir.ts)
- [Pinned WASI WIT lock](../../build/wasi-wit.lock.json)
- [WASI maintenance guide](maintaining-wasi.md)

[^wasi-capabilities]: WebAssembly/WASI, [Capabilities](https://github.com/WebAssembly/WASI/blob/main/docs/Capabilities.md),
    on imported interfaces and capability-based access.
[^wasi-principles]: WebAssembly/WASI, [Design Principles](https://github.com/WebAssembly/WASI/blob/main/docs/DesignPrinciples.md),
    including capability security and portability.
[^wit]: WebAssembly Component Model, [WIT: The WebAssembly Interface Type](https://github.com/WebAssembly/component-model/blob/main/design/mvp/WIT.md).
[^canonical-abi]: WebAssembly Component Model, [Explainer: Canonical ABI](https://github.com/WebAssembly/component-model/blob/main/design/mvp/Explainer.md#canonical-abi),
    describing how component values cross the ABI boundary.
[^component-model]: WebAssembly Component Model, [design and overview](https://github.com/WebAssembly/component-model),
    including its component interface model.
[^wasi-03]: WASI.dev, [WASI 0.3 release notes](https://wasi.dev/releases/wasi-p3), describing native
    `async`, `future<T>`, and `stream<T>` support in the Component Model.
