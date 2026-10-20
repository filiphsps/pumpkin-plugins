import assert from 'node:assert/strict';
import { it } from 'node:test';
import { recoverImmutableReleaseConflict } from './release-recovery.mjs';

const codemod = {
    tagName: 'codemod-v0.1.3',
    sha: 'release-sha',
    notes: 'Codemod release notes',
    url: 'https://example.com/release',
    uploadUrl: 'https://example.com/upload',
};
const immutableTagConflict = Object.assign(new Error('GitHub rejected an immutable release tag'), {
    status: 422,
    body: { errors: [{ field: 'tag_name', message: 'tag_name was used by an immutable release' }] },
});
const immutableCandidate = {
    tagName: codemod.tagName,
    sha: codemod.sha,
    path: 'tools/codemod',
    version: '0.1.3',
    major: 0,
    minor: 1,
    patch: 3,
};

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
