import { readFileSync } from 'node:fs';
import { code, generatedBlocks, table } from '@pumpkin-plugins/docs/markdown';
import type { DocumentSpec } from '@pumpkin-plugins/docs/node';
import { CAPABILITIES, type Capability, WASI_VERSION, wasiInterfaces } from '../build/src/capabilities.ts';
import { PUMPKIN_RELEASE } from '../test-harness/src/pumpkin-version.ts';

interface ToolchainVersions {
    tools: Record<string, string>;
}

interface WasiPin {
    version: string;
}

interface WasiSdkPin {
    version: string;
}

interface RootPackage {
    devEngines?: {
        packageManager?: {
            version?: string;
        };
    };
}

/** Read a JSON source file used by generated runtime documentation. */
function readJson<T>(url: URL): T {
    return JSON.parse(readFileSync(url, 'utf8')) as T;
}

/** Return a required string value from a source file or fail generation with its source label. */
function requiredString(value: unknown, source: string): string {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${source} must provide a non-empty string`);
    return value;
}

/** Extract a pinned tool version from the shared Static Hermes setup action. */
function actionVersion(source: string, tool: 'cmake' | 'ninja'): string {
    const value = source.match(new RegExp(`echo "${tool}-version=([^"\\n]+)"`))?.[1];
    return requiredString(value, `.github/common/setup-static-hermes/action.yml (${tool} version)`);
}

/** Replace one maintained passage, and leave it alone when the generated version is already present. */
function replaceText(source: string, current: string, next: string, label: string, recognized = next): string {
    if (recognized.length > 0 && source.includes(recognized)) return source;
    const occurrences = source.split(current).length - 1;
    if (occurrences === 0 && recognized.length === 0) return source;
    if (occurrences !== 1) throw new Error(`${label}: expected one source passage, found ${occurrences}`);
    return source.replace(current, next);
}

/** Replace either the original passage or a previous generator version with the current passage. */
function updatePassage(source: string, current: string, previous: string, next: string, label: string): string {
    if (source.includes(next)) return source;
    const previousOccurrences = source.split(previous).length - 1;
    if (previousOccurrences > 0) {
        if (previousOccurrences !== 1)
            throw new Error(`${label}: expected one previous generated passage, found ${previousOccurrences}`);
        return source.replace(previous, next);
    }
    return replaceText(source, current, next, label);
}

/** Update a generated block without changing the surrounding handwritten Markdown. */
function updateBlock(source: string, name: string, body: string, note: string): string {
    const matches = generatedBlocks(source).filter((block) => block.name === name && block.markers === 'docs');
    if (matches.length !== 1)
        throw new Error(`Expected exactly one generated block named ${name}, found ${matches.length}`);
    const block = matches[0];
    const begin = `<!-- docs:begin ${name} -->`;
    const end = `<!-- docs:end ${name} -->`;
    return `${source.slice(0, block.start)}${begin}\n${note}\n\n${body}\n${end}${source.slice(block.end)}`;
}

/** Remove a section whose content has moved to a dedicated guide. */
function removeSection(source: string, heading: string, nextHeading: string): string {
    const begin = `\n## ${heading}\n`;
    const start = source.indexOf(begin);
    if (start < 0) return source;
    const end = source.indexOf(`\n## ${nextHeading}\n`, start + begin.length);
    if (end < 0) throw new Error(`Could not find the next section after ${heading}`);
    return `${source.slice(0, start)}${source.slice(end)}`;
}

const toolchain = readJson<ToolchainVersions>(new URL('./toolchain-versions.json', import.meta.url));
const wasiPin = readJson<WasiPin>(new URL('../build/wasi-wit.lock.json', import.meta.url));
const wasiSdkPin = readJson<WasiSdkPin>(new URL('./wasi-sdk.lock.json', import.meta.url));
if (WASI_VERSION !== wasiPin.version) {
    throw new Error(
        `WASI_VERSION (${WASI_VERSION}) does not match tools/build/wasi-wit.lock.json (${wasiPin.version})`,
    );
}

const rootPackage = readJson<RootPackage>(new URL('../../package.json', import.meta.url));
const nodeVersion = readFileSync(new URL('../../.node-version', import.meta.url), 'utf8').trim();
const pnpmVersion = rootPackage.devEngines?.packageManager?.version;
const setupAction = readFileSync(
    new URL('../../.github/common/setup-static-hermes/action.yml', import.meta.url),
    'utf8',
);
const externalConsumerWorkflow = readFileSync(
    new URL('../../.github/workflows/external-consumer.yml', import.meta.url),
    'utf8',
);

const workflowNodeVersion = externalConsumerWorkflow.match(/node-version:\s*([^\s]+)/)?.[1];
if (workflowNodeVersion !== nodeVersion) {
    throw new Error(
        `External-consumer Node pin (${workflowNodeVersion}) does not match .node-version (${nodeVersion})`,
    );
}

