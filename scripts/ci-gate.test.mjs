// Tests the CI job selection and the result check behind the `ci-result` job. Run with
// `pnpm test:scripts`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkResults, selectJobs } from './ci-gate.mjs';

/** Classifier outputs for a change that touches nothing CI checks. */
const nothing = {
    code: 'false',
    config_only: 'false',
    skip_expensive_checks: 'false',
    actions: '[]',
    actions_to_test: '[]',
    extensions: '[]',
    extensions_to_test: '[]',
    generated_readmes: 'false',
    generator: 'false',
    integration_scope: 'none',
};

/** Builds the `needs` context the `ci-result` job receives. */
function needs(outputs, event, results) {
    const jobs = JSON.stringify(selectJobs(outputs, event));
    const context = { changes: { result: 'success', outputs: { ...outputs, jobs } } };
    for (const job of Object.keys(selectJobs(nothing, 'push'))) {
        context[job] = { result: results[job] ?? (selectJobs(outputs, event)[job] ? 'success' : 'skipped') };
    }
    return context;
}

describe('selectJobs', () => {
    it('runs the code jobs and the full suites for a plugin code change', () => {
        const selected = selectJobs({ ...nothing, code: 'true', integration_scope: 'affected' }, 'pull_request');
        for (const job of [
            'commits',
            'lint',
            'typecheck',
            'test',
            'docs',
            'build',
            'external-consumer',
            'integration',
        ]) {
            assert.equal(selected[job], true, job);
        }
        assert.equal(selected.generator, false);
        assert.equal(selected['extension-tests'], false);
    });

    it('skips the expensive suites for a release merge but still builds it', () => {
        const selected = selectJobs(
            { ...nothing, code: 'true', skip_expensive_checks: 'true', generator: 'true', integration_scope: 'all' },
            'push',
        );
        assert.equal(selected.build, true);
        assert.equal(selected.lint, true);
        for (const job of ['test', 'external-consumer', 'integration', 'generator', 'engine-comparison']) {
            assert.equal(selected[job], false, job);
        }
    });

    it('runs only docs and config for a docs-only push, and nothing for a docs-only pull request', () => {
        assert.deepEqual(
            Object.entries(selectJobs(nothing, 'push'))
                .filter(([, selected]) => selected)
                .map(([job]) => job),
            ['docs'],
        );
        assert.equal(Object.values(selectJobs(nothing, 'pull_request')).some(Boolean), false);
    });

    it('runs nothing for a label configuration change', () => {
        assert.equal(Object.values(selectJobs({ ...nothing, config_only: 'true' }, 'push')).some(Boolean), false);
    });

    it('tests and checks a shared action helper change without building plugins', () => {
        const selected = selectJobs({ ...nothing, actions_to_test: '["common"]' }, 'pull_request');
        assert.equal(selected.test, true);
        assert.equal(selected.lint, true);
        assert.equal(selected.docs, true);
        assert.equal(selected.commits, true);
        assert.equal(selected.build, false);
    });

    it('checks docs and commits for version-only action and extension changes', () => {
        for (const outputs of [
            { ...nothing, actions: '["sign-pumpkin-plugin"]' },
            { ...nothing, extensions: '["minecraft-terms"]', extensions_to_test: '["minecraft-terms"]' },
        ]) {
            const selected = selectJobs(outputs, 'pull_request');
            assert.equal(selected.docs, true);
            assert.equal(selected.commits, true);
            assert.equal(selected.test, false);
        }
    });

    it('compares engines for benchmark changes and for every code push to the default branch', () => {
        const code = { ...nothing, code: 'true' };
        assert.equal(selectJobs(code, 'pull_request')['engine-comparison'], false);
        assert.equal(selectJobs({ ...code, benchmark: 'true' }, 'pull_request')['engine-comparison'], true);
        assert.equal(selectJobs(code, 'push')['engine-comparison'], true);
    });

    it('checks commits only on pull requests', () => {
        assert.equal(selectJobs({ ...nothing, code: 'true' }, 'push').commits, false);
        assert.equal(selectJobs({ ...nothing, generated_readmes: 'true' }, 'pull_request').commits, true);
    });
});

describe('checkResults', () => {
    const code = { ...nothing, code: 'true', integration_scope: 'affected' };

    it('passes when every selected job succeeds and the rest are skipped', () => {
        assert.deepEqual(checkResults(needs(code, 'push', {})), []);
        assert.deepEqual(checkResults(needs(nothing, 'pull_request', {})), []);
    });

    it('fails when a selected job fails, is cancelled or is skipped', () => {
        for (const result of ['failure', 'cancelled', 'skipped']) {
            const problems = checkResults(needs(code, 'push', { integration: result }));
            assert.equal(problems.length, 1, result);
            assert.match(problems[0], /integration/);
        }
    });

    it('fails when a job fails even though the change did not need it', () => {
        assert.equal(checkResults(needs(nothing, 'push', { generator: 'failure' })).length, 1);
    });

    it('fails when change classification did not succeed', () => {
        const context = needs(code, 'push', {});
        context.changes = { result: 'failure', outputs: {} };
        assert.equal(checkResults(context).length, 1);
    });

    it('fails for a job that has no selection rule', () => {
        const context = { ...needs(code, 'push', {}), 'new-job': { result: 'success' } };
        assert.match(checkResults(context).join('\n'), /new-job/);
    });
});
