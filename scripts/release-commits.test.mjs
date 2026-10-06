import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { bundledChangesPlugin, bundledPaths, releaseCommits, workspacePackages } from './release-commits.mjs';

const packages = new Map([
    [
        'plugin',
        {
            path: 'packages/plugin',
            manifest: {
                dependencies: { kit: 'workspace:*' },
                devDependencies: { '@pumpkin-plugins/build': 'workspace:*', harness: 'workspace:*' }
            }
        }
    ],
    ['kit', { path: 'tools/plugin-kit', manifest: { dependencies: { updates: 'workspace:*' } } }],
    ['updates', { path: 'tools/update-check', manifest: { dependencies: { kit: 'workspace:*' } } }],
    ['@pumpkin-plugins/build', { path: 'tools/build', manifest: {} }],
    ['harness', { path: 'tools/test-harness', manifest: {} }]
]);
const commit = (sha, files, message = 'fix: ship a change') => ({ sha, files, message });

describe('bundled release commits', () => {
    it('ignores leftover directories without manifests and reads named workspace packages', () => {
        const root = mkdtempSync(join(tmpdir(), 'release-packages-'));
        try {
            mkdirSync(join(root, 'packages/plugin'), { recursive: true });
            mkdirSync(join(root, 'tools/removed-tool'), { recursive: true });
            writeFileSync(join(root, 'packages/plugin/package.json'), JSON.stringify({ name: 'plugin' }));
            assert.deepEqual(
                [...workspacePackages(root)],
                [['plugin', { path: 'packages/plugin', manifest: { name: 'plugin' } }]]
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('follows transitive runtime dependencies and the build tool without cycles or test dependencies', () => {
        assert.deepEqual([...bundledPaths(packages, 'packages/plugin')].sort(), [
            'packages/plugin',
            'tools/build',
            'tools/plugin-kit',
            'tools/update-check'
        ]);
        assert.throws(() => bundledPaths(packages, 'packages/missing'), /Unknown release package/);
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
            commit('old', ['tools/update-check/src/http.ts'])
        ];
        assert.deepEqual(
            releaseCommits(history, bundledPaths(packages, 'packages/plugin'), 'released').map((entry) => entry.sha),
            ['checker', 'shared', 'build', 'catalog']
        );
    });

    it('uses independent release boundaries and preserves empty Release-As commits', () => {
        const paths = new Set(['tools/update-check']);
        const history = [
            commit('new', ['tools/update-check/src/http.ts']),
            commit('release-as', [], 'chore: prepare release\n\nRelease-As: 1.0.0'),
            commit('recent-release', ['packages/other/package.json']),
            commit('older', ['tools/update-check/src/http.ts']),
            commit('old-release', ['packages/plugin/package.json'])
        ];
        assert.deepEqual(
            releaseCommits(history, paths, 'recent-release').map((entry) => entry.sha),
            ['new', 'release-as']
        );
        assert.deepEqual(
            releaseCommits(history, paths, 'old-release').map((entry) => entry.sha),
            ['new', 'release-as', 'older']
        );
        assert.equal(releaseCommits(history, paths).length, 3);
    });

    it('fails closed when history or changed-file metadata is missing', () => {
        assert.throws(() => releaseCommits([], new Set(), 'missing'), /missing from the fetched history/);
        assert.throws(() => releaseCommits([{ sha: 'missing-files' }], new Set()), /no changed-file list/);
    });

    it('keeps pending plugin changes while excluding an already published plugin from follow-up releases', () => {
        const history = [
            commit('released-a', ['packages/a/package.json', '.release-please-manifest.json'], 'chore: release a'),
            commit('shared-fix', ['tools/plugin-kit/src/host.ts']),
            commit('released-b', ['packages/b/package.json'], 'chore: release b')
        ];
        const paths = new Set(['tools/plugin-kit']);
        assert.deepEqual(releaseCommits(history, paths, 'released-a'), []);
        assert.deepEqual(releaseCommits(history, paths, 'released-b'), [history[1]]);
    });

    it('supplies unfiltered shared commits to the public preconfigure hook', async () => {
        const history = [
            commit('update', ['tools/update-check/src/http.ts']),
            commit('boundary', ['packages/plugin/package.json'])
        ];
        const github = {
            async *mergeCommitIterator() {
                yield* history;
            }
        };
        const plugin = bundledChangesPlugin(github, 'master', packages, { 'packages/plugin': '0.0.1' });
        const strategies = { 'packages/plugin': {} };
        const scoped = { 'packages/plugin': [] };
        assert.equal(
            await plugin.preconfigure(strategies, scoped, { 'packages/plugin': { sha: 'boundary' } }),
            strategies
        );
        assert.deepEqual(scoped['packages/plugin'], [history[0]]);
    });

    it('leaves action release strategies to Release Please without fetching plugin history', async () => {
        let fetchedHistory = false;
        const github = {
            async *mergeCommitIterator() {
                fetchedHistory = true;
                yield null;
            }
        };
        const plugin = bundledChangesPlugin(github, 'master', packages, {});
        const strategies = { 'actions/publish-action': {} };
        const commits = { 'actions/publish-action': ['simple strategy commits'] };
        assert.equal(await plugin.preconfigure(strategies, commits, {}), strategies);
        assert.equal(fetchedHistory, false);
        assert.deepEqual(commits['actions/publish-action'], ['simple strategy commits']);
    });

    it('rejects truncated initial-release histories rather than quietly omitting changes', async () => {
        const github = {
            async *mergeCommitIterator() {
                yield commit('one', []);
                yield commit('two', []);
            }
        };
        const plugin = bundledChangesPlugin(github, 'master', packages, { 'packages/plugin': '0.0.0' }, 1);
        await assert.rejects(plugin.preconfigure({ 'packages/plugin': {} }, {}, {}), /history exceeds 1 commits/);
    });
});