const workflowRustVersion = externalConsumerWorkflow.match(/rustup toolchain install ([^\s]+)/)?.[1];
if (workflowRustVersion !== toolchain.tools.rust) {
    throw new Error(
        `External-consumer Rust pin (${workflowRustVersion}) does not match toolchain-versions.json (${toolchain.tools.rust})`,
    );
}

const toolchainRows = [
    ['Node.js', nodeVersion],
    ['pnpm', requiredString(pnpmVersion, 'package.json devEngines.packageManager.version')],
    ['CMake', actionVersion(setupAction, 'cmake')],
    ['Ninja', actionVersion(setupAction, 'ninja')],
    ['Rust and Cargo', toolchain.tools.rust],
    ['wit-bindgen', toolchain.tools['wit-bindgen']],
    ['wasm-tools', toolchain.tools['wasm-tools']],
    ['WASI SDK', wasiSdkPin.version],
    ['Windows x64 MSVC toolset', externalConsumerWorkflow.match(/toolset:\s*'([^']+)'/)?.[1]],
].map(([name, version]) => [name, code(requiredString(version, `Static Hermes ${name} pin`))]);

const capabilityRows = Object.entries(CAPABILITIES).map(([capability, interfaces]) => [
    code(capability),
    interfaces.map((name) => code(`wasi:${name}@${WASI_VERSION}`)).join('\n'),
]);
const directInterfaces = new Set<string>(Object.values(CAPABILITIES).flat());
const supportImports = wasiInterfaces(Object.keys(CAPABILITIES) as Capability[]).filter(
    (name) => !directInterfaces.has(name),
);
const capabilityBundles = [
    table(['Capability', 'Interfaces imported by the build'], capabilityRows, { multiline: 'break' }),
    '',
    `Every selected capability also imports these support interfaces at version ${code(WASI_VERSION)}:`,
    `${supportImports.map((name) => code(`wasi:${name}@${WASI_VERSION}`)).join(', ')}.`,
    'The build deduplicates shared imports when bundles overlap.',
].join('\n');

const versionedHttpImports = [
    '```ts',
    `import { handle } from 'wasi:http/outgoing-handler@${WASI_VERSION}';`,
    `import { Fields, OutgoingRequest, RequestOptions } from 'wasi:http/types@${WASI_VERSION}';`,
    '```',
].join('\n');

const hostRelease = encodeURIComponent(PUMPKIN_RELEASE);
const hostImplementationUrl = `https://github.com/Pumpkin-MC/Pumpkin/blob/${hostRelease}/crates/pumpkin/src/plugin/loader/wasm/wasm_host/wit/v0_1/mob.rs`;
const customGoalHostLimit = [
    `The pinned Pumpkin host ${code(PUMPKIN_RELEASE)} does not start custom WASM AI goals: its eligibility methods return`,
    `${code('false')}, so gameplay does not invoke those callbacks. See the [host implementation](${hostImplementationUrl}).`,
].join('\n');

const toolchainNote =
    '<!-- Generated from .node-version, package.json, toolchain-versions.json, wasi-sdk.lock.json and Static Hermes CI pins. Run `pnpm readme`. -->';
const wasiNote =
    '<!-- Generated from tools/build/src/capabilities.ts and tools/build/wasi-wit.lock.json. Run `pnpm readme`. -->';

