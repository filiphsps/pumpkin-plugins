import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getNpmRegistryIntegrity, npmDistTag, publishToolPackages } from './publish-tool-packages.mjs';
import { nodeEngineRange } from './utils/tool-packages.mjs';

const roots = [];
const API_PATH = 'tools/api';
const API_NAME = '@example/api';
const RUNTIME_PATH = 'tools/runtime';
const RUNTIME_NAME = '@example/runtime';
const BUILD_PATH = 'tools/build';
const BUILD_NAME = '@example/build';
const STARTER_PATH = 'tools/starter';
const STARTER_NAME = '@example/starter';
const toolManifests = {
    [API_PATH]: { name: API_NAME, version: '1.2.3' },
    [RUNTIME_PATH]: { name: RUNTIME_NAME, version: '1.3.4' },
    [BUILD_PATH]: {
        name: BUILD_NAME,
        version: '2.3.4',
        dependencies: { [API_NAME]: '1.2.3', [RUNTIME_NAME]: '1.3.4' },
    },
    'tools/docs': { name: '@example/docs', version: '6.6.7' },
    'tools/config': { name: '@example/config', version: '7.8.9', dependencies: { '@example/docs': '6.6.7' } },
    'tools/update': {
        name: '@example/update',
        version: '8.9.10',
        dependencies: { '@example/docs': '6.6.7', [API_NAME]: '1.2.3' },
    },
    'tools/kit': {
        name: '@example/kit',
        version: '9.10.11',
        dependencies: { '@example/docs': '6.6.7', [API_NAME]: '1.2.3', '@example/update': '8.9.10' },
    },
    [STARTER_PATH]: { name: STARTER_NAME, version: '3.4.5' },
};
const versions = Object.fromEntries(
    Object.entries(toolManifests).map(([packagePath, manifest]) => [packagePath, manifest.version]),
);
const toolNames = Object.fromEntries(
    Object.entries(toolManifests).map(([packagePath, manifest]) => [packagePath, manifest.name]),
);

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-tool-packages-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, '.node-version'), '24.21.0\n');
    for (const [packagePath, sourceManifest] of Object.entries(toolManifests)) {
        const packageJson = {
            ...sourceManifest,
            publishConfig: { access: 'public' },
            engines: { node: nodeEngineRange(root) },
        };
        const file = path.join(root, packagePath, 'package.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(packageJson, null, 4)}\n`);
    }
    for (const language of ['typed', 'plain']) {
        const directory = path.join(root, STARTER_PATH, 'templates', language);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(
            path.join(directory, 'package.json'),
            JSON.stringify({
                name: `${language}-fixture`,
                dependencies: { [API_NAME]: '^1.2.3', [BUILD_NAME]: '^2.3.4' },
            }),
        );
    }
    return root;
}

function createReleaseMetadata(selectedPaths, overrides = {}) {
    return Object.fromEntries(
        selectedPaths.map((packagePath) => [
            `${packagePath}--tag_name`,
            overrides[packagePath] ?? `${path.basename(packagePath)}-v${versions[packagePath]}`,
        ]),
    );
}

function packForRoot(root, packagePath, overrides = {}) {
    const source = JSON.parse(fs.readFileSync(path.join(root, packagePath, 'package.json'), 'utf8'));
    const embeddedPackageJsons =
        packagePath === STARTER_PATH
            ? ['typed', 'plain'].map((language) =>
                  JSON.parse(
                      fs.readFileSync(path.join(root, STARTER_PATH, 'templates', language, 'package.json'), 'utf8'),
                  ),
              )
            : [];
    return {
        tarballPath: `/fake/${packagePath.replaceAll('/', '-')}.tgz`,
        packageJson: { ...source, ...overrides.packageJson },
        entries: overrides.entries ?? ['package/package.json'],
        embeddedPackageJsons: overrides.embeddedPackageJsons ?? embeddedPackageJsons,
        integrity: overrides.integrity ?? `sha512-${Buffer.from(packagePath).toString('base64')}`,
    };
}

function createPackAdapter(root, order = []) {
    return async (packagePath) => {
        order.push(packagePath);
        return packForRoot(root, packagePath);
    };
}

