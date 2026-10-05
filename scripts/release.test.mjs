import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

function run(args) {
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
                    return {
                    plugins: [], releasedVersions: {}, commitSearchDepth: 500,
                    createReleases: async () => { record('release'); published = true; return [{
                        path: 'packages/plugin', tagName: 'plugin-v1.0.0',
                        notes: 'Features\\n\\n* Added update checks', url: 'https://example.com/release'
                    }]; },
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
                    RELEASE_PLEASE_TOKEN: 'fixture',
                    GITHUB_OUTPUT: output,
                    CALLS_FILE: calls
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
    assert.match(result.output, /"headBranchName":"release-branch"/);
});

it('preserves workflow tag and multiline release-note outputs for assets and Market publishing', () => {
    const result = run([]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, ['release', 'update-pr']);
    assert.match(result.output, /paths_released<<[^\n]+\n\["packages\/plugin"\]\n/);
    assert.match(result.output, /packages\/plugin--tag_name<<[^\n]+\nplugin-v1\.0\.0\n/);
    assert.match(result.output, /packages\/plugin--body<<[^\n]+\nFeatures\n\n\* Added update checks\n/);
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
