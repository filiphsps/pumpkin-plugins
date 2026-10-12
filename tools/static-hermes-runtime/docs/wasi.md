# WASI in Static Hermes

Static Hermes plugins run as WebAssembly components. Their JavaScript executes inside a Hermes VM
linked into the component, while services such as files, HTTP, clocks, and sockets are exposed
through imported WASI interfaces. The build tool combines the plugin's WIT world, generated
JavaScript facades, WIT-to-C bindings, and a native JSI adapter so JavaScript can call those
interfaces.

This page describes the WASI path implemented by this repository. It focuses on the pinned WASI
0.2.3 interfaces and the Static Hermes adapter. It is not a reference for every WASI proposal or
for every service the Pumpkin server may expose. For the general plugin build flow, see
[Building](../../../docs/building.md); for the engine comparison, see
[Benchmarking](benchmarking.md).

Static Hermes is the default build engine; QuickJS remains supported. Both use the plugin's
configured WASI imports, but the JavaScript facades and JSI adapters described here are specific to
Static Hermes. QuickJS uses a separate componentization path.

## What WASI means here

WASI is a set of typed interfaces that a WebAssembly component can import from its host. The
component does not receive ordinary operating-system syscalls or ambient access to files and the
network. A WIT world declares the interfaces it needs; at instantiation, a compatible host must
provide them. WASI's design uses imported interfaces and resource handles as capabilities, and
defines no ambient authorities. The host still decides what resources and permissions to provide.
See the upstream [WASI capability model][^wasi-capabilities] and [design principles][^wasi-principles].

In this repository there are two distinct interface families:

- `pumpkin:plugin/*` is Pumpkin's plugin API: lifecycle hooks, server and player operations, events,
  commands, and related host services.
- `wasi:*` is standardized WASI functionality such as HTTP, filesystem, clocks, I/O streams, and
  sockets.

Both use WIT contracts, but they have different owners and host implementations. The build obtains
Pumpkin WIT from the pinned `@pumpkinmc/pumpkin-api-ts` dependency. WASI WIT is separately pinned by
[`wasi-wit.lock.json`](../../build/wasi-wit.lock.json). The lock currently selects WASI 0.2.3; the
[WASI 0.2.3 interface definitions][^wasi-023] are locked by file hash. The [WASI HTTP
definitions][^wasi-http] come from the corresponding `wasi-http` 0.2.3 release. The plugin API
version and the WASI version are separate compatibility inputs.

WIT is an interface-definition language for the WebAssembly Component Model. It describes
interfaces, functions, data types, resources, and the component's imports and exports. Generated
bindings lower those higher-level values through the Component Model's Canonical ABI. That ABI
defines how values cross a component boundary, including when values are passed directly and when
they are represented in linear memory. See the upstream [WIT description][^wit] and [Component
Model explainer][^canonical-abi].

## From plugin configuration to a WASI component

The build has several steps. The first four determine the component's declared WASI imports; the
last step leaves those imports for the Pumpkin runtime to resolve.

1. **The plugin opts into a capability bundle.** `pumpkinPlugin.wasi` in the plugin's
   `package.json` accepts the names `http`, `filesystem`, `sockets`, and `udp`. An omitted list
   means no WASI interfaces are added.
2. **The build retrieves pinned WIT definitions.** `@pumpkin-plugins/build` reads
   [`wasi-wit.lock.json`](../../build/wasi-wit.lock.json), downloads any missing upstream files,
   checks each file against its SHA-256 hash, and caches the verified files by WASI version. A
   complete cache needs no network access; the first build needs network access if the files are
   not already cached.
3. **The build prepares one WIT world.** It copies the Pumpkin API WIT into the plugin build
   directory, copies only the locked WASI files, then adds the selected `wasi:*` imports to the
   `plugin` world. The build records this prepared copy under the plugin's `build/wit/` directory.
4. **TypeScript declarations come from that world.** The build uses `jco guest-types` to generate
   declarations under `build/types/`. When type generation runs separately, it prepares the WIT in a
   temporary directory and removes the copy afterward. Those declarations let the editor and
   TypeScript check imported WASI modules and resource methods against the same WIT used for the
   component.
