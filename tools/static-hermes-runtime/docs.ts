import { readFileSync } from 'node:fs';
import { code, table } from '@pumpkin-plugins/docs/markdown';
import type { DocumentSpec } from '@pumpkin-plugins/docs/node';
import { CAPABILITIES, type Capability, WASI_VERSION, wasiInterfaces } from '@pumpkin-plugins/wasi-capabilities';
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
const externalConsumerWorkflow = readFileSync(
    new URL('../../.github/workflows/external-consumer.yml', import.meta.url),
    'utf8',
);

const toolchainRows = [
    ['Node.js', nodeVersion],
    ['pnpm', requiredString(pnpmVersion, 'package.json devEngines.packageManager.version')],
    ['CMake', toolchain.tools.cmake],
    ['Ninja', toolchain.tools.ninja],
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
    '<!-- Generated from tools/wasi-capabilities/src/index.ts and tools/build/wasi-wit.lock.json. Run `pnpm readme`. -->';

/** Documentation facts derived from Static Hermes toolchain, capability and runtime pins. */
export const documents = [
    {
        file: 'README.md',
        blocks: {
            'external-consumer-toolchain': table(['Tool', 'Version'], toolchainRows),
        },
        note: toolchainNote,
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
        blocks: {
            'capability-bundles': capabilityBundles,
            'versioned-http-imports': versionedHttpImports,
        },
        note: wasiNote,
    },
] satisfies DocumentSpec[];
