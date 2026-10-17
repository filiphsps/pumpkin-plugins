import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { partitionReleasePaths } from './release-fanout.mjs';
import {
    assertPackedDependencySpecs,
    assertPublicToolPackage,
    assertPublicToolPackageContents,
    assertPublicToolTemplateDependencies,
    discoverPublicToolPackages,
    embeddedPackageManifestEntries,
    getPublicToolReleasePrerequisites,
    nodeEngineRange,
    nodeVersion,
    orderPublicToolReleasePaths,
    parseTarEntries,
    publicToolPackageVersions,
    syncStarterToolDependencies,
} from './tool-packages.mjs';

const temporaryDirectories = [];
afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function workspace(packages) {
    const root = mkdtempSync(join(tmpdir(), 'tool-publication-'));
    temporaryDirectories.push(root);
    mkdirSync(join(root, 'tools'), { recursive: true });
    for (const [packagePath, packageJson, files = {}] of packages) {
        const directory = join(root, packagePath);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'package.json'), JSON.stringify(packageJson));
        for (const [file, contents] of Object.entries(files)) {
            const filePath = join(directory, file);
            mkdirSync(join(filePath, '..'), { recursive: true });
            writeFileSync(filePath, JSON.stringify(contents));
        }
    }
    return root;
}

function publicPackage(name, extra = {}) {
    return {
        name,
        version: '1.0.0',
        publishConfig: { access: 'public' },
        ...extra,
    };
}

describe('public tool release fanout', () => {
    it('keeps public tools out of plugin, action, and extension artifacts', () => {
        assert.deepEqual(
            partitionReleasePaths([
                { path: 'packages/waypoints' },
                { path: 'actions/sign-pumpkin-plugin' },
                { path: 'tools/build' },
                { path: 'extensions/minecraft-terms' },
            ]),
            {
                pluginPaths: ['packages/waypoints'],
                actionPaths: ['actions/sign-pumpkin-plugin'],
                toolPaths: ['tools/build'],
                extensionPaths: ['extensions/minecraft-terms'],
                nativePaths: [],
            },
        );
    });
});

describe('public tool package metadata', () => {
    it('discovers publishable tools from package manifests and skips private workspaces', () => {
        const root = workspace([
            ['tools/new-tool', publicPackage('@example/new-tool')],
            ['tools/private-helper', publicPackage('@example/private-helper', { private: true })],
            ['tools/unpublished', { name: '@example/unpublished', private: true }],
        ]);

        assert.deepEqual(
            discoverPublicToolPackages(root).map(({ path: packagePath, name }) => [packagePath, name]),
            [['tools/new-tool', '@example/new-tool']],
        );
    });

    it('checks public metadata against the workspace Node pin', () => {
        const metadata = {
            ...publicPackage('@example/tool'),
            engines: { node: nodeEngineRange() },
        };

        assert.doesNotThrow(() => assertPublicToolPackage(metadata, '@example/tool'));
        assert.throws(
            () => assertPublicToolPackage({ ...metadata, private: true }, '@example/tool'),
            /must not be private/,
        );
        assert.throws(
            () => assertPublicToolPackage({ ...metadata, publishConfig: undefined }, '@example/tool'),
            /publishConfig\.access must be public/,
        );
        assert.throws(
            () => assertPublicToolPackage({ ...metadata, engines: undefined }, '@example/tool'),
            /engines\.node must be/,
        );
        assert.match(nodeVersion(), /^\d+\.\d+\.\d+$/);
    });

    it('rejects unresolved workspace and catalog specs in packed dependency fields', () => {
        assert.doesNotThrow(() =>
            assertPackedDependencySpecs({
                dependencies: { '@example/api': '1.0.0' },
                peerDependencies: { typescript: '^6.0.0' },
            }),
        );
        assert.throws(
            () => assertPackedDependencySpecs({ dependencies: { api: 'workspace:*' } }),
            /unresolved dependency spec.*api.*workspace:\*/,
        );
        assert.throws(
            () => assertPackedDependencySpecs({ optionalDependencies: { cli: 'catalog:' } }),
            /unresolved dependency spec.*cli.*catalog:/,
        );
    });
});

