import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');
let consumer: string;

beforeAll(() => {
    consumer = mkdtempSync(join(tmpdir(), 'build-capabilities-consumer-'));
    execFileSync('pnpm', ['pack', '--pack-destination', consumer], { cwd: packageRoot, stdio: 'pipe' });
    const tarball = readdirSync(consumer).find((file) => file.endsWith('.tgz'));
    if (!tarball) throw new Error('Builder pack did not produce a tarball');
    const installedPackage = join(consumer, 'node_modules/@pumpkin-plugins/build');
    mkdirSync(installedPackage, { recursive: true });
    execFileSync('tar', ['-xzf', join(consumer, tarball), '--strip-components=1', '-C', installedPackage]);
}, 60_000);

afterAll(() => {
    if (consumer) rmSync(consumer, { recursive: true, force: true });
});

function query(interfacePath: string): string[] {
    const output = execFileSync(
        process.execPath,
        [
            '--input-type=module',
            '--eval',
            `import { capabilitiesForInterface } from '@pumpkin-plugins/build/capabilities';
console.log(JSON.stringify(capabilitiesForInterface(${JSON.stringify(interfacePath)})));`,
        ],
        { cwd: consumer, encoding: 'utf8', stdio: 'pipe' },
    );
    return JSON.parse(output);
}

describe('packed capabilities API', () => {
    it('identifies the unique HTTP capability without loading the builder CLI or its dependencies', () => {
        expect(query('http/types')).toEqual(['http']);
    });

    it.each([
        ['http/outgoing-handler', 'http'],
        ['filesystem/types', 'filesystem'],
        ['filesystem/preopens', 'filesystem'],
        ['sockets/tcp', 'sockets'],
        ['sockets/tcp-create-socket', 'sockets'],
        ['sockets/udp', 'udp'],
        ['sockets/udp-create-socket', 'udp'],
    ])('identifies the unique capability for %s', (interfacePath, capability) => {
        expect(query(interfacePath)).toEqual([capability]);
    });

    it.each(['sockets/network', 'sockets/instance-network'])(
        'returns both network capabilities for %s',
        (interfacePath) => {
            expect(query(interfacePath)).toEqual(['sockets', 'udp']);
        },
    );

    it.each(['io/poll', 'io/streams', 'clocks/monotonic-clock'])(
        'returns every candidate for the shared support interface %s',
        (interfacePath) => {
            expect(query(interfacePath)).toEqual(['http', 'filesystem', 'sockets', 'udp']);
        },
    );

    it.each(['unknown/interface', 'http', '', 'toString', 'wasi:http/types@0.2.3'])(
        'does not guess a capability for %j',
        (interfacePath) => {
            expect(query(interfacePath)).toEqual([]);
        },
    );

    it.each(['NodeNext', 'Bundler'])(
        'ships declarations resolvable with %s',
        (moduleResolution) => {
            writeFileSync(
                join(consumer, 'consumer.mts'),
                `import { type Capability, capabilitiesForInterface } from '@pumpkin-plugins/build/capabilities';
const matches: Capability[] = capabilitiesForInterface('http/types');
// @ts-expect-error Capabilities must be known manifest names.
const invalid: Capability = 'network';
// @ts-expect-error Interface paths must be strings.
capabilitiesForInterface(123);
`,
            );
            writeFileSync(
                join(consumer, 'tsconfig.json'),
                JSON.stringify({
                    compilerOptions: {
                        module: moduleResolution === 'NodeNext' ? 'NodeNext' : 'ESNext',
                        moduleResolution,
                        target: 'ES2022',
                        strict: true,
                        noEmit: true,
                        types: [],
                    },
                    files: ['consumer.mts'],
                }),
            );
            expect(() =>
                execFileSync(process.execPath, [join(packageRoot, 'node_modules/typescript/bin/tsc'), '-p', consumer], {
                    cwd: consumer,
                    encoding: 'utf8',
                    stdio: 'pipe',
                    timeout: 25_000,
                }),
            ).not.toThrow();
        },
        30_000,
    );
});
