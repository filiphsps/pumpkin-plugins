import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
    bundledChangesPlugin,
    bundledPaths,
    pluginReleaseInputs,
    releaseCommits,
    workspacePackages,
} from './release-commits.mjs';

const packages = new Map([
    [
        '@pumpkin-plugins/docs',
        {
            path: 'tools/docs',
            manifest: { dependencies: {} },
        },
    ],
    [
        'plugin',
        {
            path: 'packages/plugin',
            manifest: {
                dependencies: { kit: 'workspace:*' },
                devDependencies: { '@pumpkin-plugins/build': 'workspace:*', harness: 'workspace:*' },
            },
        },
    ],
    [
        'kit',
        {
            path: 'tools/plugin-kit',
            manifest: {
                publishConfig: { access: 'public' },
                dependencies: { '@pumpkin-plugins/docs': 'workspace:*', updates: 'workspace:*' },
                devDependencies: { '@pumpkin-plugins/build': 'workspace:*' },
            },
        },
    ],
    [
        'updates',
        {
            path: 'tools/update-check',
            manifest: { publishConfig: { access: 'public' }, dependencies: { kit: 'workspace:*' } },
        },
    ],
    [
        '@pumpkin-plugins/build',
        {
            path: 'tools/build',
            manifest: {
                publishConfig: { access: 'public' },
                dependencies: {
                    '@pumpkin-plugins/pumpkin-api': 'workspace:*',
                    '@pumpkin-plugins/static-hermes-runtime': 'workspace:*',
                },
            },
        },
    ],
    ['@pumpkin-plugins/pumpkin-api', { path: 'tools/pumpkin-api', manifest: { publishConfig: { access: 'public' } } }],
    [
        '@pumpkin-plugins/static-hermes-runtime',
        { path: 'tools/static-hermes-runtime', manifest: { publishConfig: { access: 'public' } } },
    ],
    [
        'minecraft-terms',
        {
            path: 'extensions/minecraft-terms',
            manifest: { pumpkinBundleDependencies: ['@pumpkin-plugins/cspell-dict-minecraft'] },
        },
    ],
    [
        '@pumpkin-plugins/cspell-dict-minecraft',
        { path: 'tools/cspell-dict-minecraft', manifest: { publishConfig: { access: 'public' } } },
    ],
    ['harness', { path: 'tools/test-harness', manifest: {} }],
]);
const releaseConfig = JSON.parse(readFileSync(new URL('../../release-please-config.json', import.meta.url), 'utf8'));
const repositoryRoot = resolve(import.meta.dirname, '../..');
const commit = (sha, files, message = 'fix: ship a change') => ({ sha, files, message });

function writeToolPackages(root, packages) {
    for (const [name, pkg] of packages) {
        const directory = join(root, pkg.path);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, ...pkg.manifest }));
    }
}

/** Writes a throwaway workspace from relative paths to file contents; objects become JSON. */
function writeWorkspace(files) {
    const root = mkdtempSync(join(tmpdir(), 'release-workspace-'));
    for (const [path, contents] of Object.entries({ 'tsconfig.base.json': { compilerOptions: {} }, ...files })) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), typeof contents === 'string' ? contents : JSON.stringify(contents));
    }
    return root;
}

/** A workspace with one plugin that uses the public build tool. */
function pluginWorkspace() {
    return writeWorkspace({
        'packages/plugin/package.json': {
            name: 'plugin',
            pumpkinPlugin: { entry: 'src/plugin.ts' },
            devDependencies: { '@pumpkin-plugins/build': 'workspace:*' },
        },
        'packages/plugin/src/plugin.ts': 'export {};\n',
        'tools/build/package.json': { name: '@pumpkin-plugins/build', publishConfig: { access: 'public' } },
        'tools/build/src/index.ts': 'export {};\n',
    });
}