describe('publishToolPackages', () => {
    it('runs npm publish from the tarball directory outside the repository root', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-publish-cwd-'));
        roots.push(directory);
        const tarballDirectory = path.join(directory, 'tarball');
        const binaryDirectory = path.join(directory, 'bin');
        const tarballPath = path.join(tarballDirectory, 'package.tgz');
        const recordPath = path.join(directory, 'npm-publish-record');
        fs.mkdirSync(tarballDirectory);
        fs.mkdirSync(binaryDirectory);
        const npmPath = path.join(binaryDirectory, 'npm');
        fs.writeFileSync(
            npmPath,
            '#!/bin/sh\n{ printf "%s\\n" "$PWD"; printf "%s\\n" "$@"; } > "$NPM_PUBLISH_RECORD"\n',
        );
        fs.chmodSync(npmPath, 0o755);

        const moduleUrl = new URL('./publish-tool-packages.mjs', import.meta.url).href;
        const call = `import { publishNpmTarball } from ${JSON.stringify(moduleUrl)};\npublishNpmTarball(${JSON.stringify({ tarballPath, distTag: 'backfill' })});`;
        const result = spawnSync(process.execPath, ['--input-type=module', '--eval', call], {
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${binaryDirectory}${path.delimiter}${process.env.PATH}`,
                NPM_PUBLISH_RECORD: recordPath,
            },
        });

        assert.equal(result.status, 0, result.stderr);
        const [workingDirectory, ...args] = fs.readFileSync(recordPath, 'utf8').trimEnd().split('\n');
        assert.equal(fs.realpathSync(workingDirectory), fs.realpathSync(tarballDirectory));
        assert.deepEqual(args, ['publish', tarballPath, '--access', 'public', '--provenance', '--tag', 'backfill']);
    });

    it('moves latest only for a version above the current latest release', () => {
        assert.equal(npmDistTag('0.1.0', undefined), 'latest');
        assert.equal(npmDistTag('0.2.0', '0.1.5'), 'latest');
        assert.equal(npmDistTag('0.1.10', '0.1.9'), 'latest');
        assert.equal(npmDistTag('0.1.3', '0.1.5'), 'backfill');
        assert.equal(npmDistTag('0.1.9', '0.1.10'), 'backfill');
        assert.equal(npmDistTag('0.2.0+build-1', '0.1.5'), 'latest');
        assert.throws(() => npmDistTag('0.2.0-rc.1', '0.1.5'), /prerelease/);
    });

    it('reads an exact version integrity from one npm packument request', async () => {
        const packageName = API_NAME;
        const packageUrl = 'https://registry.npmjs.org/%40example%2Fapi';
        const packument = (versions) => ({
            status: 200,
            ok: true,
            json: async () => ({ name: packageName, versions }),
        });
        const queuedFetch = (...responses) => {
            const requestedUrls = [];
            return {
                requestedUrls,
                fetch: async (url) => {
                    requestedUrls.push(url);
                    return responses.shift();
                },
            };
        };

        const missingVersion = queuedFetch(packument({ '1.2.2': {} }));
        assert.equal(await getNpmRegistryIntegrity(packageName, '1.2.3', missingVersion.fetch), null);
        assert.deepEqual(missingVersion.requestedUrls, [packageUrl]);

        const existingVersion = queuedFetch(
            packument({ '1.2.3': { name: packageName, version: '1.2.3', dist: { integrity: 'sha512-existing' } } }),
        );
        assert.equal(await getNpmRegistryIntegrity(packageName, '1.2.3', existingVersion.fetch), 'sha512-existing');
        assert.deepEqual(existingVersion.requestedUrls, [packageUrl]);

        const missingPackage = queuedFetch({ status: 404 });
        await assert.rejects(
            getNpmRegistryIntegrity(packageName, '1.2.3', missingPackage.fetch),
            /package .* was not found.*refusing to publish/i,
        );

        for (const status of [401, 403, 429, 500]) {
            const failedLookup = queuedFetch({ status, ok: false, statusText: 'Failure' });
            await assert.rejects(
                getNpmRegistryIntegrity(packageName, '1.2.3', failedLookup.fetch),
                new RegExp(`HTTP ${status}`),
            );
        }
        const malformedVersion = queuedFetch(packument({ '1.2.3': { name: packageName, version: '1.2.3', dist: {} } }));
        await assert.rejects(
            getNpmRegistryIntegrity(packageName, '1.2.3', malformedVersion.fetch),
            /no valid dist\.integrity/,
        );
        const mismatchedVersion = queuedFetch(
            packument({ '1.2.3': { name: packageName, version: '9.9.9', dist: { integrity: 'sha512-some-bytes' } } }),
        );
        await assert.rejects(
            getNpmRegistryIntegrity(packageName, '1.2.3', mismatchedVersion.fetch),
            /registry response identifies .* rather than @example\/api@1\.2\.3/,
        );
    });

    it('packs and publishes selected tools after their declared prerequisites', async () => {
        const root = createRoot();
        const packedPaths = [];
        const publishedPaths = [];
        const selectedPaths = [BUILD_PATH, RUNTIME_PATH, API_PATH];

        await publishToolPackages({
            root,
            selectedPaths,
            releaseMetadata: createReleaseMetadata(selectedPaths),
            packPackage: createPackAdapter(root, packedPaths),
            getRegistryIntegrity: async () => null,
            publishPackage: async ({ packagePath }) => publishedPaths.push(packagePath),
            log: () => {},
        });

        assert.deepEqual(new Set(packedPaths), new Set(selectedPaths));
        assert.deepEqual(publishedPaths, packedPaths);
        assert.ok(packedPaths.indexOf(API_PATH) < packedPaths.indexOf(BUILD_PATH));
        assert.ok(packedPaths.indexOf(RUNTIME_PATH) < packedPaths.indexOf(BUILD_PATH));
    });

    it('rejects a Release Please tag with a component that does not match its path', async () => {
        const root = createRoot();
        let packed = false;

        await assert.rejects(
            publishToolPackages({
                root,
                selectedPaths: [API_PATH],
                releaseMetadata: createReleaseMetadata([API_PATH], {
                    [API_PATH]: 'build-v1.2.3',
                }),
                packPackage: async () => {
                    packed = true;
                },
                getRegistryIntegrity: async () => null,
                publishPackage: async () => {},
                log: () => {},
            }),
            /tools\/api.*build-v1\.2\.3.*component/i,
        );
        assert.equal(packed, false);
    });

    it('validates packages from an explicitly selected release source checkout', () => {
        const root = createRoot();
        const result = spawnSync(
            process.execPath,
            [fileURLToPath(new URL('./publish-tool-packages.mjs', import.meta.url))],
            {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    PUMPKIN_PUBLIC_TOOL_ROOT: root,
                    RELEASED_TOOL_PATHS: JSON.stringify([API_PATH]),
                    RELEASE_METADATA: JSON.stringify(createReleaseMetadata([API_PATH], { [API_PATH]: 'build-v1.2.3' })),
                },
            },
        );

        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /tools\/api release tag build-v1\.2\.3 must use component api/);
    });

    it('rejects a Release Please tag version that differs from the source manifest', async () => {
        const root = createRoot();
        const selectedPaths = [API_PATH];

        await assert.rejects(
            publishToolPackages({
                root,
                selectedPaths,
                releaseMetadata: createReleaseMetadata(selectedPaths, {
                    [API_PATH]: 'api-v9.9.9',
                }),
                packPackage: createPackAdapter(root),
                getRegistryIntegrity: async () => null,
                publishPackage: async () => {},
                log: () => {},
            }),
            /@example\/api@9\.9\.9.*source manifest version 1\.2\.3/,
        );
    });

    it('rejects a packed manifest version that differs from the verified release tag', async () => {
        const root = createRoot();
        const selectedPaths = [API_PATH];
        let published = false;

        await assert.rejects(
            publishToolPackages({
                root,
                selectedPaths,
                releaseMetadata: createReleaseMetadata(selectedPaths),
                packPackage: async (packagePath) =>
                    packForRoot(root, packagePath, { packageJson: { version: '1.2.2' } }),
                getRegistryIntegrity: async () => null,
                publishPackage: async () => {
                    published = true;
                },
                log: () => {},
            }),
            /@example\/api@1\.2\.3.*packed manifest version 1\.2\.2/,
        );
        assert.equal(published, false);
    });

    it('requires builder and creator prerequisites at their exact packed versions', async () => {
        const root = createRoot();
        const selectedPaths = [BUILD_PATH];
        const requested = [];
        const expectedPrerequisites = Object.entries(toolManifests[BUILD_PATH].dependencies).map(
            ([packageName, version]) => `${packageName}@${version}`,
        );

        await assert.rejects(
            publishToolPackages({
                root,
                selectedPaths,
                releaseMetadata: createReleaseMetadata(selectedPaths),
                packPackage: createPackAdapter(root),
                getRegistryIntegrity: async (packageName, version) => {
                    requested.push(`${packageName}@${version}`);
                    return packageName === API_NAME ? 'sha512-api' : null;
                },
                waitForRegistry: async () => {},
                publishPackage: async () => {},
                log: () => {},
            }),
            /@example\/runtime@1\.3\.4.*required by @example\/build@2\.3\.4.*not found/i,
        );

        assert.deepEqual(requested[0], expectedPrerequisites[0]);
        assert.deepEqual(requested.slice(1), Array(8).fill(expectedPrerequisites[1]));
    });

    it('checks each consumer against its declared public dependencies', async () => {
        for (const packagePath of ['tools/config', 'tools/update', 'tools/kit']) {
            const root = createRoot();
            const requested = [];
            const expectedPrerequisites = Object.entries(toolManifests[packagePath].dependencies).map(
                ([packageName, version]) => `${packageName}@${version}`,
            );

            await publishToolPackages({
                root,
                selectedPaths: [packagePath],
                releaseMetadata: createReleaseMetadata([packagePath]),
                packPackage: createPackAdapter(root),
                getRegistryIntegrity: async (packageName, version) => {
                    if (packageName === toolNames[packagePath]) return null;
                    requested.push(`${packageName}@${version}`);
                    return 'sha512-present';
                },
                publishPackage: async () => {},
                log: () => {},
            });

            assert.deepEqual(requested, expectedPrerequisites);
        }
    });

    it('waits for a newly published prerequisite to appear before publishing its dependent', async () => {
        const root = createRoot();
        const packagePath = 'tools/kit';
        const prerequisite = '@example/update@8.9.10';
        const responses = new Map([
            ['@example/docs@6.6.7', ['sha512-docs']],
            [`${API_NAME}@1.2.3`, ['sha512-api']],
            [prerequisite, [null, 'sha512-update']],
            [`${toolNames[packagePath]}@${versions[packagePath]}`, [null]],
        ]);
        const requested = [];
        const published = [];
        const waits = [];

        await publishToolPackages({
            root,
            selectedPaths: [packagePath],
            releaseMetadata: createReleaseMetadata([packagePath]),
            packPackage: createPackAdapter(root),
            getRegistryIntegrity: async (packageName, version) => {
                const key = `${packageName}@${version}`;
                requested.push(key);
                return responses.get(key)?.shift() ?? null;
            },
            waitForRegistry: async (delayMs) => waits.push(delayMs),
            publishPackage: async ({ packageName, version }) => published.push(`${packageName}@${version}`),
            log: () => {},
        });

        assert.deepEqual(requested, [
            '@example/docs@6.6.7',
            `${API_NAME}@1.2.3`,
            prerequisite,
            prerequisite,
            `${toolNames[packagePath]}@${versions[packagePath]}`,
        ]);
        assert.deepEqual(published, [`${toolNames[packagePath]}@${versions[packagePath]}`]);
        assert.deepEqual(waits, [2_000]);
    });

    it('checks each embedded project manifest before publishing its package', async () => {
        const root = createRoot();
        const selectedPaths = [STARTER_PATH];
        const requested = [];

        await assert.rejects(
            publishToolPackages({
                root,
                selectedPaths,
                releaseMetadata: createReleaseMetadata(selectedPaths),
                packPackage: async (packagePath) =>
                    packForRoot(root, packagePath, {
                        embeddedPackageJsons: [
                            {
                                dependencies: {
                                    [API_NAME]: '^1.2.3',
                                    [BUILD_NAME]: '^2.3.4',
                                },
                            },
                            {
                                dependencies: {
                                    [API_NAME]: '^1.2.2',
                                    [BUILD_NAME]: '^2.3.4',
                                },
                            },
                        ],
                    }),
                getRegistryIntegrity: async (packageName, version) => {
                    requested.push(`${packageName}@${version}`);
                    return 'sha512-present';
                },
                publishPackage: async () => {},
                log: () => {},
            }),
            /template dependency must be \^1\.2\.3.*received \^1\.2\.2/,
        );
        assert.deepEqual(requested, []);
    });

    it('publishes only after a definitive exact-version not-found result', async () => {
        const root = createRoot();
        const selectedPaths = [API_PATH];
        const lookups = [];
        const published = [];

        await publishToolPackages({
            root,
            selectedPaths,
            releaseMetadata: createReleaseMetadata(selectedPaths),
            packPackage: createPackAdapter(root),
            getRegistryIntegrity: async (packageName, version) => {
                lookups.push(`${packageName}@${version}`);
                return null;
            },
            publishPackage: async ({ packageName, version }) => published.push(`${packageName}@${version}`),
            log: () => {},
        });

        assert.deepEqual(lookups, [`${API_NAME}@1.2.3`]);
        assert.deepEqual(published, [`${API_NAME}@1.2.3`]);
    });

    it('does not publish after an authorization, network, or registry error', async () => {
        const root = createRoot();
        const selectedPaths = [API_PATH];
        let published = false;

        await assert.rejects(
            publishToolPackages({
                root,
                selectedPaths,
                releaseMetadata: createReleaseMetadata(selectedPaths),
                packPackage: createPackAdapter(root),
                getRegistryIntegrity: async () => {
                    throw new Error('HTTP 429 Too Many Requests');
                },
                publishPackage: async () => {
                    published = true;
                },
                log: () => {},
            }),
            /@example\/api@1\.2\.3.*HTTP 429 Too Many Requests/,
        );
        assert.equal(published, false);
    });

    it('accepts a same-version retry only when registry SRI matches the packed tarball', async () => {
        const root = createRoot();
        const selectedPaths = [API_PATH];
        const expectedIntegrity = `sha512-${Buffer.from(API_PATH).toString('base64')}`;
        let published = false;

        await publishToolPackages({
            root,
            selectedPaths,
            releaseMetadata: createReleaseMetadata(selectedPaths),
            packPackage: createPackAdapter(root),
            getRegistryIntegrity: async () => expectedIntegrity,
            publishPackage: async () => {
                published = true;
            },
            log: () => {},
        });
        assert.equal(published, false);
    });

    it('fails when a same-version registry SRI differs from the packed tarball', async () => {
        const root = createRoot();
        const selectedPaths = [API_PATH];
        let published = false;

        await assert.rejects(
            publishToolPackages({
                root,
                selectedPaths,
                releaseMetadata: createReleaseMetadata(selectedPaths),
                packPackage: createPackAdapter(root),
                getRegistryIntegrity: async () => 'sha512-different',
                publishPackage: async () => {
                    published = true;
                },
                log: () => {},
            }),
            /@example\/api@1\.2\.3.*integrity mismatch/,
        );
        assert.equal(published, false);
    });

    it('rejects unknown and duplicate release paths before packing', async () => {
        const root = createRoot();
        let packed = false;

        for (const selectedPaths of [['tools/not-public'], [API_PATH, API_PATH]]) {
            await assert.rejects(
                publishToolPackages({
                    root,
                    selectedPaths,
                    releaseMetadata: {},
                    packPackage: async () => {
                        packed = true;
                    },
                    getRegistryIntegrity: async () => null,
                    publishPackage: async () => {},
                    log: () => {},
                }),
                /unknown public tool release path|duplicate public tool release path/,
            );
        }
        assert.equal(packed, false);
    });
});
