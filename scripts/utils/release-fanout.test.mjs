import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { collectReleaseFanout, releaseOutputs } from './release-fanout.mjs';

const root = resolve(import.meta.dirname, '../..');
const releaseConfig = JSON.parse(readFileSync(resolve(root, 'release-please-config.json'), 'utf8'));
const releaseManifest = JSON.parse(readFileSync(resolve(root, '.release-please-manifest.json'), 'utf8'));
const upnpumpkinConfig = {
    ...releaseConfig.packages['packages/upnpumpkin'],
    includeComponentInTag: releaseConfig['include-component-in-tag'],
    includeVInTag: releaseConfig['include-v-in-tag'],
    tagSeparator: releaseConfig['tag-separator'],
};
const upnpumpkinRelease = {
    tagName: 'upnpumpkin-v0.0.8',
    sha: 'plugin-release-sha',
    notes: 'UPnPumpkin release notes',
};
const codemodConfig = {
    ...releaseConfig.packages['tools/codemod'],
    includeComponentInTag: releaseConfig['include-component-in-tag'],
    includeVInTag: releaseConfig['include-v-in-tag'],
    tagSeparator: releaseConfig['tag-separator'],
};
const codemodVersion = releaseManifest['tools/codemod'];
const codemodComponentPrefix =
    codemodConfig.includeComponentInTag === false
        ? ''
        : `${codemodConfig.component}${codemodConfig.tagSeparator ?? '-'}`;
const codemodVersionPrefix = codemodConfig.includeVInTag === false ? '' : 'v';
const codemodTagName = `${codemodComponentPrefix}${codemodVersionPrefix}${codemodVersion}`;
const codemod = {
    tagName: codemodTagName,
    sha: 'release-sha',
    notes: 'Codemod release notes',
    url: 'https://example.com/release',
    uploadUrl: 'https://example.com/upload',
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

    assert.deepEqual(result.releases, [
        { ...codemod, path: 'tools/codemod', version: codemodVersion, recovered: true },
    ]);
    assert.deepEqual(result.paths, {
        pluginPaths: [],
        actionPaths: [],
        toolPaths: ['tools/codemod'],
        extensionPaths: [],
    });
});

it('catches up a first-parent plugin release when both GitHub assets are missing', async () => {
    const result = await collect({
        repositoryConfig: { 'packages/upnpumpkin': upnpumpkinConfig },
        releasedVersions: {},
        existingReleases: [upnpumpkinRelease],
        firstParentShas: new Set(['release-sha', upnpumpkinRelease.sha]),
        getReleaseAssets: async () => ({ assets: [], immutable: false }),
    });

    assert.deepEqual(result.releases, [
        {
            ...upnpumpkinRelease,
            path: 'packages/upnpumpkin',
            version: '0.0.8',
            recovered: true,
            rebuildFromTag: true,
        },
    ]);
    assert.deepEqual(result.paths.pluginPaths, ['packages/upnpumpkin']);
});

it('ignores off-branch plugin releases and leaves complete asset pairs alone', async () => {
    const completeRelease = { ...upnpumpkinRelease, tagName: 'upnpumpkin-v0.0.7', sha: 'complete-release-sha' };
    const inspectedTags = [];
    const result = await collect({
        repositoryConfig: { 'packages/upnpumpkin': upnpumpkinConfig },
        releasedVersions: {},
        existingReleases: [{ ...upnpumpkinRelease, sha: 'off-branch-sha' }, completeRelease],
        firstParentShas: new Set(['release-sha', completeRelease.sha]),
        getReleaseAssets: async (tagName) => {
            inspectedTags.push(tagName);
            return {
                assets: ['upnpumpkin.wasm', 'upnpumpkin.wasm.sha256'],
                immutable: false,
            };
        },
    });

    assert.deepEqual(result.releases, []);
    assert.deepEqual(inspectedTags, [completeRelease.tagName]);
});

it('skips partial or immutable historical plugin releases with warnings', async () => {
    const immutableRelease = { ...upnpumpkinRelease, tagName: 'upnpumpkin-v0.0.7', sha: 'immutable-release-sha' };
    const warnings = [];
    const result = await collect({
        repositoryConfig: { 'packages/upnpumpkin': upnpumpkinConfig },
        releasedVersions: {},
        existingReleases: [upnpumpkinRelease, immutableRelease],
        firstParentShas: new Set(['release-sha', upnpumpkinRelease.sha, immutableRelease.sha]),
        getReleaseAssets: async (tagName) =>
            tagName === upnpumpkinRelease.tagName
                ? { assets: ['upnpumpkin.wasm'], immutable: false }
                : { assets: [], immutable: true },
        log: (message) => warnings.push(message),
    });

    assert.deepEqual(result.releases, []);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /partial asset pair/);
    assert.match(warnings[1], /immutable release/);
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

it('writes every release output that the release workflow reads', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8');
    // Release PR outputs come from the PR step, not from the release fan-out.
    const pullRequestOutputs = new Set(['prs', 'pr_count']);
    const readOutputs = [...workflow.matchAll(/steps\.release\.outputs\.(\w+)/g)]
        .map(([, name]) => name)
        .filter((name) => !pullRequestOutputs.has(name));
    const readKeys = [...workflow.matchAll(/fromJSON\(needs\.release\.outputs\.(\w+)\)\[format\('\{0\}--(\w+)'/g)].map(
        ([, output, key]) => ({ output, key }),
    );
    assert.ok(readOutputs.includes('paths_released'));
    assert.ok(readKeys.some(({ output, key }) => output === 'release_metadata' && key === 'tag_name'));

    const release = { ...upnpumpkinRelease, sha: 'a'.repeat(40), path: 'packages/upnpumpkin', version: '0.0.8' };
    const outputs = releaseOutputs([release], {
        pluginPaths: ['packages/upnpumpkin'],
        actionPaths: [],
        toolPaths: [],
        extensionPaths: [],
    });

    for (const name of readOutputs) assert.equal(typeof outputs[name], 'string', `${name} must be a string output`);
    assert.deepEqual(JSON.parse(outputs.paths_released), ['packages/upnpumpkin']);
    assert.equal(outputs.release_count, '1');
    for (const { output, key } of readKeys) {
        assert.ok(
            JSON.parse(outputs[output])[`${release.path}--${key}`],
            `${output} must hold ${release.path}--${key}`,
        );
    }
});