5. **esbuild replaces the external imports with facades.** Imports such as
   `wasi:http/outgoing-handler@0.2.3` remain external to the ordinary JavaScript bundle. For
   Static Hermes, an esbuild plugin checks that each imported interface is present in the prepared
   WIT world and generates an ES module facade from its declarations. TypeScript call analysis
   identifies which declared operations the plugin uses.
6. **The native adapters and component are built.** The build analyzes the plugin's typed source
   graph to identify called WIT methods. `wit-bindgen c` generates C bindings for the plugin world;
   the runtime generator emits JSI host functions and WASI adapters for selected operations.
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

The key source files are [`capabilities.ts`](../../build/src/capabilities.ts),
[`wasi-wit.ts`](../../build/src/wasi-wit.ts), [`wit.ts`](../../build/src/wit.ts),
[`bundle.ts`](../../build/src/bundle.ts), and the Static Hermes
[`WIT adapter generator`](../bin/wit-api.mjs). The interfaces and WIT imports follow the
[Component Model][^component-model], rather than the older WASI Preview 1 module ABI.

## Capability bundles

`pumpkinPlugin.wasi` uses a small set of repository-level names. Each name expands to the following
WASI 0.2.3 interfaces:

| Capability | Interfaces imported by the build |
| --- | --- |
| `http` | `wasi:http/types`, `wasi:http/outgoing-handler` |
| `filesystem` | `wasi:filesystem/types`, `wasi:filesystem/preopens` |
| `sockets` | `wasi:sockets/network`, `wasi:sockets/instance-network`, `wasi:sockets/tcp`, `wasi:sockets/tcp-create-socket` |
| `udp` | `wasi:sockets/network`, `wasi:sockets/instance-network`, `wasi:sockets/udp`, `wasi:sockets/udp-create-socket` |

When any capability is selected, the build also imports `wasi:io/poll`, `wasi:io/streams`, and
`wasi:clocks/monotonic-clock`. These are support interfaces shared by the current HTTP, filesystem,
and socket APIs. Selecting both `sockets` and `udp` deduplicates the shared network interfaces.

These names are bundles maintained by this repository, not every interface in the WASI standard.
The list is closed: a package cannot add an arbitrary capability string. An interface also brings
its WIT dependencies into the prepared world, but the build copies only the files listed in the
lock. The exact imports are visible in the generated `build/wit/plugin.wit` file.

For the currently locked WIT, the
[`wit-api-coverage` test](../test/wit-api-coverage.test.mjs) enumerates every function and resource
method in the four capability bundles and checks that the adapter generator can plan and emit each
operation. That is generator coverage for the checked-in WIT surface; it does not execute every
operation or prove that a particular Pumpkin release provides it. The lock and generated
declarations are the precise signature catalog.

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

```ts
import { handle } from 'wasi:http/outgoing-handler@0.2.3';
import { Fields, OutgoingRequest, RequestOptions } from 'wasi:http/types@0.2.3';
```

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

WASI 0.2.3 I/O commonly uses resource objects such as pollables, streams, and HTTP response
futures. In this API version, those named `future-*` resources are part of the WIT interface. They
are distinct from the Component Model's native `future<T>`, `stream<T>`, and `async` features
introduced for WASI 0.3.[^wasi-03] Code may need to advance operations through polling or other explicit
steps; the build does not turn them into browser `fetch` calls or JavaScript promises. The
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

This is a useful security boundary: WASI capabilities are explicit, and resource handles represent
specific host-provided resources rather than a global filesystem or network namespace. It also
means a plugin must handle absent mounts, permission denials, and host errors.

The Component Model and WASI specifications define the interface and capability model. They do not
make every host expose every interface or guarantee identical host behavior. Runtime support and
permissions must be verified against the Pumpkin server version used for deployment.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Build reports an unknown WASI capability | `pumpkinPlugin.wasi` accepts only `http`, `filesystem`, `sockets`, and `udp`. |
| TypeScript cannot resolve a `wasi:*` import | Confirm the matching capability is declared and regenerate guest declarations with the plugin's typecheck/build workflow. |
| Build says an interface is not imported by the plugin WIT world | The module import does not match the selected capability bundle or its locked WIT dependencies. |
| Build reports no Static Hermes adapter for an operation | Check the selected method's WIT input/result types against the converter in `wit-api.mjs`; add adapter support and coverage if the interface is being extended. |
| First build cannot download WIT files | The first build needs network access unless the verified WASI 0.2.3 files are already cached. Check the URL and SHA-256 entry in the lock. |
| Component builds but fails when loaded or called | Check that the Pumpkin server resolves the imported interface and that `info.permissions` grants the matching operation. Inspect the server's error for a denied host capability. |
| A WASI resource throws after use | Check ownership transfer and disposal paths. Do not reuse a consumed resource; release resources on success and error paths. |

