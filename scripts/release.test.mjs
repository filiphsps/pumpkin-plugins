import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

function run(args, overrides = {}) {
    const root = mkdtempSync(join(tmpdir(), 'release-runner-'));
    try {
        const runtime = join(root, 'node_modules/release-please');
        mkdirSync(runtime, { recursive: true });
        writeFileSync(
            join(runtime, 'index.js'),
            `
            const { appendFileSync } = require('node:fs');
            const record = (call) => appendFileSync(process.env.CALLS_FILE, call + '\\n');
            const recordVersioning = (config) => appendFileSync(process.env.VERSIONING_FILE, JSON.stringify(config) + '\\n');
            let published = false;
            const github = {
                repository: { defaultBranch: 'master' },
                getCommitFiles: async (sha) => {
                    record('backfill:' + sha);
                    return sha === 'empty-file-list-sha' ? [] : ['packages/plugin/src/plugin.ts'];
                },
                removeIssueLabels: async (labels, number) => record('remove:' + labels.join(',') + ':' + number),
                addIssueLabels: async (labels, number) => record('add:' + labels.join(',') + ':' + number),
                releaseIterator: async function* () {
                    if (process.env.EXISTING_RELEASES) {
                        yield* JSON.parse(process.env.EXISTING_RELEASES);
                        return;
                    }
                    yield {
                        tagName: 'plugin-v1.0.0', sha: process.env.EXISTING_RELEASE_SHA ?? 'release-sha',
                        notes: 'Features\\n\\n* Added update checks',
                        url: 'https://example.com/release', uploadUrl: 'https://example.com/upload'
                    };
                }
            };
            module.exports = {
                VERSION: '17.11.2',
                GitHub: { create: async () => github },
                Manifest: { fromManifest: async (github) => {
                    const latestReleasePublished = published;
                    const repositoryConfig = {
                        'packages/plugin': { component: 'plugin', bumpMinorPreMajor: false, bumpPatchForMinorPreMajor: false },
                        'tools/codemod': { component: 'codemod', includeComponentInTag: true, includeVInTag: true },
                        'actions/publish-action': { bumpMinorPreMajor: false, bumpPatchForMinorPreMajor: false }
                    };
                    const candidate = (path, tagName, notes, version) => ({
                        path, sha: 'release-sha', notes,
                        tag: {
                            toString: () => tagName,
                            version: {
                                toString: () => version,
                                major: Number(version.split('.')[0]),
                                minor: Number(version.split('.')[1]),
                                patch: Number(version.split('.')[2])
                            }
                        }
                    });
                    const plugin = candidate('packages/plugin', 'plugin-v1.0.0', 'Features\\n\\n* Added update checks', '1.0.0');
                    const action = candidate('actions/publish-action', 'publish-action-v0.0.1', 'Features\\n\\n* Add warning mode', '0.0.1');
                    const releaseItems = [plugin, action];
                    const releaseGroups = process.env.RELEASE_ERROR === 'immutable'
                        ? [{ error: 'immutable', releases: [plugin] }]
                        : process.env.RELEASE_ERROR === 'immutable-with-success'
                          ? [{ error: 'immutable', releases: [plugin] }, { releases: [action] }]
                          : [{ error: process.env.RELEASE_ERROR, releases: releaseItems }];
                    return {
                    plugins: [], releasedVersions: { 'packages/plugin': '1.0.0', 'tools/codemod': '0.1.0' }, commitSearchDepth: 500, repositoryConfig,
                    labels: ['autorelease: pending'], releaseLabels: ['autorelease: tagged'],
                    createReleases: async function () {
                        recordVersioning(this.repositoryConfig);
                        record('release');
                        const releases = [];
                        if (process.env.NO_NEW_RELEASES === 'true') return releases;
                        for (const group of releaseGroups) {
                            releases.push(
                                ...await this.createReleasesForPullRequest(group.releases, {
                                    number: 52,
                                    error: group.error
                                })
                            );
                        }
                        published = true;
                        return releases;
                    },
                    createReleasesForPullRequest: async (candidates, pullRequest) => {
                        if (pullRequest.error === 'immutable') {
                            const error = new Error('Validation Failed: tag_name was used by an immutable release');
                            error.status = 422;
                            error.body = {
                                errors: [
                                    {
                                        field: 'tag_name',
                                        message: 'tag_name was used by an immutable release'
                                    }
                                ]
                            };
                            throw error;
                        }
                        if (pullRequest.error === 'other') {
                            const error = new Error('Validation Failed: repository rule violation');
                            error.status = 422;
                            throw error;
                        }
                        return candidates.map((release) => ({
                                path: release.path,
                                tagName: release.tag.toString(),
                                sha: release.sha,
                                notes: release.notes,
                                url: release.path.startsWith('actions/')
                                    ? 'https://example.com/action-release'
                                    : 'https://example.com/release',
                                uploadUrl: 'https://example.com/upload',
                                version: release.tag.version.toString()
                            }));
                    },
                    createPullRequests: async function () {
                        recordVersioning(this.repositoryConfig);
                        record('update-pr');
                        const prs = [{ headBranchName: 'release-branch' }];
                        if (published && !latestReleasePublished) prs.push({ headBranchName: 'empty-follow-up' });
                        return prs;
                    },
                    buildPullRequests: async function () {
                        recordVersioning(this.repositoryConfig);
                        record('preview');
                        if (process.env.EXERCISE_BACKFILL_CACHE === 'true') {
                            await github.getCommitFiles('history-sha');
                            await github.getCommitFiles('empty-file-list-sha');
                            if (process.env.EXTRA_BACKFILL_SHA) {
                                await github.getCommitFiles(process.env.EXTRA_BACKFILL_SHA);
                            }
                        }
                        return [{ title: 'Release', body: 'Update checks', headRefName: 'release-branch' }];
                    }
                }; } }
            };
        `,
        );
        const calls = join(root, 'calls');
        const output = join(root, 'output');
        const versioning = join(root, 'versioning');
        writeFileSync(calls, '');
        writeFileSync(output, '');
        writeFileSync(versioning, '');
        const result = spawnSync(
            process.execPath,
            [join(import.meta.dirname, 'release.mjs'), ...args, join(root, 'cli.js')],
            {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    GITHUB_REPOSITORY: 'owner/repo',
                    GITHUB_TOKEN: 'fixture',
                    GITHUB_SHA: 'release-sha',
                    GITHUB_OUTPUT: output,
                    CALLS_FILE: calls,
                    VERSIONING_FILE: versioning,
                    RELEASE_ERROR: '',
                    ...overrides,
                },
            },
        );
        return {
            ...result,
            calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean),
            output: readFileSync(output, 'utf8'),
            versioning: readFileSync(versioning, 'utf8')
                .trim()
                .split('\n')
                .filter(Boolean)
                .map((entry) => JSON.parse(entry)),
        };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

