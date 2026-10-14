import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { getNpmRegistryIntegrity, publishToolPackages } from './publish-tool-packages.mjs';
import { PUBLIC_TOOL_PACKAGE_PATHS, PUBLIC_TOOL_RELEASE_ORDER } from './utils/tool-packages.mjs';

const roots = [];
const versions = {
    'tools/pumpkin-api': '1.2.3',
    'tools/static-hermes-runtime': '1.3.4',
    'tools/build': '2.3.4',
    'tools/create-pumpkin-plugin': '3.4.5',
    'tools/codemod': '4.5.6',
    'tools/cspell-dict-minecraft': '5.6.7',
};
const expectedEntries = {
    'tools/create-pumpkin-plugin': [
        'package/bin/create-pumpkin-plugin.ts',
        'package/dist/create-pumpkin-plugin.js',
        'package/templates/typescript/package.json',
        'package/templates/javascript/package.json',
    ],
    'tools/pumpkin-api': [
        'package/src/index.ts',
        'package/src/wit.mjs',
        'package/src/wit.d.mts',
        'package/wit.lock.json',
    ],
    'tools/static-hermes-runtime': [
        'package/src/index.ts',
        'package/dist/index.js',
        'package/cmake/wasi-sdk-hermes-p2.cmake',
        'package/hermes-patches/0001-wasi-p2-configure-platform.patch',
    ],
    'tools/build': ['package/dist/cli.js', 'package/runtime/quickjs-runtime-bigint.wasm', 'package/wasi-wit.lock.json'],
    'tools/codemod': [
        'package/dist/bin/pumpkin-codemod.js',
        'package/dist/src/index.js',
        'package/dist/src/index.d.ts',
        'package/README.md',
        'package/docs/using-codemods.md',
        'package/docs/authoring-codemods.md',
    ],
    'tools/cspell-dict-minecraft': [
        'package/cspell-ext.json',
        'package/minecraft.txt',
        'package/README.md',
        'package/LICENSE',
    ],
};

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-tool-packages-'));
    roots.push(root);
    for (const [packagePath, packageName] of Object.entries(PUBLIC_TOOL_PACKAGE_PATHS)) {
        const packageJson = {
            name: packageName,
            version: versions[packagePath],
            private: false,
            publishConfig: { access: 'public' },
            engines: { node: '>=24.21.0' },
        };
        if (packagePath === 'tools/build') {
            packageJson.dependencies = {
                '@pumpkin-plugins/pumpkin-api': versions['tools/pumpkin-api'],
                '@pumpkin-plugins/static-hermes-runtime': versions['tools/static-hermes-runtime'],
            };
        }
        const file = path.join(root, packagePath, 'package.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(packageJson, null, 4)}\n`);
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
    const starterTemplatePackageJsons =
        packagePath === 'tools/create-pumpkin-plugin'
            ? ['typescript', 'javascript'].map(() => ({
                  dependencies: {
                      '@pumpkin-plugins/pumpkin-api': `^${versions['tools/pumpkin-api']}`,
                      '@pumpkin-plugins/build': `^${versions['tools/build']}`,
                  },
              }))
            : [];
    return {
        tarballPath: `/fake/${packagePath.replaceAll('/', '-')}.tgz`,
        packageJson: { ...source, ...overrides.packageJson },
        entries: overrides.entries ?? expectedEntries[packagePath],
        starterTemplatePackageJsons: overrides.starterTemplatePackageJsons ?? starterTemplatePackageJsons,
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
    it('returns missing only for an exact-version 404 after confirming the npm package exists', async () => {
        const packageName = '@pumpkin-plugins/pumpkin-api';
        const packageUrl = 'https://registry.npmjs.org/%40pumpkin-plugins%2Fpumpkin-api';
        const versionUrl = `${packageUrl}/1.2.3`;
        const packageExists = {
            status: 200,
            ok: true,
            json: async () => ({ name: packageName }),
        };
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

        const missingVersion = queuedFetch(packageExists, { status: 404 });
        assert.equal(await getNpmRegistryIntegrity(packageName, '1.2.3', missingVersion.fetch), null);
        assert.deepEqual(missingVersion.requestedUrls, [packageUrl, versionUrl]);

        const existingVersion = queuedFetch(packageExists, {
            status: 200,
            ok: true,
            json: async () => ({
                name: packageName,
                version: '1.2.3',
                dist: { integrity: 'sha512-existing' },
            }),
        });
        assert.equal(await getNpmRegistryIntegrity(packageName, '1.2.3', existingVersion.fetch), 'sha512-existing');
        assert.deepEqual(existingVersion.requestedUrls, [packageUrl, versionUrl]);

        const missingPackage = queuedFetch({ status: 404 });
        await assert.rejects(
            getNpmRegistryIntegrity(packageName, '1.2.3', missingPackage.fetch),
            /package .* was not found.*refusing to publish/i,
        );
        assert.deepEqual(missingPackage.requestedUrls, [packageUrl]);

        for (const status of [401, 403, 429, 500]) {
            const failedLookup = queuedFetch(packageExists, { status, ok: false, statusText: 'Failure' });
            await assert.rejects(
                getNpmRegistryIntegrity(packageName, '1.2.3', failedLookup.fetch),
                new RegExp(`HTTP ${status}`),
            );
        }
        const malformedVersion = queuedFetch(packageExists, {
            status: 200,
            ok: true,
            json: async () => ({ name: packageName, version: '1.2.3', dist: {} }),
        });
        await assert.rejects(
            getNpmRegistryIntegrity(packageName, '1.2.3', malformedVersion.fetch),
            /no valid dist\.integrity/,
        );
        const mismatchedVersion = queuedFetch(packageExists, {
            status: 200,
            ok: true,
            json: async () => ({
                name: packageName,
                version: '9.9.9',
                dist: { integrity: 'sha512-some-bytes' },
            }),
        });
        await assert.rejects(
            getNpmRegistryIntegrity(packageName, '1.2.3', mismatchedVersion.fetch),
            /registry response identifies .* rather than @pumpkin-plugins\/pumpkin-api@1\.2\.3/,
        );
    });

    it('packs and publishes released paths in canonical order', async () => {
        const root = createRoot();
        const packedPaths = [];
        const publishedPaths = [];
        const selectedPaths = [...PUBLIC_TOOL_RELEASE_ORDER].reverse();

        await publishToolPackages({
            root,
            selectedPaths,
            releaseMetadata: createReleaseMetadata(selectedPaths),
            packPackage: createPackAdapter(root, packedPaths),
            getRegistryIntegrity: async () => null,
            publishPackage: async ({ packagePath }) => publishedPaths.push(packagePath),
            log: () => {},
        });

        assert.deepEqual(packedPaths, PUBLIC_TOOL_RELEASE_ORDER);
        assert.deepEqual(publishedPaths, PUBLIC_TOOL_RELEASE_ORDER);
    });

    it('rejects a Release Please tag with a component that does not match its path', async () => {
        const root = createRoot();
        let packed = false;

        await assert.rejects(
            publishToolPackages({
                root,
                selectedPaths: ['tools/pumpkin-api'],
                releaseMetadata: createReleaseMetadata(['tools/pumpkin-api'], {
                    'tools/pumpkin-api': 'build-v1.2.3',
                }),
                packPackage: async () => {
                    packed = true;
                },
                getRegistryIntegrity: async () => null,
                publishPackage: async () => {},
                log: () => {},
            }),
            /tools\/pumpkin-api.*build-v1\.2\.3.*component/i,
        );
        assert.equal(packed, false);
    });

    it('rejects a Release Please tag version that differs from the source manifest', async () => {
        const root = createRoot();
        const selectedPaths = ['tools/pumpkin-api'];

        await assert.rejects(
            publishToolPackages({
                root,
                selectedPaths,
                releaseMetadata: createReleaseMetadata(selectedPaths, {
                    'tools/pumpkin-api': 'pumpkin-api-v9.9.9',
                }),
                packPackage: createPackAdapter(root),
                getRegistryIntegrity: async () => null,
                publishPackage: async () => {},
                log: () => {},
            }),
            /@pumpkin-plugins\/pumpkin-api@9\.9\.9.*source manifest version 1\.2\.3/,
        );
    });

    it('rejects a packed manifest version that differs from the verified release tag', async () => {
        const root = createRoot();
        const selectedPaths = ['tools/pumpkin-api'];
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
            /@pumpkin-plugins\/pumpkin-api@1\.2\.3.*packed manifest version 1\.2\.2/,
        );
        assert.equal(published, false);
    });

    it('requires builder and creator prerequisites at their exact packed versions', async () => {
        const root = createRoot();
        const selectedPaths = ['tools/build'];
        const requested = [];

        await assert.rejects(
            publishToolPackages({
                root,
                selectedPaths,
                releaseMetadata: createReleaseMetadata(selectedPaths),
                packPackage: createPackAdapter(root),
                getRegistryIntegrity: async (packageName, version) => {
                    requested.push(`${packageName}@${version}`);
                    return packageName === '@pumpkin-plugins/pumpkin-api' ? 'sha512-api' : null;
                },
                publishPackage: async () => {},
                log: () => {},
            }),
            /@pumpkin-plugins\/static-hermes-runtime@1\.3\.4.*required by @pumpkin-plugins\/build@2\.3\.4.*not found/i,
        );

        assert.deepEqual(requested, [
            '@pumpkin-plugins/pumpkin-api@1.2.3',
            '@pumpkin-plugins/static-hermes-runtime@1.3.4',
        ]);
    });

    it('requires exact API and builder versions from both packed creator templates', async () => {
        const root = createRoot();
        const selectedPaths = ['tools/create-pumpkin-plugin'];
        const requested = [];

        await assert.rejects(
            publishToolPackages({
                root,
                selectedPaths,
                releaseMetadata: createReleaseMetadata(selectedPaths),
                packPackage: async (packagePath) =>
                    packForRoot(root, packagePath, {
                        starterTemplatePackageJsons: [
                            {
                                dependencies: {
                                    '@pumpkin-plugins/pumpkin-api': '^1.2.3',
                                    '@pumpkin-plugins/build': '^2.3.4',
                                },
                            },
                            {
                                dependencies: {
                                    '@pumpkin-plugins/pumpkin-api': '^1.2.2',
                                    '@pumpkin-plugins/build': '^2.3.4',
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
            /starter dependency must be \^1\.2\.3.*received \^1\.2\.2/,
        );
        assert.deepEqual(requested, []);
    });

    it('publishes only after a definitive exact-version not-found result', async () => {
        const root = createRoot();
        const selectedPaths = ['tools/pumpkin-api'];
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

        assert.deepEqual(lookups, ['@pumpkin-plugins/pumpkin-api@1.2.3']);
        assert.deepEqual(published, ['@pumpkin-plugins/pumpkin-api@1.2.3']);
    });

    it('does not publish after an authorization, network, or registry error', async () => {
        const root = createRoot();
        const selectedPaths = ['tools/pumpkin-api'];
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
            /@pumpkin-plugins\/pumpkin-api@1\.2\.3.*HTTP 429 Too Many Requests/,
        );
        assert.equal(published, false);
    });

    it('accepts a same-version retry only when registry SRI matches the packed tarball', async () => {
        const root = createRoot();
        const selectedPaths = ['tools/pumpkin-api'];
        const expectedIntegrity = `sha512-${Buffer.from('tools/pumpkin-api').toString('base64')}`;
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
        const selectedPaths = ['tools/pumpkin-api'];
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
            /@pumpkin-plugins\/pumpkin-api@1\.2\.3.*integrity mismatch/,
        );
        assert.equal(published, false);
    });

    it('rejects unknown and duplicate release paths before packing', async () => {
        const root = createRoot();
        let packed = false;

        for (const selectedPaths of [['tools/not-public'], ['tools/pumpkin-api', 'tools/pumpkin-api']]) {
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