async function inPluginWorkspace(test) {
    const root = pluginWorkspace();
    try {
        await test(root, workspacePackages(root));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function introductionCommitApi(path, introductionSha) {
    return {
        repository: { owner: 'owner', repo: 'repo' },
        octokit: {
            rest: { repos: { listCommits: 'listCommits' } },
            async paginate(_endpoint, options) {
                assert.equal(options.path, `${path}/package.json`);
                return [{ sha: 'manifest-update' }, { sha: introductionSha }];
            },
        },
    };
}

class TestTagName {
    constructor(version, component = 'plugin') {
        this.component = component;
        this.version = {
            compare: (other) => version.localeCompare(other.toString(), undefined, { numeric: true }),
            toString: () => version,
        };
    }

    static parse(tagName) {
        const match = /^([\w-]+)-v(\d+\.\d+\.\d+)$/.exec(tagName);
        return match ? new TestTagName(match[2], match[1]) : undefined;
    }

    toString() {
        return `${this.component}-v${this.version.toString()}`;
    }
}

describe('bundled release commits', () => {
    it('ignores leftover directories without manifests and reads named workspace packages', () => {
        const root = mkdtempSync(join(tmpdir(), 'release-packages-'));
        try {
            mkdirSync(join(root, 'packages/plugin'), { recursive: true });
            mkdirSync(join(root, 'tools/removed-tool'), { recursive: true });
            writeFileSync(join(root, 'packages/plugin/package.json'), JSON.stringify({ name: 'plugin' }));
            assert.deepEqual(
                [...workspacePackages(root)],
                [['plugin', { path: 'packages/plugin', manifest: { name: 'plugin' } }]],
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('follows transitive runtime dependencies and the build tool without cycles or test dependencies', () => {
        assert.deepEqual([...bundledPaths(packages, 'packages/plugin')].sort(), [
            'packages/plugin',
            'tools/build',
            'tools/docs',
            'tools/plugin-kit',
            'tools/pumpkin-api',
            'tools/static-hermes-runtime',
            'tools/update-check',
        ]);
        assert.throws(() => bundledPaths(packages, 'packages/missing'), /Unknown release package/);
    });

    it('keeps public npm tool releases scoped to their own shipped files', () => {
        const history = [
            commit('docs-dependency', ['tools/docs/src/discovery.ts']),
            commit('build-dev-dependency', ['tools/build/src/bundle.ts']),
            commit('plugin-kit', ['tools/plugin-kit/src/plugin.ts']),
            commit('release-boundary', ['tools/plugin-kit/package.json']),
        ];

        assert.deepEqual(
            releaseCommits(history, bundledPaths(packages, 'tools/plugin-kit'), 'release-boundary', 'plugin-kit').map(
                (entry) => entry.sha,
            ),
            ['plugin-kit'],
        );
    });

    it('does not require built workspace dependency output when scanning public tool sources', async () => {
        const root = mkdtempSync(join(tmpdir(), 'release-tool-imports-'));
        try {
            const codemodManifest = {
                name: '@pumpkin-plugins/codemod',
                publishConfig: { access: 'public' },
                dependencies: { '@pumpkin-plugins/static-analysis': 'workspace:*' },
            };
            const analysisManifest = {
                name: '@pumpkin-plugins/static-analysis',
                publishConfig: { access: 'public' },
                exports: {
                    '.': { types: './dist/src/index.d.ts', import: './dist/src/index.js' },
                },
            };
            const pluginManifest = {
                name: 'plugin',
                pumpkinPlugin: { entry: 'src/plugin.ts' },
            };
            mkdirSync(join(root, 'tools/codemod/src'), { recursive: true });
            mkdirSync(join(root, 'tools/codemod/node_modules/@pumpkin-plugins/static-analysis'), {
                recursive: true,
            });
            mkdirSync(join(root, 'tools/static-analysis'), { recursive: true });
            mkdirSync(join(root, 'packages/plugin/src'), { recursive: true });
            writeFileSync(
                join(root, 'tsconfig.base.json'),
                JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler' } }),
            );
            writeFileSync(join(root, 'tools/codemod/package.json'), JSON.stringify(codemodManifest));
            writeFileSync(join(root, 'tools/static-analysis/package.json'), JSON.stringify(analysisManifest));
            writeFileSync(
                join(root, 'tools/codemod/node_modules/@pumpkin-plugins/static-analysis/package.json'),
                JSON.stringify(analysisManifest),
            );
            writeFileSync(
                join(root, 'tools/codemod/src/entry.ts'),
                "import { analyzeModuleGraph } from '@pumpkin-plugins/static-analysis';\n",
            );
            writeFileSync(join(root, 'packages/plugin/package.json'), JSON.stringify(pluginManifest));
            writeFileSync(
                join(root, 'packages/plugin/src/plugin.ts'),
                "import { analyzeModuleGraph } from '@pumpkin-plugins/static-analysis';\n",
            );

            const fixturePackages = new Map([
                ['@pumpkin-plugins/codemod', { path: 'tools/codemod', manifest: codemodManifest }],
                ['@pumpkin-plugins/static-analysis', { path: 'tools/static-analysis', manifest: analysisManifest }],
                ['plugin', { path: 'packages/plugin', manifest: pluginManifest }],
            ]);
            const boundary = commit('boundary', []);
            const github = {
                async *mergeCommitIterator() {
                    yield boundary;
                },
            };
            const release = bundledChangesPlugin(github, 'master', fixturePackages, {}, 500, () => {}, root);
            const commitsByPath = { 'tools/codemod': [] };

            await assert.doesNotReject(
                release.preconfigure({ 'tools/codemod': {} }, commitsByPath, {
                    'tools/codemod': { sha: boundary.sha },
                }),
            );
            assert.deepEqual(commitsByPath['tools/codemod'], []);
            assert.throws(
                () => pluginReleaseInputs(fixturePackages, 'packages/plugin', root),
                /Cannot resolve workspace import @pumpkin-plugins\/static-analysis from packages\/plugin\/src\/plugin.ts/,
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('selects plugin releases from imported runtime modules, builder source, and relevant catalogs', () => {
        const inputs = pluginReleaseInputs(
            workspacePackages(repositoryRoot),
            'packages/apple-skin-pumpkin',
            repositoryRoot,
        );
        const history = [
            commit('extension-support', [
                'pnpm-workspace.yaml',
                'extensions/minecraft-terms/package.json',
                'packages/apple-skin-pumpkin/README.md',
                'tools/docs/src/discovery.ts',
                'tools/docs/src/node.ts',
                'tools/docs/src/packages.ts',
                'tools/build/package.json',
            ]),
            commit('docs-discovery', ['tools/docs/src/discovery.ts']),
            commit('docs-metadata', ['tools/docs/src/info.ts']),
            commit('docs-command-model', ['tools/docs/src/commands.ts']),
            commit('builder', ['tools/build/src/update-check.ts']),
            commit('plugin-kit', ['tools/plugin-kit/src/plugin.ts']),
            commit('plugin-source', ['packages/apple-skin-pumpkin/src/plugin.ts']),
            commit('typescript-catalog', ['pnpm-workspace.yaml']),
            commit('vscode-catalog', ['pnpm-workspace.yaml']),
            commit('tsconfig', ['tsconfig.base.json']),
            commit('boundary', ['packages/apple-skin-pumpkin/package.json']),
        ];
        const catalogChangesByCommit = new Map([
            ['extension-support', []],
            ['typescript-catalog', ['default:typescript']],
            ['vscode-catalog', ['default:@types/vscode']],
        ]);

        assert.ok(inputs.catalogs.has('default:typescript'));
        assert.ok(!inputs.catalogs.has('default:@types/vscode'));
        assert.ok(inputs.paths.has('tools/wasi-capabilities/src/index.ts'));
        assert.deepEqual(
            releaseCommits(history, inputs, 'boundary', 'apple-skin-pumpkin', catalogChangesByCommit).map(
                (entry) => entry.sha,
            ),
            [
                'docs-metadata',
                'docs-command-model',
                'builder',
                'plugin-kit',
                'plugin-source',
                'typescript-catalog',
                'tsconfig',
            ],
        );
    });

    it('reads catalog changes from each commit before selecting plugin releases', async () => {
        const root = mkdtempSync(join(tmpdir(), 'release-catalog-changes-'));
        const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
        try {
            git('init', '-q');
            git('config', 'user.name', 'Release test');
            git('config', 'user.email', 'release-test@example.com');
            mkdirSync(join(root, 'packages/plugin/src'), { recursive: true });
            writeFileSync(
                join(root, 'packages/plugin/package.json'),
                JSON.stringify({
                    name: 'plugin',
                    pumpkinPlugin: { entry: 'src/plugin.ts' },
                    devDependencies: { typescript: 'catalog:' },
                }),
            );
            writeFileSync(join(root, 'packages/plugin/src/plugin.ts'), "import type { Plugin } from 'typescript';\n");
            writeFileSync(join(root, 'tsconfig.base.json'), JSON.stringify({ compilerOptions: {} }));
            writeFileSync(
                join(root, 'pnpm-workspace.yaml'),
                'catalog:\n  typescript: 5.5.0\n  "@types/vscode": 1.95.0\n',
            );
            git('add', '.');
            git('commit', '-qm', 'chore: establish release fixture');
            const boundary = git('rev-parse', 'HEAD');

            writeFileSync(
                join(root, 'pnpm-workspace.yaml'),
                'catalog:\n  typescript: 5.5.0\n  "@types/vscode": 1.96.0\n',
            );
            git('add', 'pnpm-workspace.yaml');
            git('commit', '-qm', 'chore: update extension catalog');
            const extensionCatalog = git('rev-parse', 'HEAD');

            writeFileSync(
                join(root, 'pnpm-workspace.yaml'),
                'catalog:\n  typescript: 5.6.0\n  "@types/vscode": 1.96.0\n',
            );
            git('add', 'pnpm-workspace.yaml');
            git('commit', '-qm', 'chore: update TypeScript catalog');
            const typescriptCatalog = git('rev-parse', 'HEAD');

            const history = [
                commit(typescriptCatalog, ['pnpm-workspace.yaml']),
                commit(extensionCatalog, ['pnpm-workspace.yaml']),
                commit(boundary, ['packages/plugin/package.json']),
            ];
            const github = {
                async *mergeCommitIterator() {
                    yield* history;
                },
            };
            const fixturePackages = new Map([
                [
                    'plugin',
                    {
                        path: 'packages/plugin',
                        manifest: {
                            name: 'plugin',
                            pumpkinPlugin: { entry: 'src/plugin.ts' },
                            devDependencies: { typescript: 'catalog:' },
                        },
                    },
                ],
            ]);
            const inputs = pluginReleaseInputs(fixturePackages, 'packages/plugin', root);
            assert.deepEqual([...inputs.catalogs], ['default:typescript'], [...inputs.paths].join(', '));
            assert.ok(inputs.paths.has('packages/plugin/src/plugin.ts'));
            const release = bundledChangesPlugin(
                github,
                'master',
                fixturePackages,
                { 'packages/plugin': '0.1.0' },
                500,
                () => {},
                root,
            );
            const commits = { 'packages/plugin': [] };
            await release.preconfigure({ 'packages/plugin': {} }, commits, { 'packages/plugin': { sha: boundary } });

            assert.deepEqual(
                commits['packages/plugin'].map((entry) => entry.sha),
                [typescriptCatalog],
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('includes declared bundled assets when selecting extension release commits', () => {
        assert.deepEqual([...bundledPaths(packages, 'extensions/minecraft-terms')].sort(), [
            'extensions/minecraft-terms',
            'tools/cspell-dict-minecraft',
        ]);
    });

    it('excludes spec files from bundled release commits', () => {
        const history = [
            commit('runtime-spec', ['tools/static-hermes-runtime/src/hermes/build.spec.ts']),
            commit('boundary', ['packages/plugin/package.json']),
        ];
        assert.deepEqual(releaseCommits(history, new Set(['tools/static-hermes-runtime']), 'boundary', 'plugin'), []);
    });

    it('includes checker changes and build inputs once, skipping unrelated tools and tests', () => {
        const history = [
            commit('checker', ['tools/update-check/src/http.ts']),
            commit('shared', ['tools/plugin-kit/src/host.ts', 'packages/plugin/src/plugin.ts']),
            commit('build', ['tools/build/src/build.ts']),
            commit('catalog', ['pnpm-workspace.yaml']),
            commit('test', ['tools/plugin-kit/src/host.test.ts']),
            commit('fixture', ['tools/update-check/test/fixture-plugin.ts']),
            commit('fake', ['tools/plugin-kit/src/testing/memory-files.ts']),
            commit('harness', ['tools/test-harness/src/instance.ts']),
            commit('other', ['packages/other/src/plugin.ts']),
            commit('docs', ['tools/plugin-kit/README.md']),
            commit('artifact', ['packages/plugin/build/output.wasm']),
            commit('released', ['packages/plugin/package.json']),
            commit('old', ['tools/update-check/src/http.ts']),
        ];
        assert.deepEqual(
            releaseCommits(history, bundledPaths(packages, 'packages/plugin'), 'released', 'plugin').map(
                (entry) => entry.sha,
            ),
            ['checker', 'shared', 'build', 'catalog'],
        );
    });

    it('uses independent release boundaries and preserves empty Release-As commits', () => {
        const paths = new Set(['tools/update-check']);
        const history = [
            commit('new', ['tools/update-check/src/http.ts']),
            commit('release-as', [], 'chore(plugin): prepare release\n\nRelease-As: 1.0.0'),
            commit('recent-release', ['packages/other/package.json']),
            commit('older', ['tools/update-check/src/http.ts']),
            commit('old-release', ['packages/plugin/package.json']),
        ];
        assert.deepEqual(
            releaseCommits(history, paths, 'recent-release', 'plugin').map((entry) => entry.sha),
            ['new', 'release-as'],
        );
        assert.deepEqual(
            releaseCommits(history, paths, 'old-release', 'plugin').map((entry) => entry.sha),
            ['new', 'release-as', 'older'],
        );
        assert.equal(releaseCommits(history, paths, undefined, 'plugin').length, 3);
    });

    it('fails closed when history or changed-file metadata is missing', () => {
        assert.throws(() => releaseCommits([], new Set(), 'missing'), /missing from the fetched history/);
        assert.throws(() => releaseCommits([{ sha: 'missing-files' }], new Set()), /no changed-file list/);
    });

    it('keeps pending plugin changes while excluding an already published plugin from follow-up releases', () => {
        const history = [
            commit('released-a', ['packages/a/package.json', '.release-please-manifest.json'], 'chore: release a'),
            commit('shared-fix', ['tools/plugin-kit/src/host.ts']),
            commit('released-b', ['packages/b/package.json'], 'chore: release b'),
        ];
        const paths = new Set(['tools/plugin-kit']);
        assert.deepEqual(releaseCommits(history, paths, 'released-a'), []);
        assert.deepEqual(releaseCommits(history, paths, 'released-b'), [history[1]]);
    });

    it('supplies unfiltered shared commits to the public preconfigure hook', async () => {
        await inPluginWorkspace(async (root, fixturePackages) => {
            const history = [
                commit('update', ['tools/build/src/index.ts']),
                commit('boundary', ['packages/plugin/package.json']),
            ];
            const github = {
                async *mergeCommitIterator() {
                    yield* history;
                },
            };
            const plugin = bundledChangesPlugin(
                github,
                'master',
                fixturePackages,
                { 'packages/plugin': '0.0.1' },
                500,
                () => {},
                root,
            );
            const strategies = { 'packages/plugin': {} };
            const scoped = { 'packages/plugin': [] };
            assert.equal(
                await plugin.preconfigure(strategies, scoped, { 'packages/plugin': { sha: 'boundary' } }),
                strategies,
            );
            assert.deepEqual(scoped['packages/plugin'], [history[0]]);
        });
    });

    it('defers a public tool release candidate until each public package dependency has released', async () => {
        const packageManifest = (packagePath, dependencies = {}) => ({
            path: packagePath,
            manifest: { publishConfig: { access: 'public' }, dependencies },
        });
        const toolPackages = new Map([
            [
                '@pumpkin-plugins/build',
                packageManifest('tools/build', {
                    '@pumpkin-plugins/minecraft-colors': 'workspace:*',
                    '@pumpkin-plugins/pumpkin-api': 'catalog:',
                    '@pumpkin-plugins/static-hermes-runtime': 'workspace:*',
                }),
            ],
            ['@pumpkin-plugins/minecraft-colors', packageManifest('tools/minecraft-colors')],
            ['@pumpkin-plugins/pumpkin-api', packageManifest('tools/pumpkin-api')],
            ['@pumpkin-plugins/static-hermes-runtime', packageManifest('tools/static-hermes-runtime')],
        ]);
        const candidate = { path: 'tools/build' };
        const unrelatedCandidate = { path: 'packages/example' };
        const dependencyPaths = ['tools/minecraft-colors', 'tools/pumpkin-api', 'tools/static-hermes-runtime'];
        const readyVersions = Object.fromEntries([
            ['tools/build', '0.1.0'],
            ...dependencyPaths.map((packagePath) => [packagePath, '0.1.0']),
        ]);

        const root = mkdtempSync(join(tmpdir(), 'release-public-tool-dependencies-'));
        try {
            writeToolPackages(root, toolPackages);
            for (const packagePath of dependencyPaths) {
                const versions = { ...readyVersions, [packagePath]: '0.0.0' };
                const plugin = bundledChangesPlugin({}, 'master', toolPackages, versions, 500, () => {}, root);

                assert.deepEqual(
                    await plugin.run([candidate, unrelatedCandidate]),
                    [unrelatedCandidate],
                    `${packagePath} should block only the build release`,
                );
            }

            const readyPlugin = bundledChangesPlugin({}, 'master', toolPackages, readyVersions, 500, () => {}, root);
            assert.deepEqual(await readyPlugin.run([candidate, unrelatedCandidate]), [candidate, unrelatedCandidate]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('checks transitive public package dependencies before allowing a release candidate', async () => {
        const publicTool = (packagePath, dependencies = {}) => ({
            path: packagePath,
            manifest: { publishConfig: { access: 'public' }, dependencies },
        });
        const toolPackages = new Map([
            ['@pumpkin-plugins/consumer', publicTool('tools/consumer', { '@pumpkin-plugins/build': '^0.1.0' })],
            ['@pumpkin-plugins/build', publicTool('tools/build', { '@pumpkin-plugins/colors': '^0.1.0' })],
            ['@pumpkin-plugins/colors', publicTool('tools/colors')],
        ]);
        const root = mkdtempSync(join(tmpdir(), 'release-transitive-tool-dependencies-'));
        try {
            writeToolPackages(root, toolPackages);
            const plugin = bundledChangesPlugin(
                {},
                'master',
                toolPackages,
                { 'tools/consumer': '0.1.0', 'tools/build': '0.1.0', 'tools/colors': '0.0.0' },
                500,
                () => {},
                root,
            );

            assert.deepEqual(await plugin.run([{ path: 'tools/consumer' }]), []);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('defers a public tool until dependencies declared by its packed templates have released', async () => {
        const root = mkdtempSync(join(tmpdir(), 'release-template-dependencies-'));
        try {
            const publicTool = (packagePath, dependencies = {}) => ({
                path: packagePath,
                manifest: { publishConfig: { access: 'public' }, dependencies },
            });
            const toolPackages = new Map([
                [
                    'create-pumpkin-plugin',
                    {
                        path: 'tools/create-pumpkin-plugin',
                        manifest: { files: ['templates'], publishConfig: { access: 'public' }, dependencies: {} },
                    },
                ],
                ['@pumpkin-plugins/build', publicTool('tools/build')],
                ['@pumpkin-plugins/pumpkin-api', publicTool('tools/pumpkin-api')],
            ]);
            writeToolPackages(root, toolPackages);
            const templateManifest = join(root, 'tools/create-pumpkin-plugin/templates/typescript/package.json');
            mkdirSync(dirname(templateManifest), { recursive: true });
            writeFileSync(
                templateManifest,
                JSON.stringify({
                    dependencies: {
                        '@pumpkin-plugins/build': '^0.1.0',
                        '@pumpkin-plugins/pumpkin-api': '^0.1.0',
                    },
                }),
            );
            const candidate = { path: 'tools/create-pumpkin-plugin' };
            const blockedPlugin = bundledChangesPlugin(
                {},
                'master',
                toolPackages,
                {
                    'tools/create-pumpkin-plugin': '0.0.0',
                    'tools/build': '0.1.0',
                    'tools/pumpkin-api': '0.0.0',
                },
                500,
                () => {},
                root,
            );
            const readyPlugin = bundledChangesPlugin(
                {},
                'master',
                toolPackages,
                {
                    'tools/create-pumpkin-plugin': '0.0.0',
                    'tools/build': '0.1.0',
                    'tools/pumpkin-api': '0.1.0',
                },
                500,
                () => {},
                root,
            );

            assert.deepEqual(await blockedPlugin.run([candidate]), []);
            assert.deepEqual(await readyPlugin.run([candidate]), [candidate]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('does not resolve imports inside packed tool templates as tool source dependencies', async () => {
        const root = mkdtempSync(join(tmpdir(), 'release-template-source-'));
        try {
            const toolPackages = new Map([
                [
                    'create-pumpkin-plugin',
                    {
                        path: 'tools/create-pumpkin-plugin',
                        manifest: { files: ['templates'], publishConfig: { access: 'public' } },
                    },
                ],
                [
                    '@pumpkin-plugins/pumpkin-api',
                    {
                        path: 'tools/pumpkin-api',
                        manifest: { publishConfig: { access: 'public' } },
                    },
                ],
            ]);
            writeToolPackages(root, toolPackages);
            writeFileSync(join(root, 'tsconfig.base.json'), JSON.stringify({ compilerOptions: {} }));

            const templateEntry = join(root, 'tools/create-pumpkin-plugin/templates/javascript/src/plugin.js');
            mkdirSync(dirname(templateEntry), { recursive: true });
            writeFileSync(templateEntry, "import { Plugin } from '@pumpkin-plugins/pumpkin-api';\n");

            const plugin = bundledChangesPlugin(
                {
                    async *mergeCommitIterator() {
                        yield commit('base', []);
                    },
                },
                'master',
                toolPackages,
                { 'tools/create-pumpkin-plugin': '0.1.0', 'tools/pumpkin-api': '0.1.0' },
                500,
                () => {},
                root,
            );
            const commitsByPath = {};

            await plugin.preconfigure({ 'tools/create-pumpkin-plugin': {} }, commitsByPath, {
                'tools/create-pumpkin-plugin': { sha: 'base' },
            });

            assert.deepEqual(commitsByPath['tools/create-pumpkin-plugin'], []);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('keeps public tool releases scoped to their own source files', async () => {
        const history = [
            commit('builder-change', ['tools/build/src/cli.ts']),
            commit('api-change', ['tools/pumpkin-api/src/core.ts']),
            commit('runtime-change', ['tools/static-hermes-runtime/src/index.ts']),
            commit('unrelated', ['tools/plugin-kit/src/host.ts']),
            commit('boundary', ['tools/build/package.json']),
        ];
        const github = {
            async *mergeCommitIterator() {
                yield* history;
            },
        };
        const plugin = bundledChangesPlugin(github, 'master', packages, { 'tools/build': '0.1.0' });
        const strategies = { 'tools/build': {} };
        const commits = { 'tools/build': [] };
        const releases = { 'tools/build': { tag: new TestTagName('0.1.0', 'build'), sha: 'boundary' } };

        await plugin.preconfigure(strategies, commits, releases);

        assert.deepEqual(
            commits['tools/build'].map((entry) => entry.sha),
            ['builder-change'],
        );
    });

    it('selects public tool commits by the files the package publishes', async () => {
        const root = writeWorkspace({
            'tools/plugin-kit/package.json': {
                name: '@pumpkin-plugins/plugin-kit',
                publishConfig: { access: 'public' },
                files: ['src/**/*.ts', '!src/**/*.test.ts', 'templates'],
            },
        });
        try {
            const history = [
                commit('testing-helper', ['tools/plugin-kit/src/testing/memory-files.ts']),
                commit('template-readme', ['tools/plugin-kit/templates/typescript/README.md']),
                commit('unit-test', ['tools/plugin-kit/src/host.test.ts']),
                commit('unpacked-notes', ['tools/plugin-kit/notes.md']),
                commit('boundary', ['tools/plugin-kit/package.json']),
            ];
            const github = {
                async *mergeCommitIterator() {
                    yield* history;
                },
            };
            const plugin = bundledChangesPlugin(
                github,
                'master',
                workspacePackages(root),
                { 'tools/plugin-kit': '0.1.0' },
                500,
                () => {},
                root,
            );
            const commits = { 'tools/plugin-kit': [] };

            await plugin.preconfigure({ 'tools/plugin-kit': {} }, commits, { 'tools/plugin-kit': { sha: 'boundary' } });

            assert.deepEqual(
                commits['tools/plugin-kit'].map((entry) => entry.sha),
                ['testing-helper', 'template-readme'],
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('falls back to the latest published release below a missing manifest release', async () => {
        await inPluginWorkspace(async (root, fixturePackages) => {
            const history = [
                commit('after-release', ['packages/plugin/src/plugin.ts']),
                commit('release-0.0.4', ['packages/plugin/package.json'], 'chore(master): release plugin 0.0.4'),
                commit('published-0.0.3', ['packages/plugin/package.json'], 'chore(master): release plugin 0.0.3'),
                commit('before-release', ['packages/plugin/src/old.ts']),
            ];
            const github = {
                async *releaseIterator() {
                    yield { tagName: 'plugin-v0.0.3', sha: 'published-0.0.3' };
                },
                async *mergeCommitIterator() {
                    yield* history;
                },
            };
            const plugin = bundledChangesPlugin(
                github,
                'master',
                fixturePackages,
                { 'packages/plugin': '0.0.4' },
                500,
                () => {},
                root,
            );
            const strategies = { 'packages/plugin': {} };
            const scoped = { 'packages/plugin': [] };
            const releases = {
                'packages/plugin': {
                    tag: new TestTagName('0.0.4'),
                    sha: '',
                },
            };

            await plugin.preconfigure(strategies, scoped, releases);

            assert.equal(releases['packages/plugin'].sha, 'published-0.0.3');
            assert.equal(releases['packages/plugin'].tag.version.toString(), '0.0.3');
            assert.deepEqual(scoped['packages/plugin'], history.slice(0, 2));
        });
    });

    it('starts first-release notes at the package introduction when no earlier release is published', async () => {
        const packagePath = 'tools/cspell-dict-minecraft';
        const history = [
            commit('after-introduction', [`${packagePath}/src/words.txt`]),
            commit('introduction', [`${packagePath}/package.json`, `${packagePath}/src/words.txt`]),
        ];
        const github = {
            getGitHubApi() {
                return {
                    repository: { owner: 'owner', repo: 'repo' },
                    octokit: {
                        rest: { repos: { listCommits: 'listCommits' } },
                        async paginate(_endpoint, options) {
                            assert.deepEqual(options, {
                                owner: 'owner',
                                repo: 'repo',
                                sha: 'master',
                                path: `${packagePath}/package.json`,
                                per_page: 100,
                            });
                            return [{ sha: 'latest' }, { sha: 'introduction' }];
                        },
                    },
                };
            },
            async *releaseIterator() {},
            async *mergeCommitIterator() {
                yield* history;
            },
        };
        const plugin = bundledChangesPlugin(github, 'master', packages, { [packagePath]: '0.1.0' });
        const commits = { [packagePath]: [] };
        const releases = {
            [packagePath]: { tag: new TestTagName('0.1.0', 'cspell-dict-minecraft'), sha: '' },
        };

        await plugin.preconfigure({ [packagePath]: {} }, commits, releases);

        assert.equal(releases[packagePath].sha, 'introduction');
        assert.deepEqual(
            commits[packagePath].map((entry) => entry.sha),
            ['after-introduction', 'introduction'],
        );
    });

    it('routes an empty Release-As commit only to its matching component', async () => {
        await inPluginWorkspace(async (root, fixturePackages) => {
            const history = [
                commit('plugin-release-as', [], 'chore(plugin): recover release\n\nRelease-As: 0.0.5'),
                commit('unscoped-release-as', [], 'chore: recover release\n\nRelease-As: 0.0.5'),
                commit('boundary', ['packages/plugin/package.json']),
            ];
            const github = {
                async *mergeCommitIterator() {
                    yield* history;
                },
            };
            const plugin = bundledChangesPlugin(
                github,
                'master',
                fixturePackages,
                {
                    'packages/plugin': '0.0.4',
                    'actions/sign-pumpkin-plugin': '0.0.0',
                },
                500,
                () => {},
                root,
            );
            const strategies = { 'packages/plugin': {}, 'actions/sign-pumpkin-plugin': {} };
            const commits = {
                'packages/plugin': [],
                'actions/sign-pumpkin-plugin': history.slice(0, 2),
            };
            const releases = { 'packages/plugin': { tag: {}, sha: 'boundary' } };

            await plugin.preconfigure(strategies, commits, releases);

            assert.deepEqual(
                commits['packages/plugin'].map((entry) => entry.sha),
                ['plugin-release-as'],
            );
            assert.deepEqual(commits['actions/sign-pumpkin-plugin'], []);
        });
    });

    it('leaves first-release action commits to Release Please', async () => {
        let fetchedHistory = false;
        const github = {
            async *mergeCommitIterator() {
                fetchedHistory = true;
                yield commit('initial', []);
            },
        };
        const plugin = bundledChangesPlugin(github, 'master', packages, { 'actions/publish-action': '0.0.0' });
        const strategies = { 'actions/publish-action': {} };
        const commits = { 'actions/publish-action': ['simple strategy commits'] };
        assert.equal(await plugin.preconfigure(strategies, commits, {}), strategies);
        assert.equal(fetchedHistory, true);
        assert.deepEqual(commits['actions/publish-action'], ['simple strategy commits']);
    });

    it('limits first-release history to the commit that added the package', async () => {
        await inPluginWorkspace(async (root, fixturePackages) => {
            const history = [
                commit('after-addition', ['packages/plugin/src/plugin.ts']),
                commit('added', ['packages/plugin/package.json', 'packages/plugin/src/plugin.ts']),
                ...Array.from({ length: 500 }, (_, index) => commit(`older-${index}`, ['README.md'])),
            ];
            const github = {
                getGitHubApi() {
                    return {
                        repository: { owner: 'owner', repo: 'repo' },
                        octokit: {
                            rest: { repos: { listCommits: 'listCommits' } },
                            async paginate(_endpoint, options) {
                                assert.deepEqual(options, {
                                    owner: 'owner',
                                    repo: 'repo',
                                    sha: 'master',
                                    path: 'packages/plugin/package.json',
                                    per_page: 100,
                                });
                                return [{ sha: 'manifest-update' }, { sha: 'added' }];
                            },
                        },
                    };
                },
                async *mergeCommitIterator(_branch, { maxResults }) {
                    yield* history.slice(0, maxResults);
                },
            };
            const plugin = bundledChangesPlugin(
                github,
                'master',
                fixturePackages,
                { 'packages/plugin': '0.0.0' },
                500,
                () => {},
                root,
            );
            const commits = { 'packages/plugin': [] };

            await plugin.preconfigure({ 'packages/plugin': {} }, commits, {});

            assert.deepEqual(
                commits['packages/plugin'].map((entry) => entry.sha),
                ['after-addition', 'added'],
            );
        });
    });

    it('stops first-release history at the introduction commit when another component reaches further back', async () => {
        const root = pluginWorkspace();
        try {
            const history = [
                commit('after-addition', ['packages/plugin/src/plugin.ts']),
                commit('added', ['packages/plugin/package.json', 'packages/plugin/src/plugin.ts']),
                commit('older-build-fix', ['tools/build/src/index.ts']),
                commit('build-release', ['tools/build/package.json']),
            ];
            const github = {
                getGitHubApi: () => introductionCommitApi('packages/plugin', 'added'),
                async *mergeCommitIterator() {
                    yield* history;
                },
            };
            const plugin = bundledChangesPlugin(
                github,
                'master',
                workspacePackages(root),
                { 'packages/plugin': '0.0.0', 'tools/build': '0.1.0' },
                500,
                () => {},
                root,
            );
            const commits = { 'packages/plugin': [], 'tools/build': [] };

            await plugin.preconfigure({ 'packages/plugin': {}, 'tools/build': {} }, commits, {
                'tools/build': { sha: 'build-release' },
            });

            assert.deepEqual(
                commits['packages/plugin'].map((entry) => entry.sha),
                ['after-addition', 'added'],
            );
            assert.deepEqual(
                commits['tools/build'].map((entry) => entry.sha),
                ['older-build-fix'],
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('fetches enough history to reach an unreleased public tool boundary', async () => {
        const history = [
            commit('after-release', ['tools/build/src/index.ts']),
            ...Array.from({ length: 716 }, (_, index) => commit(`older-${index}`, ['README.md'])),
            commit('boundary', ['tools/build/package.json']),
        ];
        const github = {
            async *mergeCommitIterator(_branch, { maxResults }) {
                yield* history.slice(0, maxResults);
            },
        };
        const plugin = bundledChangesPlugin(
            github,
            'master',
            packages,
            { 'tools/build': '0.1.0' },
            releaseConfig['commit-search-depth'],
        );
        const commits = { 'tools/build': [] };

        await plugin.preconfigure({ 'tools/build': {} }, commits, { 'tools/build': { sha: 'boundary' } });

        assert.deepEqual(
            commits['tools/build'].map((entry) => entry.sha),
            ['after-release'],
        );
    });

    it('trims action notes to the previous published tag when the manifest release SHA is missing', async () => {
        const history = [
            commit('after-first-release', ['actions/publish-action/src/index.mjs']),
            commit('first-release', ['actions/publish-action/version.txt'], 'chore: release publish-action 0.0.1'),
        ];
        const github = {
            async *releaseIterator() {
                yield { tagName: 'publish-action-v0.0.1', sha: 'first-release' };
            },
            async *mergeCommitIterator() {
                yield* history;
            },
        };
        const plugin = bundledChangesPlugin(github, 'master', packages, { 'actions/publish-action': '0.0.2' });
        const commits = { 'actions/publish-action': history };
        const releases = {
            'actions/publish-action': {
                tag: new TestTagName('0.0.2', 'publish-action'),
                sha: '',
            },
        };

        await plugin.preconfigure({ 'actions/publish-action': {} }, commits, releases);

        assert.equal(releases['actions/publish-action'].sha, 'first-release');
        assert.deepEqual(
            commits['actions/publish-action'].map((entry) => entry.sha),
            ['after-first-release'],
        );
    });

    it('rejects truncated initial-release histories rather than quietly omitting changes', async () => {
        const github = {
            getGitHubApi() {
                return {
                    repository: { owner: 'owner', repo: 'repo' },
                    octokit: {
                        rest: { repos: { listCommits: 'listCommits' } },
                        async paginate() {
                            return [{ sha: 'two' }];
                        },
                    },
                };
            },
            async *mergeCommitIterator() {
                yield commit('one', []);
                yield commit('two', []);
            },
        };
        const plugin = bundledChangesPlugin(github, 'master', packages, { 'packages/plugin': '0.0.0' }, 1);
        await assert.rejects(plugin.preconfigure({ 'packages/plugin': {} }, {}, {}), /history exceeds 1 commits/);
    });
});