it('previews without publishing releases, modifying PRs or setting workflow outputs', () => {
    const result = run(['--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, ['preview']);
    assert.equal(JSON.parse(result.stdout)[0].body, 'Update checks');
    assert.equal(result.output, '');
});

it('reuses backfilled commit file lists across runs, including empty lists', () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'release-commit-files-'));
    const cachePath = join(cacheRoot, 'commit-files.json');
    try {
        const cold = run(['--dry-run'], {
            EXERCISE_BACKFILL_CACHE: 'true',
            RELEASE_COMMIT_FILES_CACHE: cachePath,
        });
        assert.equal(cold.status, 0, cold.stderr);
        assert.deepEqual(
            cold.calls.filter((call) => call.startsWith('backfill:')),
            ['backfill:history-sha', 'backfill:empty-file-list-sha'],
        );

        const incremental = run(['--dry-run'], {
            EXERCISE_BACKFILL_CACHE: 'true',
            RELEASE_COMMIT_FILES_CACHE: cachePath,
            EXTRA_BACKFILL_SHA: 'new-sha',
        });
        assert.equal(incremental.status, 0, incremental.stderr);
        assert.deepEqual(
            incremental.calls.filter((call) => call.startsWith('backfill:')),
            ['backfill:new-sha'],
        );

        const warm = run(['--dry-run'], {
            EXERCISE_BACKFILL_CACHE: 'true',
            RELEASE_COMMIT_FILES_CACHE: cachePath,
            EXTRA_BACKFILL_SHA: 'new-sha',
        });
        assert.equal(warm.status, 0, warm.stderr);
        assert.deepEqual(
            warm.calls.filter((call) => call.startsWith('backfill:')),
            [],
        );
    } finally {
        rmSync(cacheRoot, { recursive: true, force: true });
    }
});