/** Update the README prose and toolchain table from their maintained source files. */
function updateReadme(source: string): string {
    let next = source;
    next = replaceText(
        next,
        [
            'This package supplies the Static Hermes backend for Pumpkin plugin components. It compiles bundled',
            'JavaScript to Hermes bytecode by default, with optional TypeScript parsing through `-parse-ts`, then',
            'links the bytecode, Hermes, the JSI shim, and generated Pumpkin/WASI bindings into a WebAssembly component. Static Hermes is the default engine;',
            'QuickJS remains available as an alternative.',
        ].join('\n'),
        [
            'This package supplies the Static Hermes backend for Pumpkin plugin components. It compiles bundled',
            'JavaScript to Hermes bytecode by default. Pass `--parse-ts` to parse a TypeScript bundle; Hermes',
            'marks that parser partial and unstable. The compiler links the bytecode with Hermes, the JSI shim,',
            'and generated Pumpkin/WASI bindings into a WebAssembly component. Static Hermes is the default',
            'engine, with QuickJS available as an alternative.',
        ].join('\n'),
        'README overview',
    );
    next = replaceText(
        next,
        'the WASI 2 CMake toolchain adjustment required by Hermes.',
        'the WASI Preview 2 CMake toolchain adjustment required by Hermes.',
        'README WASI SDK description',
    );
    next = replaceText(
        next,
        [
            'The external-consumer CI contract uses Node `24.21.0`, pnpm `12.11.2`, CMake `4.4.4`, Ninja',
            '`1.13.2`, Rust/Cargo `1.99.0`, `wit-bindgen` `0.62.0`, and WASI SDK `34`. Windows x64 uses the',
            'Visual Studio 2022 MSVC `14.44` toolset. Override the default `.cache/hermes/` location with',
            '`STATIC_HERMES_CACHE_DIR`; the packed-consumer check also keeps its pnpm store in a temporary',
            "directory outside the consumer's `node_modules`.",
        ].join('\n'),
        [
            'The external-consumer CI check uses these tool versions:',
            '',
            '<!-- docs:begin external-consumer-toolchain -->',
            '<!-- docs:end external-consumer-toolchain -->',
            '',
            'Set `STATIC_HERMES_CACHE_DIR` to change the default `.cache/hermes/` location. The packed-consumer',
            "check keeps its pnpm store in a temporary directory outside the consumer's `node_modules`.",
        ].join('\n'),
        'README external-consumer toolchain',
        'The external-consumer CI check uses these tool versions:',
    );
    next = updatePassage(
        next,
        [
            'The current imported WASI 0.2.3',
            'surface covers filesystem, HTTP, streams, clocks, TCP, UDP, and sockets. The build enables a',
            'feature-gated WIT operation when it is selected.',
        ].join('\n'),
        [
            'The imported interfaces are listed in the [WASI guide](docs/wasi.md#capability-bundles). The build enables a',
            'feature-gated WIT operation when it is selected.',
        ].join('\n'),
        [
            'The imported interfaces are listed in the',
            '[WASI guide](docs/wasi.md#capability-bundles). The build enables a',
            'feature-gated WIT operation when it is selected.',
        ].join('\n'),
        'README WASI imports',
    );
    next = replaceText(
        next,
        [
            'Static Hermes development builds bypass the shared automatic Market update check. WASI 3 support is',
            'deferred.',
        ].join('\n'),
        [
            'Static Hermes development builds bypass the shared automatic Market update check. See the',
            '[WASI guide](docs/wasi.md) for supported imports and runtime limits.',
        ].join('\n'),
        'README WASI runtime limits',
    );
    return updateBlock(next, 'external-consumer-toolchain', table(['Tool', 'Version'], toolchainRows), toolchainNote);
}