describe('public tool release dependencies', () => {
    it('orders tools from their declared production dependencies', () => {
        const root = workspace([
            ['tools/api', publicPackage('@example/api')],
            ['tools/cli', publicPackage('@example/cli', { dependencies: { '@example/api': '^1.0.0' } })],
            ['tools/private', publicPackage('@example/private', { private: true })],
        ]);

        const ordered = orderPublicToolReleasePaths(['tools/cli', 'tools/api'], root);

        assert.equal(ordered.length, 2);
        assert.ok(ordered.indexOf('tools/api') < ordered.indexOf('tools/cli'));
        assert.throws(() => orderPublicToolReleasePaths(['tools/private'], root), /unknown public tool release path/);
        assert.throws(
            () => orderPublicToolReleasePaths(['tools/api', 'tools/api'], root),
            /duplicate public tool release path/,
        );
    });

    it('ignores dependencies in nested manifests excluded from the package', () => {
        const root = workspace([
            ['tools/base', publicPackage('@example/base')],
            [
                'tools/consumer',
                publicPackage('@example/consumer', {
                    dependencies: { '@example/base': '^1.0.0' },
                    files: ['dist/**'],
                }),
                {
                    'test/fixtures/package.json': {
                        name: 'test-fixture',
                        dependencies: { '@example/consumer': '^1.0.0' },
                    },
                },
            ],
        ]);

        assert.deepEqual(orderPublicToolReleasePaths(['tools/consumer', 'tools/base'], root), [
            'tools/base',
            'tools/consumer',
        ]);
    });

    it('orders optional public dependencies declared by packages and embedded projects', () => {
        const root = workspace([
            ['tools/y-package', publicPackage('@example/y-package')],
            ['tools/z-template', publicPackage('@example/z-template')],
            [
                'tools/a-consumer',
                publicPackage('@example/a-consumer', { optionalDependencies: { '@example/y-package': '^1.0.0' } }),
                {
                    'templates/app/package.json': {
                        name: 'template-app',
                        optionalDependencies: { '@example/z-template': '^1.0.0' },
                    },
                },
            ],
        ]);

        assert.deepEqual(
            orderPublicToolReleasePaths(['tools/a-consumer', 'tools/z-template', 'tools/y-package'], root),
            ['tools/y-package', 'tools/z-template', 'tools/a-consumer'],
        );
    });

    it('uses embedded project dependencies as publication prerequisites', () => {
        const root = workspace([
            ['tools/api', publicPackage('@example/api')],
            ['tools/cli', publicPackage('@example/cli')],
            ['tools/starter', publicPackage('@example/starter')],
        ]);
        const versions = { '@example/api': '1.2.3', '@example/cli': '2.3.4' };
        const templates = [
            { dependencies: { '@example/api': '^1.2.3', '@example/cli': '^2.3.4' } },
            { dependencies: { '@example/api': '^1.2.3', '@example/cli': '^2.3.4' } },
        ];

        const prerequisites = getPublicToolReleasePrerequisites('tools/starter', {}, versions, templates, root);

        assert.deepEqual(
            new Map(prerequisites.map(({ packageName, version }) => [packageName, version])),
            new Map(Object.entries(versions)),
        );
        assert.throws(
            () =>
                getPublicToolReleasePrerequisites(
                    'tools/starter',
                    {},
                    versions,
                    [templates[0], { dependencies: { '@example/api': '^1.2.2' } }],
                    root,
                ),
            /template dependency must be \^1\.2\.3/,
        );
    });

    it('updates only public tool dependencies found in embedded manifests', () => {
        const root = workspace([
            ['tools/api', publicPackage('@example/api')],
            ['tools/extra', publicPackage('@example/extra')],
            [
                'tools/starter',
                publicPackage('@example/starter'),
                {
                    'templates/typed/package.json': {
                        name: 'typed-starter',
                        dependencies: { '@example/api': '^0.9.0', unrelated: '^3.0.0' },
                        optionalDependencies: { '@example/extra': '^0.9.0' },
                    },
                    'templates/plain/package.json': {
                        name: 'plain-starter',
                        dependencies: { '@example/api': '^0.8.0' },
                    },
                },
            ],
        ]);

        assert.equal(syncStarterToolDependencies(root), true);
        assert.equal(syncStarterToolDependencies(root), false);
        const typed = JSON.parse(readFileSync(join(root, 'tools/starter/templates/typed/package.json'), 'utf8'));
        const plain = JSON.parse(readFileSync(join(root, 'tools/starter/templates/plain/package.json'), 'utf8'));
        assert.equal(typed.dependencies['@example/api'], '^1.0.0');
        assert.equal(typed.dependencies.unrelated, '^3.0.0');
        assert.equal(typed.optionalDependencies['@example/extra'], '^1.0.0');
        assert.equal(plain.dependencies['@example/api'], '^1.0.0');
        assert.deepEqual(publicToolPackageVersions(root), {
            '@example/api': '1.0.0',
            '@example/extra': '1.0.0',
            '@example/starter': '1.0.0',
        });
    });

    it('checks embedded projects without knowing their package names', () => {
        const root = workspace([['tools/api', publicPackage('@example/api')]]);
        const versions = { '@example/api': '1.0.0' };

        assert.doesNotThrow(() =>
            assertPublicToolTemplateDependencies(
                { dependencies: { '@example/api': '^1.0.0', unrelated: 'workspace:*' } },
                versions,
                root,
            ),
        );
        assert.throws(
            () => assertPublicToolTemplateDependencies({ dependencies: { '@example/api': '^0.9.0' } }, versions, root),
            /template dependency must be \^1\.0\.0/,
        );
    });
});

describe('packed public tool contents', () => {
    it('parses tar listings with Windows line endings', () => {
        assert.deepEqual(parseTarEntries('package/package.json\r\npackage/src/index.ts\r\n'), [
            'package/package.json',
            'package/src/index.ts',
        ]);
    });

    it('requires the exported files and executable declared in the packed manifest', () => {
        const packageJson = {
            name: '@example/cli',
            bin: { example: 'dist/bin/example.js' },
            exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
        };

        assert.throws(
            () =>
                assertPublicToolPackageContents(
                    ['package/package.json', 'package/dist/index.d.ts', 'package/dist/index.js'],
                    'tools/example-cli',
                    packageJson,
                ),
            /missing package\/dist\/bin\/example\.js/,
        );
        assert.doesNotThrow(() =>
            assertPublicToolPackageContents(
                [
                    'package/package.json',
                    'package/dist/bin/example.js',
                    'package/dist/index.d.ts',
                    'package/dist/index.js',
                ],
                'tools/example-cli',
                packageJson,
            ),
        );
    });

    it('rejects development test sources from a tarball', () => {
        assert.throws(
            () =>
                assertPublicToolPackageContents(
                    ['package/src/index.js', 'package/src/index.test.js'],
                    'tools/example',
                    { exports: { '.': './src/index.js' } },
                ),
            /development test source/,
        );
    });

    it('finds embedded manifests without assuming template names', () => {
        assert.deepEqual(
            embeddedPackageManifestEntries([
                'package/package.json',
                'package/templates/ts/package.json',
                'package/templates/js/package.json',
                'package/other.json',
            ]),
            ['package/templates/ts/package.json', 'package/templates/js/package.json'],
        );
    });
});
