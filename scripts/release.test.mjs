import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { collectReleaseFanout } from './utils/release-fanout.mjs';

const root = resolve(import.meta.dirname, '..');
const releaseConfig = JSON.parse(readFileSync(resolve(root, 'release-please-config.json'), 'utf8'));
const releaseManifest = JSON.parse(readFileSync(resolve(root, '.release-please-manifest.json'), 'utf8'));
const codemod = {
    tagName: 'codemod-v0.1.0',
    sha: 'release-sha',
    notes: 'Codemod release notes',
    url: 'https://example.com/release',
    uploadUrl: 'https://example.com/upload',
};
const codemodConfig = {
    ...releaseConfig.packages['tools/codemod'],
    includeComponentInTag: releaseConfig['include-component-in-tag'],
    includeVInTag: releaseConfig['include-v-in-tag'],
    tagSeparator: releaseConfig['tag-separator'],
};
const codemodVersions = { 'tools/codemod': releaseManifest['tools/codemod'] };
const baseOptions = {
    createdReleases: [],
    repositoryConfig: { 'tools/codemod': codemodConfig },
    releasedVersions: codemodVersions,
    currentSha: 'release-sha',
    findRelease: async (tagName) => (tagName === codemod.tagName ? codemod : undefined),
    root,
    log: () => {},
};

function collect(options = {}) {
    return collectReleaseFanout({ ...baseOptions, ...options });
}

it('routes a previously created codemod release for its commit to npm publishing', async () => {
    const result = await collect();

    assert.deepEqual(result.releases, [{ ...codemod, path: 'tools/codemod', version: '0.1.0', recovered: true }]);
    assert.deepEqual(result.paths, {
        pluginPaths: [],
        actionPaths: [],
        toolPaths: ['tools/codemod'],
        extensionPaths: [],
    });
});

it('limits a manual release replay to npm packages at the requested release commit', async () => {
    const pluginRelease = { tagName: 'sample-plugin-v1.2.3', sha: 'release-sha' };
    const result = await collect({
        toolOnly: true,
        repositoryConfig: {
            ...baseOptions.repositoryConfig,
            'packages/sample-plugin': { component: 'sample-plugin' },
        },
        releasedVersions: { ...codemodVersions, 'packages/sample-plugin': '1.2.3' },
        findRelease: async (tagName) =>
            tagName === codemod.tagName ? codemod : tagName === pluginRelease.tagName ? pluginRelease : undefined,
    });

    assert.deepEqual(
        result.releases.map(({ path }) => path),
        ['tools/codemod'],
    );
    assert.deepEqual(result.paths, {
        pluginPaths: [],
        actionPaths: [],
        toolPaths: ['tools/codemod'],
        extensionPaths: [],
    });
});

it('fails a manual release replay when no npm tag targets the requested commit', async () => {
    await assert.rejects(collect({ toolOnly: true, currentSha: 'later-commit' }), /No npm tool release targets/);
});

it('does not recover a release that targets a different commit', async () => {
    const result = await collect({ currentSha: 'later-commit' });

    assert.deepEqual(result.releases, []);
    assert.deepEqual(result.paths.toolPaths, []);
});

it('does not recover a stale release when the manifest has a newer version', async () => {
    const result = await collect({ releasedVersions: { 'tools/codemod': '0.2.0' } });

    assert.deepEqual(result.releases, []);
    assert.deepEqual(result.paths.toolPaths, []);
});

it('preserves new releases and does not look them up a second time', async () => {
    const findReleaseCalls = [];
    const result = await collect({
        createdReleases: [{ ...codemod, path: 'tools/codemod', version: '0.1.0' }],
        findRelease: async (tagName) => {
            findReleaseCalls.push(tagName);
            return codemod;
        },
    });

    assert.equal(result.releases.length, 1);
    assert.equal(result.releases[0].path, 'tools/codemod');
    assert.deepEqual(result.paths.toolPaths, ['tools/codemod']);
    assert.deepEqual(findReleaseCalls, []);
});

it('does not recover components configured to skip GitHub releases', async () => {
    const result = await collect({
        repositoryConfig: { 'tools/codemod': { ...codemodConfig, skipGithubRelease: true } },
    });

    assert.deepEqual(result.releases, []);
    assert.deepEqual(result.paths.toolPaths, []);
});

it('rejects releases without a target commit before building the publisher fanout', async () => {
    await assert.rejects(
        collect({ createdReleases: [{ tagName: codemod.tagName, path: 'tools/codemod', version: '0.1.0' }] }),
        /has no target commit SHA/,
    );
});
