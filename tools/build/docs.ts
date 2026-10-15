import { readFileSync } from 'node:fs';
import { code, table } from '@pumpkin-plugins/docs/markdown';
import type { DocumentSpec } from '@pumpkin-plugins/docs/node';

interface Provenance {
    cargoLockSha256: string;
    cargoVersion: string;
    cFlags: string;
    clangVersion: string;
    features: string;
    outputSha256: string;
    patchSha256: string;
    rustFlags: string;
    rustVersion: string;
    sdkVersion: string;
    sourceCommit: string;
    sourceRepository: string;
    target: string;
}

interface PackageManifest {
    engines?: { node?: string };
}

function readJson<T>(url: URL): T {
    return JSON.parse(readFileSync(url, 'utf8')) as T;
}

function requiredString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${label} must be a non-empty string`);
    }
    return value;
}

const provenance = readJson<Provenance>(new URL('./runtime/provenance.json', import.meta.url));
const packageManifest = readJson<PackageManifest>(new URL('./package.json', import.meta.url));
const buildScript = readFileSync(new URL('./runtime/build.sh', import.meta.url), 'utf8');

for (const key of [
    'cargoLockSha256',
    'cargoVersion',
    'cFlags',
    'clangVersion',
    'features',
    'outputSha256',
    'patchSha256',
    'rustFlags',
    'rustVersion',
    'sdkVersion',
    'sourceCommit',
    'sourceRepository',
    'target',
] as const) {
    requiredString(provenance[key], `runtime/provenance.json ${key}`);
}

const sdkMajor = buildScript.match(/WASI_SDK_PATH:\?[^\n]*wasi-sdk (\d+)/)?.[1];
if (sdkMajor === undefined) {
    throw new Error('runtime/build.sh must declare its required wasi-sdk major version');
}

for (const valueName of ['target', 'features', 'rustFlags', 'cFlags']) {
    if (!buildScript.includes(`value ${valueName}`)) {
        throw new Error(`runtime/build.sh must read ${valueName} from runtime/provenance.json`);
    }
}

if (!buildScript.includes('cargo build --locked') || !buildScript.includes('--release')) {
    throw new Error('runtime/build.sh must continue to use a locked release build');
}

const sdkVersion = provenance.sdkVersion.split(/\r?\n/, 1)[0];
const nodeEngine = requiredString(packageManifest.engines?.node, 'tools/build/package.json engines.node');
const sourceCommitUrl = `${provenance.sourceRepository.replace(/\.git$/, '')}/tree/${provenance.sourceCommit}`;
const rows = [
    ['Node.js engine', code(nodeEngine)],
    ['QuickJS source', `[${code(provenance.sourceCommit)}](${sourceCommitUrl})`],
    ['Source repository', code(provenance.sourceRepository)],
    ['BigInt patch SHA-256', code(provenance.patchSha256)],
    ['Cargo.lock SHA-256', code(provenance.cargoLockSha256)],
    ['Rust compiler', code(provenance.rustVersion)],
    ['Cargo', code(provenance.cargoVersion)],
    ['WASI SDK', `${code(sdkVersion)} (build script requires major ${code(sdkMajor)})`],
    ['Clang', code(provenance.clangVersion)],
    ['Target and feature', `${code(provenance.target)} / ${code(provenance.features)}`],
    ['Rust flags', code(provenance.rustFlags)],
    ['C flags', code(provenance.cFlags)],
    ['Shipped runtime SHA-256', code(provenance.outputSha256)],
];

const documents = [
    {
        file: 'runtime/README.md',
        blocks: {
            provenance: table(['Input', 'Pinned value'], rows),
            'source-checkout': [
                '```sh',
                `git clone ${provenance.sourceRepository} /tmp/componentize-qjs`,
                `git -C /tmp/componentize-qjs checkout --detach ${provenance.sourceCommit}`,
                '```',
            ].join('\n'),
        },
        note: '<!-- Generated from runtime/provenance.json, runtime/build.sh, and package.json. Run `pnpm --filter @pumpkin-plugins/build readme`. -->',
    },
] satisfies DocumentSpec[];

export { documents };