/** Keep user-facing runtime limits in the WASI guide and move implementation work to its maintainer page. */
function updateWasiGuide(source: string): string {
    let next = replaceText(
        source,
        "server may expose. This runtime targets WASI 0.2 interfaces; it does not implement WASI 0.3's native",
        "server may expose. This runtime does not implement WASI 0.3's native",
        'WASI runtime limit explanation',
    );
    next = updatePassage(
        next,
        [
            'WASI 0.2.3 I/O commonly uses resource objects such as pollables, streams, and HTTP response',
            'futures. In this API version, those named `future-*` resources are part of the WIT interface. They',
            "are distinct from the Component Model's native `future<T>`, `stream<T>`, and `async` features",
            'introduced for WASI 0.3.[^wasi-03] Code may need to advance operations through polling or other explicit',
            'steps; the build does not turn them into browser `fetch` calls or JavaScript promises. The',
        ].join('\n'),
        [
            'WASI 0.2 I/O commonly uses resource objects such as pollables, streams, and HTTP response futures.',
            'In this API, named `future-*` resources are part of the WIT interface. They are distinct from the',
            "Component Model's native `future<T>`, `stream<T>`, and `async` features in WASI 0.3.[^wasi-03] Code",
            'may need to advance operations through polling or other explicit steps; the build does not turn',
            'them into browser `fetch` calls or JavaScript promises. The',
        ].join('\n'),
        [
            'I/O through the imported interfaces commonly uses resource objects such as pollables, streams, and',
            'HTTP response futures. Named `future-*` resources are part of the WIT interface. They are distinct',
            "from the Component Model's native `future<T>`, `stream<T>`, and `async` features in WASI 0.3.[^wasi-03]",
            'Code may need to advance operations through polling or other explicit steps; the build does not',
            'turn them into browser `fetch` calls or JavaScript promises. The',
        ].join('\n'),
        'WASI I/O explanation',
    );
    next = replaceText(
        next,
        [
            'wrappers guard use after disposal or ownership transfer. Drop resources when finished, including',
            'error paths; `Symbol.dispose` is available for WASI resources that have a generated drop operation.',
        ].join('\n'),
        [
            'wrappers guard use after disposal or ownership transfer. Drop resources when finished, including',
            'error paths; `Symbol.dispose` is available for WASI resources that have a generated drop operation.',
            '',
            'Value conversion adds work at the boundary: byte lists are copied into typed arrays, and records or',
            'lists can allocate JavaScript objects or arrays. A plugin making many small WASI calls can be more',
            'sensitive to that cost than one that batches data; long-running operations also include host and I/O',
            "time. The repository's [engine comparison](../../../docs/benchmarking.md) measures guest-side",
            'JavaScript workloads and selected Pumpkin API behavior, not WASI calls. Its engine ratios do not',
            'describe WASI throughput. Measure a representative plugin against the target host before drawing a',
            'performance conclusion.',
        ].join('\n'),
        'WASI resource and performance limits',
    );
    next = replaceText(
        next,
        [
            'This is a useful security boundary: WASI capabilities are explicit, and resource handles represent',
            'specific host-provided resources rather than a global filesystem or network namespace. It also',
            'means a plugin must handle absent mounts, permission denials, and host errors.',
            '',
            'The Component Model and WASI specifications define the interface and capability model. They do not',
            'make every host expose every interface or guarantee identical host behavior. Runtime support and',
            'permissions must be verified against the Pumpkin server version used for deployment.',
        ].join('\n'),
        [
            'WASI imports and resource handles refer to specific host-provided resources. Plugins still need to',
            'handle missing mounts, denied permissions, and host errors. Standards define the interfaces; Pumpkin',
            'server releases determine which imports they resolve and which permissions they grant. Verify both',
            'on the server version you deploy.',
        ].join('\n'),
        'WASI host permission explanation',
    );
    next = replaceText(
        next,
        '| Build reports an unknown WASI capability | `pumpkinPlugin.wasi` accepts only `http`, `filesystem`, `sockets`, and `udp`. |',
        '| Build reports an unknown WASI capability | Choose a name from the [capability table](#capability-bundles). |',
        'WASI capability troubleshooting',
    );
    next = replaceText(
        next,
        "| Build reports no Static Hermes adapter for an operation | Check the selected method's resolved WIT input/result types and adapter plan in `src/wit/analysis.ts`; add adapter support and coverage if the interface is being extended. |\n",
        '',
        'WASI adapter troubleshooting',
    );
    next = replaceText(
        next,
        '| First build cannot download WIT files | The first build needs network access unless the verified WASI 0.2.3 files are already cached. Check the URL and SHA-256 entry in the lock. |',
        '| First build cannot download WIT files | The first build needs network access unless the pinned files are already cached. Check their URLs and SHA-256 entries in the lock. |',
        'WASI download troubleshooting',
    );
    next = removeSection(next, 'Benefits and trade-offs', 'Runtime and CI maintainer guide');
    next = removeSection(next, 'Runtime and CI maintainer guide', 'References');
    next = replaceText(
        next,
        '- [Pinned WASI WIT lock](../../build/wasi-wit.lock.json)',
        '- [Pinned WASI WIT lock](../../build/wasi-wit.lock.json)\n- [WASI maintenance guide](maintaining-wasi.md)',
        'WASI implementation references',
    );
    next = updatePassage(
        next,
        [
            '[^wasi-023]: WebAssembly/WASI, [WASI 0.2.3 interface definitions](https://github.com/WebAssembly/WASI/tree/v0.2.3/wasip2).',
            '[^wasi-http]: WebAssembly/wasi-http, [WASI HTTP 0.2.3 WIT definitions](https://github.com/WebAssembly/wasi-http/tree/v0.2.3/wit).',
            '[^wasi-03]: WASI.dev, [WASI 0.3 release notes](https://wasi.dev/docs/releases/wasi-p3),',
            '    describing native `async`, `future<T>`, and `stream<T>` support in the Component Model.',
        ].join('\n'),
        '[^wasi-03]: WASI.dev, [WASI 0.3 release notes](https://wasi.dev/releases/wasi-p3), describing native `async`, `future<T>`, and `stream<T>` support in the Component Model.',
        [
            '[^wasi-03]: WASI.dev, [WASI 0.3 release notes](https://wasi.dev/releases/wasi-p3), describing native',
            '    `async`, `future<T>`, and `stream<T>` support in the Component Model.',
        ].join('\n'),
        'WASI references',
    );
    next = updateBlock(next, 'capability-bundles', capabilityBundles, wasiNote);
    return updateBlock(next, 'versioned-http-imports', versionedHttpImports, wasiNote);
}

/** Documentation facts derived from Static Hermes toolchain, capability and runtime pins. */
export const documents = [
    {
        file: 'README.md',
        transform: updateReadme,
    },
    {
        file: 'docs/index.md',
        blocks: {
            'custom-goal-host-limit': customGoalHostLimit,
        },
        note: '<!-- Generated from tools/test-harness/src/pumpkin-version.ts. Run `pnpm readme`. -->',
    },
    {
        file: 'docs/wasi.md',
        transform: updateWasiGuide,
    },
] satisfies DocumentSpec[];