it('prints Commander help before requiring the release-please executable', () => {
    const result = run(['--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: release/);
    assert.match(result.stdout, /--dry-run/);
    assert.match(result.stdout, /--component <name>/);
});

it('uses pre-major versioning for every component when creating releases and PRs', () => {
    const result = run([]);
    assert.equal(result.status, 0, result.stderr);
    const policy = {
        'packages/plugin': { component: 'plugin', bumpMinorPreMajor: true, bumpPatchForMinorPreMajor: true },
        'tools/codemod': {
            component: 'codemod',
            includeComponentInTag: true,
            includeVInTag: true,
            bumpMinorPreMajor: true,
            bumpPatchForMinorPreMajor: true,
        },
        'actions/publish-action': { bumpMinorPreMajor: true, bumpPatchForMinorPreMajor: true },
    };
    assert.deepEqual(result.versioning, [policy, policy]);
});

it('updates PRs without publishing when pull-requests-only is requested', () => {
    const result = run(['--pull-requests-only']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, ['update-pr']);
    assert.match(result.output, /paths_released<<[^\n]+\n\[\]\n/);
    assert.match(result.output, /action_paths_released<<[^\n]+\n\[\]\n/);
    assert.match(result.output, /"headBranchName":"release-branch"/);
});

it('preserves workflow tag and multiline release-note outputs for assets and Market publishing', () => {
    const result = run([]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, ['release', 'update-pr']);
    assert.match(result.output, /paths_released<<[^\n]+\n\["packages\/plugin"\]\n/);
    assert.match(result.output, /action_paths_released<<[^\n]+\n\["actions\/publish-action"\]\n/);
    assert.match(result.output, /packages\/plugin--tag_name<<[^\n]+\nplugin-v1\.0\.0\n/);
    assert.match(result.output, /packages\/plugin--body<<[^\n]+\nFeatures\n\n\* Added update checks\n/);
    assert.match(result.output, /actions\/publish-action--tag_name<<[^\n]+\npublish-action-v0\.0\.1\n/);
    assert.match(result.output, /actions\/publish-action--body<<[^\n]+\nFeatures\n\n\* Add warning mode\n/);
    assert.match(result.output, /release_count<<[^\n]+\n2\n/);
    assert.match(result.output, /pr_count<<[^\n]+\n1\n/);
    const metadata = result.output.match(/release_metadata<<([^\n]+)\n([^\n]+)\n\1\n/);
    assert.ok(metadata, 'release tag metadata should be a compact separate workflow output');
    assert.deepEqual(JSON.parse(metadata[2]), {
        'packages/plugin--tag_name': 'plugin-v1.0.0',
        'actions/publish-action--tag_name': 'publish-action-v0.0.1',
    });
    const releaseNotes = result.output.match(/release_notes<<([^\n]+)\n([^\n]+)\n\1\n/);
    assert.ok(releaseNotes, 'release notes should be published separately from tag metadata');
    assert.deepEqual(JSON.parse(releaseNotes[2]), {
        'packages/plugin--body': 'Features\n\n* Added update checks',
        'actions/publish-action--body': 'Features\n\n* Add warning mode',
    });
    assert.match(
        result.stdout,
        /Release fan-out: plugin paths=\["packages\/plugin"\], action paths=\["actions\/publish-action"\], tool paths=\[\], extension paths=\[\], release PR count=1/,
    );
});

it('continues release PR preparation when GitHub reports an immutable release for the tag', () => {
    const result = run([], { RELEASE_ERROR: 'immutable' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [
        'release',
        'remove:autorelease: pending:52',
        'add:autorelease: tagged:52',
        'update-pr',
    ]);
    assert.match(result.output, /paths_released<<[^\n]+\n\["packages\/plugin"\]\n/);
    assert.match(result.output, /packages\/plugin--release_created<<[^\n]+\nfalse\n/);
    assert.match(result.output, /packages\/plugin--release_recovered<<[^\n]+\ntrue\n/);
    assert.match(result.output, /release_count<<[^\n]+\n1\n/);
});

it('fails closed when the existing tag points to a different commit', () => {
    const result = run([], { RELEASE_ERROR: 'immutable', EXISTING_RELEASE_SHA: 'different-sha' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /but Release Please expects release-sha/);
    assert.deepEqual(result.calls, ['release']);
});

it('does not fan out an existing release from a run that built a different commit', () => {
    const result = run([], { RELEASE_ERROR: 'immutable', GITHUB_SHA: 'older-sha' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /paths_released<<[^\n]+\n\[\]\n/);
    assert.match(result.output, /release_count<<[^\n]+\n0\n/);
    assert.match(result.stdout, /Deferring plugin-v1\.0\.0 from artifact fan-out/);
});

it('preserves other releases when one release PR already has an immutable tag', () => {
    const result = run([], { RELEASE_ERROR: 'immutable-with-success' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [
        'release',
        'remove:autorelease: pending:52',
        'add:autorelease: tagged:52',
        'update-pr',
    ]);
    assert.match(result.output, /paths_released<<[^\n]+\n\["packages\/plugin"\]\n/);
    assert.match(result.output, /packages\/plugin--tag_name<<[^\n]+\nplugin-v1\.0\.0\n/);
});

it('does not hide other release API failures', () => {
    const result = run([], { RELEASE_ERROR: 'other' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /repository rule violation/);
    assert.deepEqual(result.calls, ['release']);
});

it('reloads release state after publishing before preparing the remaining PRs', () => {
    const result = run([]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, ['release', 'update-pr']);
    assert.match(result.output, /prs<<[^\n]+\n\[{"headBranchName":"release-branch"}\]\n/);
    assert.doesNotMatch(result.output, /empty-follow-up/);
});

it('rejects misspelled modes before making any GitHub changes', () => {
    const result = run(['--dryrun']);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, []);
});

const existingCodemodRelease = {
    tagName: 'codemod-v0.1.0',
    sha: 'release-sha',
    notes: 'Features\n\n* Add codemods',
    url: 'https://example.com/codemod-release',
    uploadUrl: 'https://example.com/codemod-upload',
};

it('fans out an already tagged npm release when the matching commit runs later', () => {
    const result = run([], {
        NO_NEW_RELEASES: 'true',
        EXISTING_RELEASES: JSON.stringify([existingCodemodRelease]),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /tool_paths_released<<[^\n]+\n\["tools\/codemod"\]\n/);
    assert.match(result.output, /tools\/codemod--tag_name<<[^\n]+\ncodemod-v0\.1\.0\n/);
    assert.match(result.output, /tools\/codemod--release_recovered<<[^\n]+\ntrue\n/);
    assert.match(result.output, /release_count<<[^\n]+\n1\n/);
    const metadata = result.output.match(/release_metadata<<([^\n]+)\n([^\n]+)\n\1\n/);
    assert.deepEqual(JSON.parse(metadata[2]), { 'tools/codemod--tag_name': 'codemod-v0.1.0' });
    const notes = result.output.match(/release_notes<<([^\n]+)\n([^\n]+)\n\1\n/);
    assert.deepEqual(JSON.parse(notes[2]), { 'tools/codemod--body': 'Features\n\n* Add codemods' });
});

it('combines previously tagged releases with new releases without duplicate fan-out', () => {
    const result = run([], {
        EXISTING_RELEASES: JSON.stringify([existingCodemodRelease, { tagName: 'plugin-v1.0.0', sha: 'release-sha' }]),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /release_count<<[^\n]+\n3\n/);
    assert.match(result.output, /paths_released<<[^\n]+\n\["packages\/plugin"\]\n/);
    assert.match(result.output, /tool_paths_released<<[^\n]+\n\["tools\/codemod"\]\n/);
    assert.match(result.output, /packages\/plugin--release_created<<[^\n]+\ntrue\n/);
});

it('ignores existing releases for other commits, versions and unregistered components', () => {
    const result = run([], {
        NO_NEW_RELEASES: 'true',
        EXISTING_RELEASES: JSON.stringify([
            { ...existingCodemodRelease, sha: 'other-sha' },
            { ...existingCodemodRelease, tagName: 'codemod-v0.0.0' },
            { ...existingCodemodRelease, tagName: 'unknown-v0.1.0' },
        ]),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /tool_paths_released<<[^\n]+\n\[\]\n/);
    assert.match(result.output, /release_count<<[^\n]+\n0\n/);
});
