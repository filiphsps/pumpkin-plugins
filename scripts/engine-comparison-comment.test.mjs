import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { discoverBenchmarkArtifacts } from './engine-comparison-comment.mjs';

it('uses the GitHub App token for artifact access and PR comments', () => {
    const workflow = readFileSync(
        new URL('../.github/workflows/engine-comparison-comment.yml', import.meta.url),
        'utf8',
    );

    assert.match(workflow, /uses: actions\/create-github-app-token@[0-9a-f]{40} # v3\.2\.0/);
    assert.match(workflow, /permission-contents: write/);
    assert.match(workflow, /GITHUB_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
    assert.match(workflow, /GH_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
    assert.equal((workflow.match(/github-token: \$\{\{ steps\.app-token\.outputs\.token \}\}/g) ?? []).length, 2);
    assert.match(workflow, /node scripts\/engine-comparison-comment\.mjs discover/);
    assert.match(workflow, /node scripts\/engine-comparison-chart\.mjs publish/);
    assert.match(workflow, /GITHUB_API_URL: \$\{\{ github\.api_url \}\}/);
    assert.match(workflow, /DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/);
    assert.match(workflow, /SOURCE_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/);
    assert.match(
        workflow,
        /BENCHMARK_CHANGE_SVG_LIGHT_URL: \$\{\{ steps\.publish-chart\.outputs\.light_chart_url \}\}/,
    );
    assert.match(workflow, /BENCHMARK_CHANGE_SVG_DARK_URL: \$\{\{ steps\.publish-chart\.outputs\.dark_chart_url \}\}/);
    assert.ok(
        workflow.indexOf('name: 🕶️ Checkout trusted default-branch scripts') <
            workflow.indexOf('run: node scripts/engine-comparison-comment.mjs discover'),
    );
    assert.doesNotMatch(workflow, /secrets\.GITHUB_TOKEN/);
});

const discoverInput = {
    apiUrl: 'https://api.github.com',
    defaultBranch: 'master',
    pullRequestBaseSha: 'base',
    pullRequestNumber: '42',
    repository: 'example/project',
    sourceRunId: '100',
    token: 'app-token',
};
const reportArtifactsPath = '/repos/example/project/actions/artifacts?name=engine-comparison-report&per_page=100';
const sourceArtifactsResponse = {
    artifacts: [{ name: 'engine-comparison-report', id: 900, expired: false }],
};

function reportArtifact(id, runId, headSha, { branch = 'master', expired = false, headRepositoryId = 1 } = {}) {
    return {
        id,
        name: 'engine-comparison-report',
        expired,
        workflow_run: {
            id: runId,
            head_branch: branch,
            head_sha: headSha,
            head_repository_id: headRepositoryId,
            repository_id: 1,
        },
    };
}

/** Serves the given API paths and fails the test on any request it does not expect. */
function fakeGitHub(responses, requests = []) {
    return async (url, options) => {
        requests.push({ url: String(url), options });
        const pathname = new URL(url).pathname + new URL(url).search;
        assert.ok(responses.has(pathname), `Unexpected API request: ${pathname}`);
        const response = responses.get(pathname);
        return response instanceof Response ? response : jsonResponse(response);
    };
}

it('finds the current report and newest default-branch baseline before the PR base', async () => {
    const outputs = [];
    const requests = [];
    const responses = new Map([
        ['/repos/example/project/actions/runs/100/artifacts?per_page=100', sourceArtifactsResponse],
        [
            reportArtifactsPath,
            {
                artifacts: [
                    reportArtifact(901, 100, 'pr-head', { branch: 'feature' }),
                    reportArtifact(800, 80, 'recent'),
                    reportArtifact(750, 75, 'expired', { expired: true }),
                    reportArtifact(740, 74, 'fork', { headRepositoryId: 2 }),
                    reportArtifact(700, 70, 'ancestor'),
                ],
            },
        ],
        ['/repos/example/project/compare/recent...base', { status: 'diverged' }],
        ['/repos/example/project/compare/ancestor...base', { status: 'ahead' }],
        ['/repos/example/project/actions/runs/70', { event: 'push', conclusion: 'success' }],
    ]);

    const result = await discoverBenchmarkArtifacts(discoverInput, {
        fetchImpl: fakeGitHub(responses, requests),
        writeOutput: (name, value) => outputs.push([name, value]),
    });

    assert.deepEqual(result, {
        hasReport: true,
        baselineRunId: '70',
        baselineSha: 'ancestor',
        prBaseSha: 'base',
        sourceArtifactId: '900',
    });
    assert.deepEqual(outputs, [
        ['has_report', 'true'],
        ['pr_base_sha', 'base'],
        ['baseline_run_id', '70'],
        ['baseline_sha', 'ancestor'],
    ]);
    assert.ok(requests.every(({ options }) => options.headers.Authorization === 'Bearer app-token'));
});

it('skips a matching baseline from a failed or non-push run', async () => {
    const responses = new Map([
        ['/repos/example/project/actions/runs/100/artifacts?per_page=100', sourceArtifactsResponse],
        [
            reportArtifactsPath,
            {
                artifacts: [
                    reportArtifact(900, 90, 'failed'),
                    reportArtifact(850, 85, 'dispatched'),
                    reportArtifact(800, 80, 'ancestor'),
                    reportArtifact(799, 80, 'ancestor'),
                ],
            },
        ],
        ['/repos/example/project/compare/failed...base', { status: 'identical' }],
        ['/repos/example/project/compare/dispatched...base', { status: 'ahead' }],
        ['/repos/example/project/compare/ancestor...base', { status: 'ahead' }],
        ['/repos/example/project/actions/runs/90', { event: 'push', conclusion: 'failure' }],
        ['/repos/example/project/actions/runs/85', { event: 'workflow_dispatch', conclusion: 'success' }],
        ['/repos/example/project/actions/runs/80', { event: 'push', conclusion: 'success' }],
    ]);

    const result = await discoverBenchmarkArtifacts(discoverInput, {
        fetchImpl: fakeGitHub(responses),
        writeOutput: () => {},
    });

    assert.equal(result.baselineRunId, '80');
    assert.equal(result.baselineSha, 'ancestor');
});

it('finds an eligible baseline on the next report-artifact page', async () => {
    const requests = [];
    const responses = new Map([
        ['/repos/example/project/actions/runs/100/artifacts?per_page=100', sourceArtifactsResponse],
        [
            reportArtifactsPath,
            jsonResponse({ artifacts: [reportArtifact(800, 80, 'diverged')] }, 200, {
                Link: `<https://api.github.com${reportArtifactsPath}&page=2>; rel="next"`,
            }),
        ],
        [`${reportArtifactsPath}&page=2`, { artifacts: [reportArtifact(700, 70, 'ancestor')] }],
        ['/repos/example/project/compare/diverged...base', { status: 'diverged' }],
        ['/repos/example/project/compare/ancestor...base', { status: 'ahead' }],
        ['/repos/example/project/actions/runs/70', { event: 'push', conclusion: 'success' }],
    ]);

    const result = await discoverBenchmarkArtifacts(discoverInput, {
        fetchImpl: fakeGitHub(responses, requests),
        writeOutput: () => {},
    });

    assert.equal(result.baselineRunId, '70');
    assert.equal(result.baselineSha, 'ancestor');
});

it('stops looking for a baseline after a bounded number of report-artifact pages', async () => {
    const requests = [];
    const pageUrl = (page) => `${reportArtifactsPath}&page=${page}`;
    const responses = new Map([
        ['/repos/example/project/actions/runs/100/artifacts?per_page=100', sourceArtifactsResponse],
        ['/repos/example/project/compare/diverged...base', { status: 'diverged' }],
    ]);
    for (let page = 1; page <= 50; page++) {
        responses.set(
            page === 1 ? reportArtifactsPath : pageUrl(page),
            jsonResponse({ artifacts: [reportArtifact(page, page, 'diverged')] }, 200, {
                Link: `<https://api.github.com${pageUrl(page + 1)}>; rel="next"`,
            }),
        );
    }

    const result = await discoverBenchmarkArtifacts(discoverInput, {
        fetchImpl: fakeGitHub(responses, requests),
        writeOutput: () => {},
    });

    assert.equal(result.baselineRunId, '');
    const listedPages = requests.filter(({ url }) => url.includes('/actions/artifacts?')).length;
    assert.ok(listedPages > 1 && listedPages < 50, `listed ${listedPages} pages`);
    assert.equal(requests.filter(({ url }) => url.includes('/compare/')).length, 1);
});

it('skips runs without an unexpired benchmark report artifact', async () => {
    const outputs = [];
    const result = await discoverBenchmarkArtifacts(
        {
            apiUrl: 'https://api.github.com',
            defaultBranch: 'master',
            pullRequestBaseSha: 'base',
            pullRequestNumber: '42',
            repository: 'example/project',
            sourceRunId: '100',
            token: 'app-token',
        },
        {
            fetchImpl: async () =>
                jsonResponse({ artifacts: [{ name: 'engine-comparison-report', id: 900, expired: true }] }),
            writeOutput: (name, value) => outputs.push([name, value]),
        },
    );

    assert.deepEqual(result, { hasReport: false });
    assert.deepEqual(outputs, [['has_report', 'false']]);
});

function jsonResponse(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json', ...headers },
        status,
    });
}
