import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as upstreamPins from './upstream-pins.mjs';

const pinBranch = 'automation/update-upstream-static-hermes';
const pinMarker = '<!-- upstream-pin:static-hermes -->';
const pinPath = 'tools/static-hermes-runtime/hermes-source.lock.json';

function input(overrides = {}) {
    return {
        sourceId: 'static-hermes',
        sourceName: 'Static Hermes',
        pinFile: pinPath,
        currentCommit: 'a'.repeat(40),
        latestCommit: 'b'.repeat(40),
        needsUpdate: true,
        compareUrl: `https://github.com/facebook/hermes/compare/${'a'.repeat(40)}...${'b'.repeat(40)}`,
        labels: ['dependencies', 'area: runtime', 'runtime: static-hermes'],
        validationResult: 'success',
        baseBranch: 'master',
        githubRunUrl: 'https://github.com/filiphsps/pumpkin-plugins/actions/runs/123',
        runnerTemp: '/tmp',
        workspaceRoot: '/repo',
        ...overrides,
    };
}

function runner({ pullRequests = [], issues = [], remoteBranch = '', stagedFiles = '' } = {}) {
    const calls = [];
    const writtenFiles = new Map();
    const run = (program, args) => {
        calls.push({ program, args });
        if (program === 'gh' && args[0] === 'pr' && args[1] === 'list') return JSON.stringify(pullRequests);
        if (program === 'gh' && args[0] === 'issue' && args[1] === 'list') return JSON.stringify(issues);
        if (program === 'git' && args[0] === 'ls-remote') return remoteBranch;
        if (program === 'git' && args[0] === 'diff' && args[1] === '--cached') return stagedFiles;
        return '';
    };
    const writeFile = (filePath, contents) => writtenFiles.set(filePath, contents);
    return { calls, writtenFiles, run, writeFile };
}

function hasCall(calls, program, args) {
    return calls.some((call) => call.program === program && JSON.stringify(call.args) === JSON.stringify(args));
}

it('closes obsolete PRs and issues and removes their update branch', () => {
    const state = runner({
        pullRequests: [{ number: 12, state: 'OPEN' }],
        issues: [
            { number: 33, state: 'OPEN', body: null },
            { number: 34, state: 'OPEN', body: pinMarker },
        ],
        remoteBranch: `${'c'.repeat(40)}\trefs/heads/${pinBranch}\n`,
    });

    upstreamPins.reconcileUpstreamPin(input({ needsUpdate: false }), state);

    assert.equal(hasCall(state.calls, 'gh', ['pr', 'close', '12']), true);
    assert.equal(hasCall(state.calls, 'gh', ['issue', 'close', '34']), true);
    assert.equal(hasCall(state.calls, 'git', ['push', 'origin', '--delete', pinBranch]), true);
});

it('turns a failed validation into an issue with labels and the compare link', () => {
    const state = runner({
        pullRequests: [{ number: 12, state: 'OPEN' }],
        issues: [{ number: 34, state: 'OPEN', body: pinMarker }],
        remoteBranch: `${'c'.repeat(40)}\trefs/heads/${pinBranch}\n`,
    });

    upstreamPins.reconcileUpstreamPin(input({ validationResult: 'failure' }), state);

    assert.equal(hasCall(state.calls, 'gh', ['pr', 'close', '12']), true);
    assert.equal(hasCall(state.calls, 'git', ['push', 'origin', '--delete', pinBranch]), true);
    assert.equal(
        hasCall(state.calls, 'gh', [
            'issue',
            'edit',
            '34',
            '--title',
            'Static Hermes: upstream pin needs manual review',
            '--body-file',
            '/tmp/upstream-pin-static-hermes-issue.md',
            '--add-label',
            'dependencies',
            '--add-label',
            'area: runtime',
            '--add-label',
            'runtime: static-hermes',
        ]),
        true,
    );
    const body = state.writtenFiles.get('/tmp/upstream-pin-static-hermes-issue.md');
    assert.match(body, /<!-- upstream-pin:static-hermes -->/);
    assert.match(body, /https:\/\/github\.com\/facebook\/hermes\/compare\//);
    assert.match(body, /actions\/runs\/123/);
});

it('creates or reopens an update PR after successful validation using the release bot identity', () => {
    const state = runner({
        pullRequests: [{ number: 56, state: 'CLOSED' }],
        issues: [{ number: 78, state: 'OPEN', body: pinMarker }],
        remoteBranch: `${'d'.repeat(40)}\trefs/heads/${pinBranch}\n`,
        stagedFiles: `${pinPath}\n`,
    });

    upstreamPins.reconcileUpstreamPin(input(), state);

    assert.equal(hasCall(state.calls, 'gh', ['issue', 'close', '78']), true);
    assert.equal(hasCall(state.calls, 'git', ['config', 'user.name', 'github-actions[bot]']), true);
    assert.equal(
        hasCall(state.calls, 'git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']),
        true,
    );
    assert.equal(
        hasCall(state.calls, 'git', [
            'push',
            `--force-with-lease=refs/heads/${pinBranch}:${'d'.repeat(40)}`,
            'origin',
            pinBranch,
        ]),
        true,
    );
    assert.equal(
        hasCall(state.calls, 'gh', [
            'pr',
            'edit',
            '56',
            '--title',
            'Static Hermes: update upstream pin',
            '--body-file',
            '/tmp/upstream-pin-static-hermes.md',
            '--add-label',
            'dependencies',
            '--add-label',
            'area: runtime',
            '--add-label',
            'runtime: static-hermes',
        ]),
        true,
    );
    assert.equal(hasCall(state.calls, 'gh', ['pr', 'reopen', '56']), true);
    const body = state.writtenFiles.get('/tmp/upstream-pin-static-hermes.md');
    assert.match(body, /Update Static Hermes from a{40} to b{40}/);
    assert.match(body, /https:\/\/github\.com\/facebook\/hermes\/compare\//);
    assert.match(body, /Validation passed/);
});
