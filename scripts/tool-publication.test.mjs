import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { partitionReleasePaths } from './release-fanout.mjs';
import {
    assertPackedBuilderDependencies,
    assertPackedToolSchemaReferences,
    assertPublicToolPackage,
    assertPublicToolPackageContents,
    assertStarterToolDependencies,
    parseTarEntries,
    syncStarterToolDependencies
} from './tool-packages.mjs';

const temporaryDirectories = [];
afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('public tool release fanout', () => {
    it('keeps public tool packages out of plugin artifact fanout', () => {
        assert.deepEqual(
            partitionReleasePaths([
                { path: 'packages/waypoints' },
                { path: 'actions/sign-pumpkin-plugin' },
                { path: 'tools/build' },
                { path: 'tools/pumpkin-api' },
                { path: 'tools/static-hermes-runtime' },
                { path: 'tools/create-pumpkin-plugin' }
            ]),
            {
                pluginPaths: ['packages/waypoints'],
                actionPaths: ['actions/sign-pumpkin-plugin'],
                toolPaths: [
                    'tools/build',
                    'tools/pumpkin-api',
                    'tools/static-hermes-runtime',
                    'tools/create-pumpkin-plugin'
                ]
            }
        );
    });
});

describe('public tool package metadata', () => {
    it('rejects private packages and requires public npm access', () => {
        const metadata = {
            name: '@pumpkin-plugins/build',
            version: '0.1.0',
            engines: { node: '>=24.21.0' },
            publishConfig: { access: 'public' }
        };

        assert.doesNotThrow(() => assertPublicToolPackage(metadata, '@pumpkin-plugins/build'));
        assert.throws(
            () => assertPublicToolPackage({ ...metadata, private: true }, '@pumpkin-plugins/build'),
            /must not be private/
        );
        assert.throws(
            () => assertPublicToolPackage({ ...metadata, publishConfig: undefined }, '@pumpkin-plugins/build'),
            /publishConfig.access must be public/
        );
        assert.throws(
            () => assertPublicToolPackage({ ...metadata, engines: undefined }, '@pumpkin-plugins/build'),
            /engines.node must be >=24\.21\.0/
        );
    });
});

describe('packed public tool contents', () => {
    it('parses tar listings with Windows line endings', () => {
        assert.deepEqual(parseTarEntries('package/package.json\r\npackage/src/index.ts\r\n'), [
            'package/package.json',
            'package/src/index.ts'
        ]);
    });

    it('requires each packed lockfile schema to resolve to a packed package-local file', () => {
        const entries = ['package/wit.lock.json', 'package/schemas/upstream-git-pin.schema.json'];
        const lockFiles = {
            'package/wit.lock.json': JSON.stringify({ $schema: 'schemas/upstream-git-pin.schema.json' })
        };

        assert.doesNotThrow(() => assertPackedToolSchemaReferences(entries, lockFiles));
        assert.throws(
            () =>
                assertPackedToolSchemaReferences(entries, {
                    ...lockFiles,
                    'package/wit.lock.json': JSON.stringify({ $schema: '../../schemas/upstream-git-pin.schema.json' })
                }),
            /schema escapes its package/
        );
        assert.throws(
            () => assertPackedToolSchemaReferences(['package/wit.lock.json'], lockFiles),
            /references missing schema package\/schemas\/upstream-git-pin\.schema\.json/
        );
    });

    it('requires the schemas referenced by packed Pumpkin API lockfiles', () => {
        const entries = [
            'package/src/index.ts',
            'package/src/wit.mjs',
            'package/src/wit.d.mts',
            'package/wit.lock.json'
        ];

        assert.throws(
            () => assertPublicToolPackageContents(entries, 'tools/pumpkin-api'),
            /missing package\/schemas\/upstream-git-pin\.schema\.json/
        );
    });

    it('requires the schemas referenced by packed Static Hermes lockfiles', () => {
        const entries = [
            'package/src/index.ts',
            'package/dist/index.js',
            'package/cmake/wasi-sdk-hermes-p2.cmake',
            'package/hermes-patches/0001-wasi-p2-configure-platform.patch',
            'package/hermes-source.lock.json',
            'package/wasi-sdk.lock.json',
            'package/toolchain-versions.json'
        ];

        assert.throws(
            () => assertPublicToolPackageContents(entries, 'tools/static-hermes-runtime'),
            /missing package\/schemas\/upstream-git-pin\.schema\.json/
        );
    });

    it('keeps Pumpkin API type sources and excludes source tests', () => {
        const entries = [
            'package/src/index.ts',
            'package/src/core.ts',
            'package/src/wit.mjs',
            'package/src/wit.d.mts',
            'package/wit.lock.json',
            'package/schemas/upstream-git-pin.schema.json',
            'package/src/index.test.ts'
        ];

        assert.throws(() => assertPublicToolPackageContents(entries, 'tools/pumpkin-api'), /development test source/);
        assert.doesNotThrow(() =>
            assertPublicToolPackageContents(
                entries.filter((entry) => !entry.endsWith('.test.ts')),
                'tools/pumpkin-api'
            )
        );
    });

    it('keeps Static Hermes type sources and runtime assets while excluding source tests', () => {
        const entries = [
            'package/src/index.ts',
            'package/dist/index.js',
            'package/cmake/wasi-sdk-hermes-p2.cmake',
            'package/hermes-patches/0001-wasi-p2-configure-platform.patch',
            'package/schemas/upstream-git-pin.schema.json',
            'package/schemas/wasi-sdk-release-pin.schema.json',
            'package/schemas/toolchain-versions.schema.json',
            'package/src/component/build.test.ts'
        ];

        assert.throws(
            () => assertPublicToolPackageContents(entries, 'tools/static-hermes-runtime'),
            /development test source/
        );
        assert.doesNotThrow(() =>
            assertPublicToolPackageContents(
                entries.filter((entry) => !entry.endsWith('.test.ts')),
                'tools/static-hermes-runtime'
            )
        );
    });

    it('keeps only the build CLI bundle and runtime assets', () => {
        const entries = [
            'package/dist/cli.js',
            'package/runtime/quickjs-runtime-bigint.wasm',
            'package/wasi-wit.lock.json',
            'package/src/cli.ts'
        ];

        assert.throws(
            () => assertPublicToolPackageContents(entries, 'tools/build'),
            /CLI-only package contains source/
        );
        assert.doesNotThrow(() =>
            assertPublicToolPackageContents(
                entries.filter((entry) => !entry.startsWith('package/src/')),
                'tools/build'
            )
        );
    });

    it('keeps the generator CLI source while excluding its development test source', () => {
        const entries = [
            'package/bin/create-pumpkin-plugin.ts',
            'package/dist/create-pumpkin-plugin.js',
            'package/templates/typescript/package.json',
            'package/templates/javascript/package.json',
            'package/bin/create-pumpkin-plugin.test.ts'
        ];

        assert.throws(
            () => assertPublicToolPackageContents(entries, 'tools/create-pumpkin-plugin'),
            /development test source/
        );
        assert.doesNotThrow(() =>
            assertPublicToolPackageContents(
                entries.filter((entry) => !entry.endsWith('.test.ts')),
                'tools/create-pumpkin-plugin'
            )
        );
    });
});

