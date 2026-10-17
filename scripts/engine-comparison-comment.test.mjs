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

it('publishes light and dark SVGs to the retained chart branch', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'engine-comparison-chart-'));
    try {
        const lightPath = join(directory, 'changes-light.svg');
        const darkPath = join(directory, 'changes-dark.svg');
        const lightSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>light</text></svg>';
        const darkSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>dark</text></svg>';
        writeFileSync(lightPath, lightSvg);
        writeFileSync(darkPath, darkSvg);
        const requests = [];
        const outputs = [];
        const chartUrls = {
            light: 'https://raw.githubusercontent.com/example/project/benchmark-charts/engine-comparison/456-light.svg',
            dark: 'https://raw.githubusercontent.com/example/project/benchmark-charts/engine-comparison/456-dark.svg',
        };

        const result = await uploadBenchmarkChart(
            {
                apiUrl: 'https://api.github.com',
                chartPaths: { light: lightPath, dark: darkPath },
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
                    const chartPath = requestUrl.pathname.match(
                        /\/contents\/(engine-comparison\/456-(light|dark)\.svg)$/,
                    )?.[1];
                    if (chartPath) {
                        if (options.method !== 'PUT') return jsonResponse({ message: 'Not Found' }, 404);
                        const theme = chartPath.endsWith('-light.svg') ? 'light' : 'dark';
                        return jsonResponse({ content: { download_url: chartUrls[theme], path: chartPath } }, 201);
                    }
                    assert.fail(`Unexpected GitHub API request: ${requestUrl.pathname}`);
                },
                writeOutput: (name, value) => outputs.push([name, value]),
            },
        );

        assert.deepEqual(result, chartUrls);
        assert.deepEqual(outputs, [
            ['light_chart_url', chartUrls.light],
            ['dark_chart_url', chartUrls.dark],
        ]);
        assert.deepEqual(
            requests.map(({ options }) => options.method ?? 'GET'),
            ['GET', 'GET', 'POST', 'GET', 'PUT', 'GET', 'PUT'],
        );
        assert.ok(requests.every(({ options }) => options.headers.Authorization === 'Bearer app-token'));

        const createBranch = requests[2];
        assert.equal(createBranch.options.headers['Content-Type'], 'application/json');
        assert.deepEqual(JSON.parse(createBranch.options.body), {
            ref: 'refs/heads/benchmark-charts',
            sha: 'mainsha',
        });

        const lightUpload = requests[4];
        assert.equal(new URL(requests[3].url).searchParams.get('ref'), 'benchmark-charts');
        assert.deepEqual(JSON.parse(lightUpload.options.body), {
            message: 'ci(benchmarks): publish light chart for run 456',
            content: Buffer.from(lightSvg).toString('base64'),
            branch: 'benchmark-charts',
        });
        assert.deepEqual(JSON.parse(requests[6].options.body), {
            message: 'ci(benchmarks): publish dark chart for run 456',
            content: Buffer.from(darkSvg).toString('base64'),
            branch: 'benchmark-charts',
        });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

it('updates both chart files when GitHub reruns a workflow', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'engine-comparison-chart-existing-'));
    try {
        const lightPath = join(directory, 'changes-light.svg');
        const darkPath = join(directory, 'changes-dark.svg');
        const lightSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>light</text></svg>';
        const darkSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>dark</text></svg>';
        writeFileSync(lightPath, lightSvg);
        writeFileSync(darkPath, darkSvg);
        const requests = [];
        const chartUrls = {
            light: 'https://raw.githubusercontent.com/example/project/benchmark-charts/engine-comparison/789-light.svg',
            dark: 'https://raw.githubusercontent.com/example/project/benchmark-charts/engine-comparison/789-dark.svg',
        };

        const result = await uploadBenchmarkChart(
            {
                apiUrl: 'https://api.github.com',
                chartPaths: { light: lightPath, dark: darkPath },
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
                    const chartPath = requestUrl.pathname.match(
                        /\/contents\/(engine-comparison\/789-(light|dark)\.svg)$/,
                    )?.[1];
                    if (chartPath) {
                        const theme = chartPath.endsWith('-light.svg') ? 'light' : 'dark';
                        if (options.method !== 'PUT') {
                            return jsonResponse({
                                _links: {
                                    git: 'https://api.github.com/repos/example/project/git/blobs/oldsha',
                                    html: `https://github.com/example/project/blob/benchmark-charts/${chartPath}`,
                                    self: `https://api.github.com/repos/example/project/contents/${chartPath}`,
                                },
                                download_url: chartUrls[theme],
                                encoding: 'base64',
                                name: chartPath.split('/').at(-1),
                                path: chartPath,
                                sha: `${theme}-oldsha`,
                                size: 34,
                                type: 'file',
                                url: `https://api.github.com/repos/example/project/contents/${chartPath}`,
                            });
                        }
                        return jsonResponse({ content: { download_url: chartUrls[theme], path: chartPath } }, 201);
                    }
                    assert.fail(`Unexpected GitHub API request: ${requestUrl.pathname}`);
                },
                writeOutput: () => {},
            },
        );

        assert.deepEqual(result, chartUrls);
        assert.deepEqual(
            requests.map(({ options }) => options.method ?? 'GET'),
            ['GET', 'GET', 'PUT', 'GET', 'PUT'],
        );
        assert.deepEqual(JSON.parse(requests[2].options.body), {
            message: 'ci(benchmarks): publish light chart for run 789',
            content: Buffer.from(lightSvg).toString('base64'),
            branch: 'benchmark-charts',
            sha: 'light-oldsha',
        });
        assert.deepEqual(JSON.parse(requests[4].options.body), {
            message: 'ci(benchmarks): publish dark chart for run 789',
            content: Buffer.from(darkSvg).toString('base64'),
            branch: 'benchmark-charts',
            sha: 'dark-oldsha',
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
