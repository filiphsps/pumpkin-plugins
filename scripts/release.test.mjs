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
            let published = false;
            module.exports = {
                VERSION: '17.11.2',
                GitHub: { create: async () => ({ repository: { defaultBranch: 'master' } }) },
                Manifest: { fromManifest: async () => {
                    const latestReleasePublished = published;
                    const releaseItems = [{
                        path: 'packages/plugin', tagName: 'plugin-v1.0.0',
                        notes: 'Features\\n\\n* Added update checks', url: 'https://example.com/release'
                    }, {
                        path: 'actions/publish-action', tagName: 'publish-action-v0.0.1',
                        notes: 'Features\\n\\n* Add warning mode', url: 'https://example.com/action-release'
                    }];
                    const releaseGroups = process.env.RELEASE_ERROR === 'immutable-with-success'
                        ? [{ error: 'immutable', releases: [] }, { releases: [releaseItems[0]] }]
                        : [{ error: process.env.RELEASE_ERROR, releases: releaseItems }];
                    return {
                    plugins: [], releasedVersions: {}, commitSearchDepth: 500,
                    createReleases: async function () {
                        record('release');
                        const releases = [];
                        for (const group of releaseGroups) {
                            releases.push(...await this.createReleasesForPullRequest(group));
                        }
                        published = true;
                        return releases;
                    },
                    createReleasesForPullRequest: async (group) => {
                        if (group.error === 'immutable') {
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
                        if (group.error === 'other') {
                            const error = new Error('Validation Failed: repository rule violation');
                            error.status = 422;
                            throw error;
                        }
                        return group.releases;
                    },
                    createPullRequests: async () => {
                        record('update-pr');
                        const prs = [{ headBranchName: 'release-branch' }];
                        if (published && !latestReleasePublished) prs.push({ headBranchName: 'empty-follow-up' });
                        return prs;
                    },
                    buildPullRequests: async () => { record('preview'); return [{
                        title: 'Release', body: 'Update checks', headRefName: 'release-branch'
                    }]; }
                }; } }
            };
        `
        );
        const calls = join(root, 'calls');
        const output = join(root, 'output');
        writeFileSync(calls, '');
        writeFileSync(output, '');
        const result = spawnSync(
            process.execPath,
            [join(import.meta.dirname, 'release.mjs'), ...args, join(root, 'cli.js')],
            {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    GITHUB_REPOSITORY: 'owner/repo',
                    GITHUB_TOKEN: 'fixture',
                    GITHUB_OUTPUT: output,
                    CALLS_FILE: calls,
                    RELEASE_ERROR: '',
                    ...overrides
                }
            }
        );
        return {
            ...result,
            calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean),
            output: readFileSync(output, 'utf8')
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
});

it('continues release PR preparation when GitHub reports an immutable release for the tag', () => {
    const result = run([], { RELEASE_ERROR: 'immutable' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, ['release', 'update-pr']);
    assert.match(result.output, /paths_released<<[^\n]+\n\[\]\n/);
    assert.doesNotMatch(result.output, /packages\/plugin--release_created/);
});

it('preserves other releases when one release PR already has an immutable tag', () => {
    const result = run([], { RELEASE_ERROR: 'immutable-with-success' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, ['release', 'update-pr']);
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