describe('starter tool dependency versions', () => {
    it('syncs both templates to the current API and builder release ranges', () => {
        const root = mkdtempSync(join(tmpdir(), 'pumpkin-tool-versions-'));
        temporaryDirectories.push(root);
        for (const [directory, name, version] of [
            ['tools/pumpkin-api', '@pumpkin-plugins/pumpkin-api', '0.2.0'],
            ['tools/build', '@pumpkin-plugins/build', '0.3.4']
        ]) {
            mkdirSync(join(root, directory), { recursive: true });
            writeFileSync(join(root, directory, 'package.json'), JSON.stringify({ name, version }));
        }

        const templateDirectories = ['typescript', 'javascript'];
        for (const language of templateDirectories) {
            const directory = join(root, 'tools/create-pumpkin-plugin/templates', language);
            mkdirSync(directory, { recursive: true });
            writeFileSync(
                join(directory, 'package.json'),
                JSON.stringify({
                    dependencies: {
                        '@pumpkin-plugins/pumpkin-api': '^0.1.0',
                        '@pumpkin-plugins/build': '^0.1.0'
                    }
                })
            );
        }

        assert.equal(syncStarterToolDependencies(root), true);
        for (const language of templateDirectories) {
            const packageJson = JSON.parse(
                readFileSync(join(root, 'tools/create-pumpkin-plugin/templates', language, 'package.json'), 'utf8')
            );
            assertStarterToolDependencies(packageJson, {
                '@pumpkin-plugins/pumpkin-api': '0.2.0',
                '@pumpkin-plugins/build': '0.3.4'
            });
        }
    });

    it('fails if either starter template is stale for the packages that will be packed', () => {
        const packageJson = {
            dependencies: {
                '@pumpkin-plugins/pumpkin-api': '^0.1.0',
                '@pumpkin-plugins/build': '^0.1.0'
            }
        };

        assert.throws(
            () =>
                assertStarterToolDependencies(packageJson, {
                    '@pumpkin-plugins/pumpkin-api': '0.2.0',
                    '@pumpkin-plugins/build': '0.3.4'
                }),
            /must be \^0\.2\.0/
        );
    });
});

describe('packed builder tool dependencies', () => {
    it('requires packed API and runtime versions to match the builder manifest', () => {
        const builder = {
            dependencies: {
                '@pumpkin-plugins/pumpkin-api': '0.2.0',
                '@pumpkin-plugins/static-hermes-runtime': '0.4.1'
            }
        };

        assert.doesNotThrow(() =>
            assertPackedBuilderDependencies(builder, {
                '@pumpkin-plugins/pumpkin-api': '0.2.0',
                '@pumpkin-plugins/static-hermes-runtime': '0.4.1'
            })
        );
        assert.throws(
            () =>
                assertPackedBuilderDependencies(builder, {
                    '@pumpkin-plugins/pumpkin-api': '0.3.0',
                    '@pumpkin-plugins/static-hermes-runtime': '0.4.1'
                }),
            /must resolve to packed version 0\.3\.0/
        );
    });
});
