import assert from 'node:assert/strict';
import { it } from 'node:test';
import { discoverBenchmarkArtifacts } from './discover-benchmark-artifacts.mjs';

const input = { repository: 'example/repo', sourceRunId: '123', prNumber: '7', baseSha: 'base', defaultBranch: 'main' };
const report = { name: 'engine-comparison-report', expired: false };
const runEndpoint =
    'repos/example/repo/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=100';

function apiFixture(responses) {
    return (endpoint) => {
        assert.ok(Object.hasOwn(responses, endpoint), `Unexpected API call: ${endpoint}`);
        return responses[endpoint];
    };
}

it('skips commenting when the source run has no unexpired benchmark report', () => {
    for (const artifacts of [[], [{ ...report, expired: true }], [{ name: 'other-report', expired: false }]]) {
        assert.deepEqual(
            discoverBenchmarkArtifacts(
                input,
                apiFixture({ 'repos/example/repo/actions/runs/123/artifacts': { artifacts } }),
            ),
            { has_report: false },
        );
    }
});

it('selects the newest ancestor with a retained report, skipping divergent and expired runs', () => {
    const result = discoverBenchmarkArtifacts(
        input,
        apiFixture({
            'repos/example/repo/actions/runs/123/artifacts': { artifacts: [report] },
            [runEndpoint]: {
                workflow_runs: [
                    { id: 4, head_sha: 'divergent' },
                    { id: 3, head_sha: 'expired' },
                    { id: 2, head_sha: 'ancestor' },
                    { id: 1, head_sha: 'older' },
                ],
            },
            'repos/example/repo/compare/divergent...base': { status: 'diverged' },
            'repos/example/repo/compare/expired...base': { status: 'ahead' },
            'repos/example/repo/actions/runs/3/artifacts': { artifacts: [{ ...report, expired: true }] },
            'repos/example/repo/compare/ancestor...base': { status: 'ahead' },
            'repos/example/repo/actions/runs/2/artifacts': { artifacts: [report] },
        }),
    );
    assert.deepEqual(result, { has_report: true, pr_base_sha: 'base', baseline_run_id: 2, baseline_sha: 'ancestor' });
});

it('resolves a missing PR base and accepts an identical baseline', () => {
    const result = discoverBenchmarkArtifacts(
        { ...input, baseSha: '' },
        apiFixture({
            'repos/example/repo/actions/runs/123/artifacts': { artifacts: [report] },
            'repos/example/repo/pulls/7': { base: { sha: 'resolved' } },
            [runEndpoint]: { workflow_runs: [{ id: 2, head_sha: 'resolved' }] },
            'repos/example/repo/compare/resolved...resolved': { status: 'identical' },
            'repos/example/repo/actions/runs/2/artifacts': { artifacts: [report] },
        }),
    );
    assert.deepEqual(result, {
        has_report: true,
        pr_base_sha: 'resolved',
        baseline_run_id: 2,
        baseline_sha: 'resolved',
    });
});

it('reports a missing baseline without suppressing the current report', () => {
    const result = discoverBenchmarkArtifacts(
        input,
        apiFixture({
            'repos/example/repo/actions/runs/123/artifacts': { artifacts: [report] },
            [runEndpoint]: { workflow_runs: [{ id: 2, head_sha: 'newer' }] },
            'repos/example/repo/compare/newer...base': { status: 'behind' },
        }),
    );
    assert.deepEqual(result, { has_report: true, pr_base_sha: 'base', baseline_run_id: '', baseline_sha: '' });
});

it('propagates discovery failures so no comment is posted with unavailable data', () => {
    assert.throws(
        () =>
            discoverBenchmarkArtifacts(input, () => {
                throw new Error('API unavailable');
            }),
        /API unavailable/,
    );
});
