import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { collectReleaseFanout } from './utils/release-fanout.mjs';
import { recoverImmutableReleaseConflict } from './utils/release-recovery.mjs';

const root = resolve(import.meta.dirname, '..');
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
const [codemodMajor, codemodMinor, codemodPatch] = codemodVersion.split('.').map(Number);
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
const immutableTagConflict = Object.assign(new Error('GitHub rejected an immutable release tag'), {
    status: 422,
    body: { errors: [{ field: 'tag_name', message: 'tag_name was used by an immutable release' }] },
});
const immutableCandidate = {
    tagName: codemod.tagName,
    sha: codemod.sha,
    path: 'tools/codemod',
    version: codemodVersion,
    major: codemodMajor,
    minor: codemodMinor,
    patch: codemodPatch,
};

function collect(options = {}) {
    return collectReleaseFanout({ ...baseOptions, ...options });
}

function recoverImmutable(options = {}) {
    return recoverImmutableReleaseConflict({
        error: immutableTagConflict,
        getCandidates: () => [immutableCandidate],
        pullRequestNumber: 123,
        labelingEnabled: true,
        findRelease: async (tagName) => (tagName === codemod.tagName ? codemod : undefined),
        restoreLabels: async () => {},
        ...options,
    });
}

it('reuses matching immutable-tag releases and restores release PR labels', async () => {
    let restoredLabelsFor;
    const recovered = await recoverImmutable({
        restoreLabels: async (pullRequestNumber) => {
            restoredLabelsFor = pullRequestNumber;
        },
    });

    assert.deepEqual(recovered, [
        {
            ...codemod,
            path: immutableCandidate.path,
            version: immutableCandidate.version,
            major: immutableCandidate.major,
            minor: immutableCandidate.minor,
            patch: immutableCandidate.patch,
            prNumber: 123,
            recovered: true,
        },
    ]);
    assert.equal(restoredLabelsFor, 123);
});

it('rethrows non-immutable release errors unchanged without resolving candidates', async () => {
    const error = new Error('GitHub API failed');
    let candidatesRead = false;

    await assert.rejects(
        recoverImmutable({
            error,
            getCandidates: () => {
                candidatesRead = true;
                return [immutableCandidate];
            },
        }),
        (caught) => caught === error,
    );
    assert.equal(candidatesRead, false);
});

it('recognizes only the immutable tag-name conflict', async () => {
    const unrelatedErrors = [
        Object.assign(new Error('Wrong status'), { status: 500, body: immutableTagConflict.body }),
        Object.assign(new Error('Wrong field'), {
            status: 422,
            body: { errors: [{ field: 'body', message: 'tag_name was used by an immutable release' }] },
        }),
        Object.assign(new Error('Wrong message'), {
            status: 422,
            body: { errors: [{ field: 'tag_name', message: 'tag already exists' }] },
        }),
    ];

    for (const error of unrelatedErrors) {
        await assert.rejects(recoverImmutable({ error }), (caught) => caught === error);
    }
});

it('fails with the immutable conflict as cause when the duplicate tag is missing', async () => {
    await assert.rejects(recoverImmutable({ findRelease: async () => undefined }), (error) => {
        assert.match(error.message, /no existing release was found/);
        assert.equal(error.cause, immutableTagConflict);
        return true;
    });
});

it('validates the entire candidate batch before restoring labels', async () => {
    const secondCandidate = { ...immutableCandidate, tagName: 'sample-v1.0.0', sha: 'expected-sha' };
    const lookedUpTags = [];
    let labelsRestored = false;

    await assert.rejects(
        recoverImmutable({
            getCandidates: () => [immutableCandidate, secondCandidate],
            findRelease: async (tagName) => {
                lookedUpTags.push(tagName);
                return tagName === immutableCandidate.tagName ? codemod : { tagName, sha: 'different-sha' };
            },
            restoreLabels: async () => {
                labelsRestored = true;
            },
        }),
        (error) => {
            assert.match(error.message, /points to different-sha/);
            assert.equal(error.cause, immutableTagConflict);
            return true;
        },
    );

    assert.deepEqual(lookedUpTags, [immutableCandidate.tagName, secondCandidate.tagName]);
    assert.equal(labelsRestored, false);
});

it('skips label restoration without a PR number or when labeling is disabled', async () => {
    for (const options of [
        { pullRequestNumber: undefined, labelingEnabled: true },
        { pullRequestNumber: 123, labelingEnabled: false },
    ]) {
        let labelsRestored = false;
        await recoverImmutable({
            ...options,
            restoreLabels: async () => {
                labelsRestored = true;
            },
        });
        assert.equal(labelsRestored, false);
    }
});

it('propagates label restoration failures', async () => {
    const labelError = new Error('Could not update release labels');

    await assert.rejects(
        recoverImmutable({
            restoreLabels: async () => {
                throw labelError;
            },
        }),
        (error) => error === labelError,
    );
});

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
        nativePaths: [],
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
        nativePaths: [],
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
