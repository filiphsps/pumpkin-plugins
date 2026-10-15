import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { uploadBenchmarkChart } from './engine-comparison-chart.mjs';
import { discoverBenchmarkArtifacts } from './engine-comparison-comment.mjs';

it('uses the GitHub App token for artifact access and PR comments', () => {
    const workflow = readFileSync(
        new URL('../.github/workflows/engine-comparison-comment.yml', import.meta.url),
        'utf8',
    );

    assert.match(workflow, /uses: actions\/create-github-app-token@v3\.2\.0/);
    assert.match(workflow, /permission-contents: write/);
    assert.match(workflow, /GITHUB_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
    assert.match(workflow, /GH_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
    assert.equal((workflow.match(/github-token: \$\{\{ steps\.app-token\.outputs\.token \}\}/g) ?? []).length, 2);
    assert.match(workflow, /node scripts\/engine-comparison-comment\.mjs discover/);
    assert.match(workflow, /node scripts\/engine-comparison-chart\.mjs publish/);
    assert.match(workflow, /GITHUB_API_URL: \$\{\{ github\.api_url \}\}/);
    assert.match(workflow, /DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/);
    assert.match(workflow, /SOURCE_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/);
    assert.match(workflow, /BENCHMARK_CHANGE_SVG_URL: \$\{\{ steps\.publish-chart\.outputs\.chart_url \}\}/);
    assert.ok(
        workflow.indexOf('name: 🕶️ Checkout trusted default-branch scripts') <
            workflow.indexOf('run: node scripts/engine-comparison-comment.mjs discover'),
    );
    assert.doesNotMatch(workflow, /secrets\.GITHUB_TOKEN/);
});

it('finds the current report and newest default-branch baseline before the PR base', async () => {
    const outputs = [];
    const requests = [];
    const responses = new Map([
        [
            '/repos/example/project/actions/runs/100/artifacts?per_page=100',
            { artifacts: [{ name: 'engine-comparison-report', id: 900, expired: false }] },
        ],
        [
            '/repos/example/project/actions/workflows/ci.yml/runs?branch=master&event=push&status=success&per_page=100',
            {
                workflow_runs: [
                    { id: 80, head_sha: 'recent' },
                    { id: 70, head_sha: 'ancestor' },
                ],
            },
        ],
        ['/repos/example/project/compare/recent...base', { status: 'diverged' }],
        ['/repos/example/project/compare/ancestor...base', { status: 'ahead' }],
        [
            '/repos/example/project/actions/runs/70/artifacts?per_page=100',
            { artifacts: [{ name: 'engine-comparison-report', id: 700, expired: false }] },
        ],
    ]);

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
            fetchImpl: async (url, options) => {
                requests.push({ url: String(url), options });
                const pathname = new URL(url).pathname + new URL(url).search;
                assert.ok(responses.has(pathname), `Unexpected API request: ${pathname}`);
                return jsonResponse(responses.get(pathname));
            },
            writeOutput: (name, value) => outputs.push([name, value]),
        },
    );

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

it('finds an eligible baseline on the next workflow-runs page', async () => {
    const outputs = [];
    const requests = [];
    const responses = new Map([
        [
            '/repos/example/project/actions/runs/100/artifacts?per_page=100',
            jsonResponse({ artifacts: [{ name: 'engine-comparison-report', id: 900, expired: false }] }),
        ],
        [
            '/repos/example/project/actions/workflows/ci.yml/runs?branch=master&event=push&status=success&per_page=100',
            jsonResponse({ workflow_runs: [{ id: 80, head_sha: 'diverged' }] }, 200, {
                Link: '<https://api.github.com/repos/example/project/actions/workflows/ci.yml/runs?branch=master&event=push&status=success&per_page=100&page=2>; rel="next"',
            }),
        ],
        [
            '/repos/example/project/actions/workflows/ci.yml/runs?branch=master&event=push&status=success&per_page=100&page=2',
            jsonResponse({ workflow_runs: [{ id: 70, head_sha: 'ancestor' }] }),
        ],
        ['/repos/example/project/compare/diverged...base', jsonResponse({ status: 'diverged' })],
        ['/repos/example/project/compare/ancestor...base', jsonResponse({ status: 'ahead' })],
        [
            '/repos/example/project/actions/runs/70/artifacts?per_page=100',
            jsonResponse({ artifacts: [{ name: 'engine-comparison-report', id: 700, expired: false }] }),
        ],
    ]);

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
            fetchImpl: async (url, options) => {
                requests.push({ url: String(url), options });
                const pathname = new URL(url).pathname + new URL(url).search;
                assert.ok(responses.has(pathname), `Unexpected API request: ${pathname}`);
                return responses.get(pathname);
            },
            writeOutput: (name, value) => outputs.push([name, value]),
        },
    );

    assert.equal(result.baselineRunId, '70');
    assert.equal(result.baselineSha, 'ancestor');
    assert.ok(
        requests.some(({ url }) =>
            url.endsWith('/actions/workflows/ci.yml/runs?branch=master&event=push&status=success&per_page=100&page=2'),
        ),
    );
    assert.deepEqual(outputs, [
        ['has_report', 'true'],
        ['pr_base_sha', 'base'],
        ['baseline_run_id', '70'],
        ['baseline_sha', 'ancestor'],
    ]);
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

it('publishes the SVG to a retained chart branch and exposes its raw URL', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'engine-comparison-chart-'));
    try {
        const chartPath = join(directory, 'changes.svg');
        const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>chart</text></svg>';
        writeFileSync(chartPath, svg);
        const requests = [];
        const outputs = [];
        const chartUrl = 'https://raw.githubusercontent.com/example/project/benchmark-charts/engine-comparison/456.svg';

        const result = await uploadBenchmarkChart(
            {
                apiUrl: 'https://api.github.com',
                chartPath,
                defaultBranch: 'main',
                repository: 'example/project',
                serverUrl: 'https://github.com',
                sourceRunId: '456',
                token: 'app-token',
            },
            {
                fetchImpl: async (url, options) => {
                    requests.push({ url: String(url), options });
                    const requestUrl = new URL(url);
                    if (requestUrl.pathname === '/repos/example/project/git/ref/heads/benchmark-charts') {
                        return jsonResponse({ message: 'Not Found' }, 404);
                    }
                    if (requestUrl.pathname === '/repos/example/project/git/ref/heads/main') {
                        return jsonResponse({ object: { sha: 'mainsha' } });
                    }
                    if (requestUrl.pathname === '/repos/example/project/git/refs') {
                        return jsonResponse({ ref: 'refs/heads/benchmark-charts' }, 201);
                    }
                    if (requestUrl.pathname === '/repos/example/project/contents/engine-comparison/456.svg') {
                        if (options.method !== 'PUT') return jsonResponse({ message: 'Not Found' }, 404);
                        return jsonResponse(
                            {
                                content: {
                                    download_url: chartUrl,
                                    path: 'engine-comparison/456.svg',
                                },
                            },
                            201,
                        );
                    }
                    assert.fail(`Unexpected GitHub API request: ${requestUrl.pathname}`);
                },
                writeOutput: (name, value) => outputs.push([name, value]),
            },
        );

        assert.equal(result, chartUrl);
        assert.deepEqual(outputs, [['chart_url', chartUrl]]);
        assert.deepEqual(
            requests.map(({ options }) => options.method ?? 'GET'),
            ['GET', 'GET', 'POST', 'GET', 'PUT'],
        );
        assert.ok(requests.every(({ options }) => options.headers.Authorization === 'Bearer app-token'));

        const createBranch = requests[2];
        assert.equal(createBranch.options.headers['Content-Type'], 'application/json');
        assert.deepEqual(JSON.parse(createBranch.options.body), {
            ref: 'refs/heads/benchmark-charts',
            sha: 'mainsha',
        });

        assert.equal(new URL(requests[3].url).searchParams.get('ref'), 'benchmark-charts');

        const publishChart = requests[4];
        assert.equal(publishChart.options.headers.Accept, 'application/vnd.github+json');
        assert.deepEqual(JSON.parse(publishChart.options.body), {
            message: 'ci(benchmarks): publish chart for run 456',
            content: Buffer.from(svg).toString('base64'),
            branch: 'benchmark-charts',
        });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

it('updates the chart file when GitHub reruns a workflow', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'engine-comparison-chart-existing-'));
    try {
        const chartPath = join(directory, 'changes.svg');
        writeFileSync(chartPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
        const requests = [];
        const chartUrl = 'https://raw.githubusercontent.com/example/project/benchmark-charts/engine-comparison/789.svg';

        const result = await uploadBenchmarkChart(
            {
                apiUrl: 'https://api.github.com',
                chartPath,
                defaultBranch: 'main',
                repository: 'example/project',
                serverUrl: 'https://github.com',
                sourceRunId: '789',
                token: 'app-token',
            },
            {
                fetchImpl: async (url, options) => {
                    requests.push({ url: String(url), options });
                    const requestUrl = new URL(url);
                    if (requestUrl.pathname === '/repos/example/project/git/ref/heads/benchmark-charts') {
                        return jsonResponse({ ref: 'refs/heads/benchmark-charts' });
                    }
                    if (requestUrl.pathname === '/repos/example/project/contents/engine-comparison/789.svg') {
                        if (options.method !== 'PUT') {
                            return jsonResponse({
                                _links: {
                                    git: 'https://api.github.com/repos/example/project/git/blobs/oldsha',
                                    html: 'https://github.com/example/project/blob/benchmark-charts/engine-comparison/789.svg',
                                    self: 'https://api.github.com/repos/example/project/contents/engine-comparison/789.svg',
                                },
                                download_url: chartUrl,
                                encoding: 'base64',
                                name: '789.svg',
                                path: 'engine-comparison/789.svg',
                                sha: 'oldsha',
                                size: 34,
                                type: 'file',
                                url: 'https://api.github.com/repos/example/project/contents/engine-comparison/789.svg',
                            });
                        }
                        return jsonResponse(
                            { content: { download_url: chartUrl, path: 'engine-comparison/789.svg' } },
                            201,
                        );
                    }
                    assert.fail(`Unexpected GitHub API request: ${requestUrl.pathname}`);
                },
                writeOutput: () => {},
            },
        );

        assert.equal(result, chartUrl);
        assert.deepEqual(
            requests.map(({ options }) => options.method ?? 'GET'),
            ['GET', 'GET', 'PUT'],
        );
        assert.deepEqual(JSON.parse(requests[2].options.body), {
            message: 'ci(benchmarks): publish chart for run 789',
            content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64'),
            branch: 'benchmark-charts',
            sha: 'oldsha',
        });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

function jsonResponse(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json', ...headers },
        status,
    });
}