## Benefits and trade-offs

### Benefits

- **A standard contract.** WIT gives the plugin, binding generator, and component host one typed
  interface description. The same contract is used to generate declarations, C bindings, and the
  Static Hermes JavaScript facade.
- **Explicit host access.** A component declares the interfaces it imports. WASI's capability
  design uses imported services and resource handles instead of ambient access.
- **Resource-aware APIs.** Files, sockets, streams, and HTTP request/response objects have explicit
  WIT resource lifetimes. The generated wrapper tracks drops and ownership transfers.
- **Pinned inputs.** Every WASI WIT file used by the build is versioned and hash-checked, so an
  upstream change cannot silently alter the contract on a later build.
- **Selective native glue.** When TypeScript usage analysis identifies the calls, Static Hermes
  generates adapters for the used WASI operations and the native linker can discard unreferenced
  sections.

### Trade-offs and limits

- **The supported surface is deliberately finite.** The build currently exposes four capability
  bundles and pins WASI 0.2.3. An interface or operation outside that surface needs build support,
  WIT inputs, and a Static Hermes adapter before plugin code can use it. The runtime README says
  “WASI 3 support is deferred”; the build path documented here remains pinned to 0.2.3, so that
  repository statement is not evidence that the runtime supports the now-released WASI 0.3
  interfaces.[^wasi-03]
- **The host remains part of the system.** A component can build successfully yet fail to link or
  run if the deployed Pumpkin host does not provide a compatible import or grant the required
  permission. WIT compatibility is necessary, not a host support guarantee.
- **The boundary has conversion work.** Calls pass through a JavaScript facade, JSI host function,
  native adapter, generated WIT binding, and component ABI. Strings and aggregate values require
  conversion; byte lists are copied into JavaScript typed arrays; records and lists can allocate
  JavaScript objects or arrays. Those are costs implied by the code path, not measured timings.
- **Small calls can expose fixed overhead.** A plugin that makes many tiny WASI calls may be more
  sensitive to boundary and conversion work than one that batches data. Long-running filesystem or
  network operations also include host and I/O time. Measure a representative plugin before
  drawing a performance conclusion.
- **Portability is interface-specific.** A standardized WIT surface does not mean every host
  implements every capability. Filesystem, socket, and HTTP behavior can depend on host support and
  permissions. WASI's own design documentation treats API availability and portability as
  interface-specific.[^wasi-principles]
- **I/O has explicit lifecycle requirements.** WASI resources must be released, and some operations
  advance through pollables or streams. Plugins need to manage partial progress, error cases, and
  cleanup rather than assuming a browser-style global API.

There are no WASI-call timing numbers in this guide. The repository's
[engine comparison](benchmarking.md) measures guest-side JavaScript workloads and selected Pumpkin
API behavior; it does not measure a WASI operation. Its engine ratios therefore cannot be used as
WASI boundary-throughput results. Performance statements above are implementation-based reasoning,
not benchmark findings.

## Runtime and CI maintainer guide

The build and adapter have separate sources of truth:

| Concern | Source |
| --- | --- |
| User-facing capability names and interface expansion | [`tools/build/src/capabilities.ts`](../../build/src/capabilities.ts) |
| WASI release, file list, hashes, alternate sources, generated WIT files | [`tools/build/wasi-wit.lock.json`](../../build/wasi-wit.lock.json) |
| Download, SHA-256 verification, and versioned cache | [`tools/build/src/wasi-wit.ts`](../../build/src/wasi-wit.ts) |
| Plugin-world imports and exact WIT file preparation | [`tools/build/src/wit.ts`](../../build/src/wit.ts) |
| TypeScript declarations from the prepared world | [`tools/build/src/types.ts`](../../build/src/types.ts) |
| TypeScript call analysis for used Pumpkin/WASI methods | [`tools/build/src/wit-method-usage.ts`](../../build/src/wit-method-usage.ts) |
| WIT parsing, facade generation, type conversion, resource ownership, feature selection, and JSI adapter generation | [`tools/static-hermes-runtime/bin/wit-api.mjs`](../bin/wit-api.mjs) |
| WASI C binding, feature flags, Hermes bytecode, and final component link | [`tools/static-hermes-runtime/bin/build-static-hermes.mjs`](../bin/build-static-hermes.mjs) |

When adding or upgrading an interface:

1. Confirm that the target Pumpkin runtime can provide the interface and that its WIT/API version is
   compatible.
2. Add or update only the pinned WIT files in `wasi-wit.lock.json`; preserve the upstream version
   and SHA-256 checks. The WASI HTTP package's files use the `wasi-http` source URL recorded in the
   lock.
3. Add the interface to a capability bundle in `capabilities.ts` and include its dependencies. Keep
   shared imports deduplicated.
4. Check that WIT feature-gated operations select their required `wit-bindgen` feature when used.
   The build derives these features from the selected operations.
5. Confirm that the Static Hermes converter supports the WIT parameter and result types. Unsupported
   operations fail the build with a missing-adapter diagnostic; extend the converter and ownership
   cleanup where required.
6. Update adapter fixtures and coverage. The
   [`wit-api-coverage` test](../test/wit-api-coverage.test.mjs) enumerates operations across the
   currently locked interfaces and verifies that the generator can plan and emit an adapter for
   each. The WASI WIT tests also cover imports, dependency resolution, resource handling, and feature
   selection.
7. Test actual host behavior on the target Pumpkin runtime. Adapter-generation tests prove that the
   build can generate bindings; they do not prove the server supplies an import, grants a
   permission, or implements an operation with the expected host behavior.

Keep the pinned `@pumpkinmc/pumpkin-api-ts` version aligned with the Pumpkin server plugin ABI as
documented in [Building](../../../docs/building.md). WASI versions have their own lock and host
compatibility requirements.

## References

### Repository implementation

- [Build and runtime caveats](../../../docs/building.md)
- [Plugin capability and permission setup](../../../docs/creating-a-plugin.md#files-and-network-access)
- [Static Hermes toolchain and runtime coverage](../README.md)
- [WASI HTTP request helper](../../../tools/update-check/src/http-request.ts)
- [WASI filesystem data helper](../../../tools/plugin-kit/src/data-dir.ts)
- [Pinned WASI WIT lock](../../build/wasi-wit.lock.json)

[^wasi-capabilities]: WebAssembly/WASI, [Capabilities](https://github.com/WebAssembly/WASI/blob/main/docs/Capabilities.md),
    on imported interfaces and capability-based access.
[^wasi-principles]: WebAssembly/WASI, [Design Principles](https://github.com/WebAssembly/WASI/blob/main/docs/DesignPrinciples.md),
    including capability security and portability.
[^wit]: WebAssembly Component Model, [WIT: The WebAssembly Interface Type](https://github.com/WebAssembly/component-model/blob/main/design/mvp/WIT.md).
[^canonical-abi]: WebAssembly Component Model, [Explainer: Canonical ABI](https://github.com/WebAssembly/component-model/blob/main/design/mvp/Explainer.md#canonical-abi),
    describing how component values cross the ABI boundary.
[^component-model]: WebAssembly Component Model, [design and overview](https://github.com/WebAssembly/component-model),
    including its component interface model.
[^wasi-023]: WebAssembly/WASI, [WASI 0.2.3 interface definitions](https://github.com/WebAssembly/WASI/tree/v0.2.3/wasip2).
[^wasi-http]: WebAssembly/wasi-http, [WASI HTTP 0.2.3 WIT definitions](https://github.com/WebAssembly/wasi-http/tree/v0.2.3/wit).
[^wasi-03]: WASI.dev, [WASI 0.3 release notes](https://wasi.dev/docs/releases/wasi-p3),
    describing native `async`, `future<T>`, and `stream<T>` support in the Component Model.
